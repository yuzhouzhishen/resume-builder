# Resume Builder V2.7 Cross-Platform Launcher Design

Date: 2026-07-12

Status: Implemented.

## Goal

Start the local Resume Builder and open its browser UI by double-clicking on macOS or Windows, without duplicating startup logic between operating systems.

## Architecture

Place all behavior in a dependency-light Node entry point, `scripts/launch-editor.mjs`. The OS files are thin wrappers that locate their own project directory and call the same Node launcher:

- `Start Resume Builder.command` for macOS.
- `Start Resume Builder.cmd` for Windows.
- `npm run editor:open` for any supported terminal.

Node.js 20.12 or newer is the only prerequisite that is not installed automatically. The README documents installing Node before cloning or starting the project.

## Startup Flow

1. Validate the Node version.
2. Read `package.json` and check installed direct dependencies.
3. Run `npm install` only when dependencies are missing.
4. Check the Playwright Chromium executable and run `npx playwright install chromium` only when it is missing.
5. Resolve and prepare the external Resume Builder data directory through the existing path modules.
6. Scan `127.0.0.1:4321-4330` for an existing server using `/api/health`.
7. If a matching server exists, open its URL and exit without starting another process.
8. Otherwise start the editor with the existing port fallback, open the selected URL, and keep the launcher process alive with the server.

Browser opening is platform-specific inside the Node launcher: `open` on macOS, `cmd.exe /c start` on Windows and `xdg-open` on Linux.

## Instance Identity And Privacy

`/api/health` returns only:

```json
{
  "ok": true,
  "app": "resume-builder",
  "protocolVersion": 1,
  "instanceId": "opaque-hash"
}
```

The instance ID is a truncated SHA-256 digest of the canonical data-root path. It allows different code clones using the same data directory to find the same process without exposing project paths, data paths, resume IDs or personal content. The endpoint remains bound to localhost.

## Runtime Dependencies

- Missing npm packages and Chromium are installed automatically with visible progress.
- Missing `pdfinfo` or `pdftoppm` does not block content editing. The launcher prints a warning that PDF/PNG generation needs Poppler and points to the README.
- The launcher never downloads Node, modifies the external data directory beyond the existing initialization flow, or invokes a platform package manager.

## Process Lifecycle

The double-click wrapper keeps a terminal window open while the server runs. `Ctrl+C`, `SIGTERM` or closing the terminal stops the server. Startup errors remain visible and the wrappers pause before closing when appropriate.

## Non-Goals

- Packaging Electron, Tauri, `.app`, `.exe` or an installer.
- Running as a hidden background service or at operating-system login.
- Automatic application updates.
- Eliminating the current Poppler generation dependency.

## Acceptance

- macOS and Windows wrappers contain no duplicated server logic or absolute paths.
- An existing matching server is reopened rather than duplicated.
- A different service occupying port 4321 is ignored and normal fallback still works.
- Browser commands are correct for macOS, Windows and Linux.
- Health responses contain no absolute paths or personal data.
- Existing `npm run editor` behavior remains unchanged.
