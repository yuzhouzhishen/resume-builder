# V2.8 Zero-Install Bootstrap Design

Date: 2026-07-13

## Goal

After downloading and extracting the project, a non-developer can start the local editor with one platform-appropriate action. Node.js, npm dependencies and Playwright Chromium no longer require separate setup instructions.

## Architecture

The pre-Node layer is intentionally small. `bootstrap.sh` supports macOS and Linux, while `bootstrap.ps1` supports Windows. Both read `scripts/runtime-manifest.env`, detect OS and CPU architecture, prefer an already supported system Node.js, and otherwise install a pinned official Node.js archive in a user cache. The existing `scripts/launch-editor.mjs` remains the only owner of application dependency preparation, server reuse, startup and browser opening.

The project pins Node.js 24 LTS archives and official SHA-256 values for macOS arm64/x64, Linux arm64/x64 and Windows arm64/x64. Downloads are staged in a temporary directory, verified before extraction and published only after validation. Concurrent first launches serialize runtime installation; normal launches reuse the completed cache.

## Failure Handling

- Unsupported systems and architectures fail before downloading.
- An unexpected download base URL or checksum mismatch aborts installation.
- Offline startup succeeds when a supported system or cached local Node.js is available; otherwise it reports that the first download requires network access.
- Failed staging directories are cleaned, and startup errors remain visible through the existing double-click wrappers.
- Poppler remains outside this scope so its later replacement does not affect bootstrap architecture.

## Verification

Node tests validate the shared manifest, wrapper delegation, cache policy, official source and checksum requirements. `--check`/`-Check` exercise platform resolution without network access. GitHub Actions runs the bootstrap contract on Ubuntu, macOS and Windows, while real clean-machine downloads remain explicit manual acceptance checks.
