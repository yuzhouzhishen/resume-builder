#!/bin/zsh

set -u

if [[ -z "${RESUME_BUILDER_LOGIN_SHELL:-}" ]]; then
  export RESUME_BUILDER_LOGIN_SHELL=1
  exec /bin/zsh -l "$0" "$@"
fi

cd -- "${0:A:h}" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20.12 or newer is required. Install Node.js, then double-click this file again."
  printf "Press Enter to close..."
  read -r
  exit 1
fi

node scripts/launch-editor.mjs
status=$?
if [[ $status -ne 0 ]]; then
  printf "Press Enter to close..."
  read -r
fi
exit $status
