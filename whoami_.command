#!/bin/zsh

set -u

if [[ -z "${RESUME_BUILDER_LOGIN_SHELL:-}" ]]; then
  export RESUME_BUILDER_LOGIN_SHELL=1
  exec /bin/zsh -l "$0" "$@"
fi

project_dir="${0:A:h}"
launcher_path="${0:A}"
cd -- "$project_dir" || exit 1

if [[ -x /usr/bin/osascript ]]; then
  /usr/bin/osascript -l JavaScript \
    scripts/set-macos-file-icon.js \
    "$launcher_path" \
    "$project_dir/editor/favicon.svg" >/dev/null 2>&1 || true
fi

"$project_dir/bootstrap.sh"
status=$?
if [[ $status -ne 0 ]]; then
  printf "Press Enter to close..."
  read -r
fi
exit $status
