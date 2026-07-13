#!/bin/sh

set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
manifest_path="$project_dir/scripts/runtime-manifest.env"
check_only=0

if [ "${1:-}" = "--check" ]; then
  check_only=1
elif [ "$#" -gt 0 ]; then
  echo "Unknown bootstrap option: $1" >&2
  exit 2
fi

if [ ! -f "$manifest_path" ]; then
  echo "Runtime manifest is missing: $manifest_path" >&2
  exit 1
fi

# The manifest is committed with the project and contains only KEY=value entries.
# shellcheck disable=SC1090
. "$manifest_path"

fail() {
  echo "whoami_ could not start: $*" >&2
  exit 1
}

case "${NODE_BASE_URL:-}" in
  https://nodejs.org/dist) ;;
  *) fail "The Node.js download source is not the expected official URL." ;;
esac

platform_name=$(uname -s 2>/dev/null || true)
case "$platform_name" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) fail "Unsupported operating system: ${platform_name:-unknown}." ;;
esac

machine_arch=$(uname -m 2>/dev/null || true)
case "$machine_arch" in
  arm64|aarch64) architecture=arm64 ;;
  x86_64|amd64) architecture=x64 ;;
  *) fail "Unsupported CPU architecture: ${machine_arch:-unknown}." ;;
esac

case "$platform-$architecture" in
  darwin-arm64)
    archive=$NODE_DARWIN_ARM64_ARCHIVE
    expected_sha256=$NODE_DARWIN_ARM64_SHA256
    ;;
  darwin-x64)
    archive=$NODE_DARWIN_X64_ARCHIVE
    expected_sha256=$NODE_DARWIN_X64_SHA256
    ;;
  linux-arm64)
    archive=$NODE_LINUX_ARM64_ARCHIVE
    expected_sha256=$NODE_LINUX_ARM64_SHA256
    ;;
  linux-x64)
    archive=$NODE_LINUX_X64_ARCHIVE
    expected_sha256=$NODE_LINUX_X64_SHA256
    ;;
  *) fail "No Node.js runtime is configured for $platform-$architecture." ;;
esac

node_is_supported() {
  candidate=$1
  [ -x "$candidate" ] || return 1
  "$candidate" -e '
    const current = process.versions.node.split(".").map(Number);
    const minimum = process.argv[1].split(".").map(Number);
    for (let index = 0; index < 3; index += 1) {
      if (current[index] > minimum[index]) process.exit(0);
      if (current[index] < minimum[index]) process.exit(1);
    }
  ' "$NODE_MINIMUM_VERSION" >/dev/null 2>&1
}

local_node_is_ready() {
  [ -x "$local_node" ] || return 1
  [ -x "$runtime_dir/bin/npm" ] || return 1
  [ -x "$runtime_dir/bin/npx" ] || return 1
  installed_version=$($local_node -p 'process.versions.node' 2>/dev/null || true)
  [ "$installed_version" = "$NODE_VERSION" ]
}

if command -v node >/dev/null 2>&1 \
  && command -v npm >/dev/null 2>&1 \
  && command -v npx >/dev/null 2>&1 \
  && node_is_supported "$(command -v node)"; then
  node_command=$(command -v node)
  node_source="system"
else
  if [ -n "${XDG_CACHE_HOME:-}" ]; then
    cache_root="$XDG_CACHE_HOME/whoami_/runtime"
  else
    cache_root="$HOME/.cache/whoami_/runtime"
  fi
  runtime_dir="$cache_root/node-v${NODE_VERSION}-${platform}-${architecture}"
  local_node="$runtime_dir/bin/node"
  node_command=$local_node
  if local_node_is_ready; then
    node_source="local cache"
  else
    node_source="official download"
  fi
fi

if [ "$check_only" -eq 1 ]; then
  echo "Bootstrap check passed: $platform-$architecture; Node source: $node_source."
  exit 0
fi

download_file() {
  url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --retry 2 --output "$destination" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --output-document="$destination" "$url"
  else
    fail "curl or wget is required to download the local Node.js runtime."
  fi
}

file_sha256() {
  file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{ print $1 }'
  else
    fail "sha256sum or shasum is required to verify the Node.js download."
  fi
}

install_local_node() {
  mkdir -p "$cache_root"
  lock_dir="$cache_root/.node-v${NODE_VERSION}-${platform}-${architecture}.lock"
  attempts=0
  while ! mkdir "$lock_dir" 2>/dev/null; do
    if local_node_is_ready; then
      return 0
    fi
    lock_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
    if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -rf "$lock_dir"
      continue
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 120 ]; then
      fail "Another installation is still using the runtime cache. Try again shortly."
    fi
    sleep 1
  done

  echo "$$" >"$lock_dir/pid"
  temp_dir=$(mktemp -d "$cache_root/.node-install.XXXXXX")
  cleanup_install() {
    rm -rf "$temp_dir"
    rm -rf "$lock_dir"
  }
  trap cleanup_install 0 1 2 15

  if local_node_is_ready; then
    cleanup_install
    trap - 0 1 2 15
    return 0
  fi

  archive_path="$temp_dir/$archive"
  download_url="$NODE_BASE_URL/v$NODE_VERSION/$archive"
  echo "Downloading Node.js $NODE_VERSION for $platform-$architecture..."
  download_file "$download_url" "$archive_path"

  actual_sha256=$(file_sha256 "$archive_path")
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    fail "Node.js download verification failed. Expected $expected_sha256 but received $actual_sha256."
  fi

  echo "Installing the verified Node.js runtime in the user cache..."
  tar -xzf "$archive_path" -C "$temp_dir"
  extracted_dir="$temp_dir/${archive%.tar.gz}"
  [ -d "$extracted_dir" ] || fail "The Node.js archive did not contain the expected directory."
  [ ! -e "$runtime_dir" ] || fail "The target runtime directory already exists but is incomplete: $runtime_dir"
  mv "$extracted_dir" "$runtime_dir"

  local_node_is_ready || fail "The local Node.js runtime could not be verified after extraction."
  cleanup_install
  trap - 0 1 2 15
}

if [ "$node_source" = "official download" ]; then
  install_local_node
fi

if [ "$node_source" != "system" ]; then
  PATH="$runtime_dir/bin:$PATH"
  export PATH
  node_command=$local_node
fi

cd "$project_dir"
exec "$node_command" scripts/launch-editor.mjs
