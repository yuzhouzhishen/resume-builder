# Resume Builder V2.8 Acceptance Checklist

Date: 2026-07-13

## Automated Gate

- [x] The runtime manifest pins official archives and SHA-256 hashes for six supported OS/architecture targets.
- [x] POSIX and Windows bootstraps reject unexpected download origins and do not call system package managers.
- [x] Existing macOS and Windows double-click wrappers delegate to the bootstrap layer.
- [x] Bootstrap check mode performs no download and passes on the development Mac.
- [x] CI defines lightweight bootstrap contract checks for Ubuntu, macOS and Windows.
- [x] The complete privacy and test gate includes bootstrap coverage.

## Manual First-Run Checks

- [ ] On a Windows x64 computer without Node.js, double-click `whoami_.cmd` and confirm verified local Node.js, npm dependencies and Chromium are prepared before the browser opens.
- [ ] Repeat the Windows launch and confirm the cached runtime is reused without another Node.js download.
- [ ] On a clean macOS account without a supported Node.js on `PATH`, double-click `whoami_.command` and confirm the same first-run behavior.
- [ ] Confirm startup failures remain visible and do not create a partially usable runtime directory.
- [ ] Confirm real resume data remains in the external data directory and no private data appears in the runtime cache or Git worktree.
