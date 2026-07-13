# Resume Builder V2.8 Current Boundaries

Date: 2026-07-13

## Bootstrap Scope

- macOS and Windows keep the existing double-click entry points; Linux uses `sh bootstrap.sh`.
- A supported system Node.js with npm and npx is reused. Otherwise the bootstrap downloads pinned Node.js 24 LTS from `https://nodejs.org/dist` into a per-user cache.
- Every downloaded Node.js archive is matched to a committed SHA-256 value before extraction.
- The bootstrap does not call Homebrew, winget, apt or another system package manager, does not require administrator access and does not replace a system Node.js installation.
- The shared Node launcher remains responsible for npm dependencies, Playwright Chromium, port selection, data-root preparation and browser opening.

## Platform Boundary

- Supported bootstrap targets are macOS arm64/x64, Linux arm64/x64 and Windows arm64/x64.
- `bootstrap.sh --check` and `bootstrap.ps1 -Check` inspect the platform and planned Node source without downloading or launching the editor.
- Bootstrap contract checks run in CI on Ubuntu, macOS and Windows. Real first-run downloads remain a release acceptance item rather than a routine CI network dependency.
- macOS/Linux runtime files use `~/.cache/whoami_/runtime` unless `XDG_CACHE_HOME` is set. Windows uses `%LOCALAPPDATA%\whoami_\runtime`.

## Existing Boundaries

- Resume YAML, photos, backups and generated output remain in the external private data directory, never in the runtime cache.
- The local server still binds only to `127.0.0.1` and reuses matching instances on ports `4321-4330`.
- Poppler is not installed by the bootstrap. Editing and saving work without it; formal PDF/PNG generation continues to report the missing dependency.
- V2.8 is not an application installer, automatic updater, background service or cloud deployment system.
