# Resume Builder V2.7 Current Boundaries

Date: 2026-07-12

## Release Scope

V2.7 is a stable local-use release of the one-page A4 resume editor. It combines the existing multi-resume editor, finite layout controls and private external data directory with browser-local draft recovery, session undo/redo and cross-platform launch entry points.

The recommended workflow is:

1. Double-click `whoami_.command` on macOS or `whoami_.cmd` on Windows.
2. Edit content or per-resume layout settings in the browser while viewing the live A4 draft.
3. Use preview field selection, undo/redo and local draft recovery during editing.
4. Save the current YAML explicitly, then generate the formal PDF, PNG and HTML output explicitly.
5. Export an unencrypted data package when moving to another computer or keeping an external backup.

## Editing And Preview

- The editor manages multiple independent resumes in one external data directory.
- Each resume owns its content, layout preferences, YAML backups and generated output.
- Clicking a preview field selects and scrolls to its matching form control; text controls place the caret at the end of the existing value.
- Live draft preview does not write YAML or regenerate formal output.
- Automatic layout fitting only uses bounded global font size, line height, spacing and margin candidates.
- Fixed layout mode preserves the selected values and blocks formal generation when content overflows A4.

## Recovery And History

- Unsaved drafts are stored only in the current browser and are offered after an unexpected refresh or restart.
- Undo and redo cover content edits, list operations and layout changes within the current page session.
- Saving creates per-resume YAML backups; data import and whole-data restore preserve separate pre-operation snapshots.
- Browser drafts and undo history are not included in exported data packages and do not move across computers.

## Launcher Boundary

- Node.js `20.12+` must be installed by the user on macOS and Windows.
- The shared Node launcher may install missing npm dependencies and Playwright Chromium with visible terminal output.
- The launcher reuses a matching local Resume Builder process on ports `4321-4330`; unrelated local services are ignored.
- Poppler is not installed automatically. Editing and saving remain available without it, while formal PDF/PNG generation reports the missing dependency.
- The launcher is not an application installer, background service, login item or automatic updater.

## Data And Privacy

- Real YAML files, photos, backups and generated outputs live outside the Git repository.
- The local server binds to `127.0.0.1` and is not intended for LAN or public deployment.
- Exported ZIP packages are unencrypted and may contain all saved personal data and photos.
- Git and CI privacy scans protect the public code repository but do not encrypt or synchronize the external data directory.

## Explicit Non-Goals

V2.7 does not provide:

- Cloud hosting, accounts, collaboration or cross-device synchronization.
- Word export, multiple templates, arbitrary CSS or multiple-page resumes.
- AI rewriting, automatic content deletion or semantic resume optimization.
- Electron/Tauri packaging, `.app`/`.exe` installers or automatic updates.
- Automatic Poppler or Node.js installation.
