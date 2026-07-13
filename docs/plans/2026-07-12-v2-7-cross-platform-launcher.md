# Resume Builder V2.7 Cross-Platform Launcher Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add one cross-platform Node launcher with macOS and Windows double-click entry points.

**Architecture:** Add an opaque localhost health identity to the existing server. A dependency-light Node launcher prepares runtime dependencies, reuses a matching server or starts a new one, and delegates browser opening to a platform command; thin wrappers only locate the project and invoke Node.

**Tech Stack:** Node.js built-ins, Vanilla JavaScript, `node:test`, Playwright integration tests, zsh `.command`, Windows `.cmd`.

---

### Task 1: Specify Health And Launcher Behavior With Failing Tests

**Files:**
- Create: `scripts/launch-editor.test.mjs`
- Modify: `scripts/editor-server.test.mjs`
- Modify: `scripts/ci-workflow.test.mjs`

1. Test deterministic opaque instance IDs and a path-free `/api/health` response.
2. Test browser commands for `darwin`, `win32` and Linux.
3. Test matching-server discovery and rejection of unrelated health responses.
4. Test reuse versus fresh-server launch through injected dependencies.
5. Test dependency and Chromium installation decisions without network access.
6. Test both wrappers use relative project paths and the shared launcher.
7. Run focused tests and confirm failure because the launcher and health contract do not exist.

### Task 2: Implement Health Identity

**Files:**
- Modify: `scripts/editor-server.mjs`
- Test: `scripts/editor-server.test.mjs`

1. Add `createEditorInstanceId(dataRoot)` using SHA-256.
2. Add localhost `GET /api/health` with the minimal public fields.
3. Pass the instance ID through `startEditorServer()` and return it in the server handle.
4. Run health-focused tests.

### Task 3: Implement Shared Launcher And Wrappers

**Files:**
- Create: `scripts/launch-editor.mjs`
- Create: `whoami_.command`
- Create: `whoami_.cmd`
- Modify: `package.json`
- Test: `scripts/launch-editor.test.mjs`

1. Add Node version, dependency and Chromium checks.
2. Add Poppler warning checks without installing platform packages.
3. Add matching health scan and browser command selection.
4. Add fresh start, existing reuse and signal cleanup.
5. Add `editor:open` package script and thin wrappers.
6. Mark the macOS wrapper executable.
7. Run launcher-focused and complete editor-server tests.

### Task 4: Document And Verify

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-07-12-v2-7-cross-platform-launcher-design.md`

1. Document Node prerequisites and macOS/Windows first-run and daily workflows.
2. Document automatic npm/Chromium installation and current Poppler boundary.
3. Mark the design implemented.
4. Run `TZ=UTC npm test`, diff checks, staged privacy scan and wrapper permission checks.
5. Commit directly to `main` with the GitHub noreply identity and push `origin/main`.
