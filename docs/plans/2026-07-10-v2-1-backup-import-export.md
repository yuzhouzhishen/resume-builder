# V2.1B Resume Data Import/Export Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a local, browser-driven ZIP export and two-stage whole-data import workflow with manifest hashes, strict archive validation, automatic pre-import backup, atomic replacement, and rollback.

**Architecture:** A new `scripts/data-package.mjs` module owns the versioned ZIP format, manifest hashing, secure inspection, pending import sessions, and atomic commit. `scripts/editor-server.mjs` exposes thin HTTP endpoints and blocks mutations during commit; the existing editor adds a toolbar menu and a dedicated import/export dialog. All destructive tests use temporary data roots and injected filesystem operations, never the user's real data directory.

**Tech Stack:** Node.js ESM, `fflate`, `node:crypto`, existing synchronous filesystem APIs, built-in HTTP server, vanilla HTML/CSS/JavaScript, Node test runner, Playwright.

---

### Task 1: Add Versioned ZIP Export

**Files:**
- Create: `scripts/data-package.mjs`
- Create: `scripts/data-package.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

**Step 1: Write the failing export tests**

Create a temporary valid multi-resume data root containing `resumes.json`, two YAML files, assets, backups, output, migration metadata and a root legacy backup. Add tests that call:

```js
const archive = createDataPackage({
  dataRoot,
  appVersion: "0.1.0",
  now: () => new Date("2026-07-10T15:30:00.000Z")
});
```

Use `unzipSync()` in the test to assert:

- `manifest.json`, `resumes.json`, `resumes/`, `assets/` and `backups/` files exist;
- `output/`, `.env.local`, `.migration.json`, `.migration-in-progress` and root `resume.backup.yaml` do not exist;
- the manifest has format `resume-builder-backup`, version `1`, stable resume summary and sorted file entries;
- each listed size and SHA-256 matches the archived bytes;
- a symlink in an exported directory is rejected before creating a ZIP.

**Step 2: Run the test and verify RED**

Run:

```bash
node --test scripts/data-package.test.mjs
```

Expected: FAIL because `scripts/data-package.mjs` and `fflate` do not exist.

**Step 3: Install the dependency**

Run:

```bash
npm install fflate
```

Expected: `fflate` appears in `dependencies` and the lockfile changes only for the new package and npm ordering metadata.

**Step 4: Implement the minimal exporter**

Implement and export:

```js
export function createDataPackage(options) {}
```

The function must call `validateDataRoot(dataRoot)`, recursively enumerate allowlisted roots with `lstatSync()`, reject non-regular files and symlinks, sort paths, calculate SHA-256 using `createHash("sha256")`, serialize a newline-terminated `manifest.json`, and return a `Uint8Array` from `zipSync()`.

Read the app version from the caller rather than importing `package.json` inside the module. Use explicit relative POSIX paths in the archive regardless of host OS.

**Step 5: Run the tests and verify GREEN**

Run:

```bash
node --test scripts/data-package.test.mjs
```

Expected: all export tests pass.

**Step 6: Commit**

```bash
git add package.json package-lock.json scripts/data-package.mjs scripts/data-package.test.mjs
git commit -m "feat: export portable resume data packages"
```

### Task 2: Inspect and Securely Stage Imported Packages

**Files:**
- Modify: `scripts/data-package.mjs`
- Modify: `scripts/data-package.test.mjs`

**Step 1: Write failing valid-package inspection tests**

Add a test that exports one temporary root, inspects the ZIP into a sibling staging directory, and asserts:

```js
const inspected = inspectDataPackage(archive, {
  dataRoot: targetRoot,
  token: "test-token",
  now: () => new Date("2026-07-10T15:31:00.000Z")
});

assert.equal(inspected.token, "test-token");
assert.equal(inspected.summary.resumeCount, 2);
assert.equal(validateDataRoot(inspected.stagingRoot).activeId, "cpp");
```

Also assert that no `output/` is created and that the official target root is unchanged.

**Step 2: Write failing archive rejection tests**

Build small ZIP fixtures with `zipSync()` and assert rejection for:

- missing or invalid `manifest.json`;
- unsupported `formatVersion`;
- absolute, `..`, backslash, NUL-like and unknown top-level paths;
- duplicate normalized paths;
- missing, extra, size-mismatched and hash-mismatched files;
- manifest summary inconsistent with `resumes.json`;
- invalid YAML or missing photo after extraction;
- compressed request, per-file, total uncompressed size and file-count limits.

Keep each test focused on one behavior and verify that failure removes only the owned staging directory.

**Step 3: Run the tests and verify RED**

Run:

```bash
node --test --test-name-pattern="inspect|reject|limit" scripts/data-package.test.mjs
```

Expected: FAIL because `inspectDataPackage()` is missing.

**Step 4: Implement secure inspection**

Implement:

```js
export function inspectDataPackage(archiveBytes, options) {}
```

Validation order:

1. Check compressed byte length before unzip.
2. Parse entries with `fflate` and reject invalid normalized names, unexpected roots and duplicate files.
3. Enforce maximum file count, single-file bytes and cumulative uncompressed bytes before filesystem writes.
4. Parse and validate the manifest shape and exact file set.
5. Verify every size and SHA-256.
6. Create `.resume-import-<token>` as a unique sibling of `dataRoot`.
7. Resolve every destination through `resolvePathInside()` and write regular files only.
8. Call `validateDataRoot(stagingRoot)`.
9. Compare manifest summary with the validated registry and return a serializable summary.

Never infer paths from client JSON. If any step fails, remove only the current staging directory if this call created it.

**Step 5: Run tests and refactor while green**

Run:

```bash
node --test scripts/data-package.test.mjs
```

Expected: all package export and inspection tests pass.

Extract small helpers for manifest validation and archive path normalization only after tests are green.

**Step 6: Commit**

```bash
git add scripts/data-package.mjs scripts/data-package.test.mjs
git commit -m "feat: validate imported resume data packages"
```

### Task 3: Add Pending Sessions, Atomic Commit, and Rollback

**Files:**
- Modify: `scripts/data-package.mjs`
- Modify: `scripts/data-package.test.mjs`

**Step 1: Write failing pending-session tests**

Define the intended API through tests:

```js
const manager = createDataImportManager({
  dataRoot,
  now,
  tokenFactory: () => "pending-token"
});

const pending = manager.inspect(archive);
const result = manager.commit(pending.token);
```

Test that:

- only one pending import is retained;
- inspecting a new archive removes only the previous owned staging directory;
- an expired, unknown or already committed token is rejected;
- `cancel(token)` removes staging without changing `dataRoot`;
- `dispose()` removes unpublished staging owned by the manager.

**Step 2: Write failing atomic commit tests**

Use temporary roots and injected `rename` functions to prove:

- current `dataRoot` becomes a unique `.pre-import-YYYYMMDD-HHMMSS` sibling;
- staging becomes the official `dataRoot`;
- the pre-import directory remains complete, including its old `output/`;
- imported `dataRoot` does not contain `output/`;
- a second-rename failure restores the old directory;
- post-publication validation failure quarantines the imported directory and restores the old directory;
- no path recursively deletes the official root or pre-import backup;
- unique suffixes avoid overwriting an existing backup name.

Expose an `isCommitting()` state and assert it is true only during the injected commit callback.

**Step 3: Run tests and verify RED**

Run:

```bash
node --test --test-name-pattern="pending|commit|rollback|pre-import" scripts/data-package.test.mjs
```

Expected: FAIL because the manager API is missing.

**Step 4: Implement the manager**

Implement:

```js
export function createDataImportManager(options) {
  return {
    inspect(archiveBytes),
    commit(token),
    cancel(token),
    dispose(),
    isCommitting()
  };
}
```

Use one in-memory pending record containing token, creation time, staging path and summary. Resolve and reserve the pre-import backup name before the first rename. On rollback, preserve any failed imported directory under an explicit quarantine name; never call recursive removal on `dataRoot` or `.pre-import-*`.

**Step 5: Run package tests**

Run:

```bash
node --test scripts/data-package.test.mjs
```

Expected: all tests pass.

**Step 6: Commit**

```bash
git add scripts/data-package.mjs scripts/data-package.test.mjs
git commit -m "feat: atomically import resume data packages"
```

### Task 4: Expose Export and Two-Stage Import APIs

**Files:**
- Modify: `scripts/editor-server.mjs`
- Modify: `scripts/editor-server.test.mjs`
- Modify: `package.json`

**Step 1: Add failing HTTP API tests**

Add isolated-server tests for:

- `GET /api/data/export` returns `application/zip`, attachment filename and a valid package;
- `POST /api/data/import/inspect` accepts raw ZIP bytes and returns token plus summary;
- oversized raw ZIP requests return 413 and leave no staging directory;
- `POST /api/data/import/commit` replaces the temporary test data root and returns the new registry plus backup directory name;
- invalid or expired tokens return 400/410 without writes;
- while `manager.isCommitting()` is true, all mutating resume endpoints return 423, while GET reads remain available;
- server close calls `manager.dispose()`.

Inject a test manager through `createEditorServer({ dataImportManager })` where needed; use the real manager for end-to-end API tests.

**Step 2: Run selected tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=10000 \
  --test-name-pattern="data export|data import|import lock" \
  scripts/editor-server.test.mjs
```

Expected: FAIL with 404 or missing manager wiring.

**Step 3: Implement binary response and raw-body helpers**

Add bounded `readBinaryBody()` and `sendBinary()` helpers. Do not route ZIP through JSON or base64. Return JSON errors before writing ZIP response headers.

**Step 4: Wire the manager and routes**

Create one manager per editor server using the configured `dataRoot`. Add:

```text
GET  /api/data/export
POST /api/data/import/inspect
POST /api/data/import/commit
DELETE /api/data/import/:token
```

Add one centralized mutation guard before existing write handlers. Treat `/api/preview` as read-only even though it uses POST; it may remain available unless commit is actively swapping directories. Block export during commit so it cannot read a half-switched root.

On successful commit return the same registry response shape used by `/api/resumes`, plus `preImportBackup` and `generation: "needs generate"`.

**Step 5: Add the package tests to `npm test`**

Put `scripts/data-package.test.mjs` in the first Node test command so package tests run without browser concurrency.

**Step 6: Run server and full non-UI tests**

Run:

```bash
node --test scripts/app-paths.test.mjs scripts/data-root.test.mjs \
  scripts/resume-registry.test.mjs scripts/data-package.test.mjs

node --test --test-concurrency=1 --test-timeout=10000 \
  --test-name-pattern="data export|data import|import lock" \
  scripts/editor-server.test.mjs
```

Expected: all selected tests pass.

**Step 7: Commit**

```bash
git add package.json scripts/editor-server.mjs scripts/editor-server.test.mjs
git commit -m "feat: expose resume data transfer APIs"
```

### Task 5: Build the Editor Data Management Workflow

**Files:**
- Modify: `editor/index.html`
- Modify: `editor/styles.css`
- Modify: `editor/app.js`
- Modify: `scripts/editor-server.test.mjs`

**Step 1: Write failing Playwright tests for placement and export**

Test that:

- `#dataManagerButton` sits in the preview toolbar beside the resume switcher and not in the editor pane;
- opening it shows exactly “导出数据包” and “导入数据包”;
- export opens a privacy confirmation mentioning unencrypted personal data;
- confirming export initiates `/api/data/export` as a browser download with the expected filename;
- export leaves the active resume and dirty state unchanged.

**Step 2: Write failing import interaction tests**

Use a custom test server or route overrides to assert:

- dirty state blocks file selection and focuses/shows the save message;
- selecting a ZIP sends raw bytes to inspect and renders filename, size, created time, version, resume count and names;
- confirm calls commit with the token;
- while committing, close and repeat-submit controls are disabled;
- success reloads registry, active YAML, backups and draft preview, and marks PDF as not generated;
- inspect and commit errors remain in the dialog without losing the current resume.

**Step 3: Run selected UI tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=10000 \
  --test-name-pattern="data management|export package|import package" \
  scripts/editor-server.test.mjs
```

Expected: FAIL because the controls do not exist.

**Step 4: Add semantic markup**

Add a text button and anchored menu in the existing toolbar. Add a hidden file input accepting `.zip,application/zip`. Add a dedicated `dialog` for the multi-step import/export workflow rather than overloading the resume lifecycle dialog.

Use clear text commands; do not draw custom SVG icons or add a new icon dependency.

**Step 5: Add state and behavior**

Extend editor state with a data-transfer phase and pending import summary. Implement:

- menu open/close and outside-click behavior consistent with existing toolbar menus;
- export privacy confirmation and browser download;
- raw ZIP inspect upload;
- summary rendering with escaped text;
- commit confirmation and busy state;
- post-import full reload without retaining stale DOM references;
- cancellation cleanup request where a token exists.

Reuse existing `withBusy()`, `renderStatus()`, `loadResumeRegistry()` and resume loading flows where possible. Do not add a frontend framework.

**Step 6: Style the workflow**

Keep the current restrained palette, 6-7px radii and compact toolbar scale. The dialog must fit within the viewport, scroll internally for long resume lists, and keep its action row visible. Do not add nested cards or decorative sections.

**Step 7: Run selected and full editor tests**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=10000 \
  --test-name-pattern="data management|export package|import package" \
  scripts/editor-server.test.mjs

node --test --test-concurrency=1 --test-timeout=10000 scripts/editor-server.test.mjs
```

Expected: all editor tests pass.

**Step 8: Commit**

```bash
git add editor/index.html editor/styles.css editor/app.js scripts/editor-server.test.mjs
git commit -m "feat: add resume data management UI"
```

### Task 6: Documentation and End-to-End Verification

**Files:**
- Create: `docs/v2-1b-boundaries.md`
- Create: `docs/v2-1b-acceptance-checklist.md`
- Modify: `README.md`
- Modify: `docs/plans/2026-07-10-v2-1-backup-import-export-design.md`

**Step 1: Document daily use and privacy**

Document:

- where the data management menu lives;
- what the ZIP contains and excludes;
- that the ZIP is not encrypted and contains personal information;
- how to move computers with export, code clone/install, `.env.local`, and import;
- where `.pre-import-*` backups are kept;
- that V2.1B does not merge data or import PDF/Word.

Mark the design status implemented only after verification.

**Step 2: Run the complete automated suite**

Run:

```bash
npm test
```

Expected: all old and new tests pass with zero failures or cancellations.

**Step 3: Run a temporary-root round trip**

Use the current real data root only as a read-only export source. Write the ZIP to `/tmp`, inspect and commit it into a fresh temporary data root, then compare:

- `resumes.json` SHA-256;
- every exported YAML, asset and backup SHA-256;
- active ID and resume list;
- absence of imported `output/`;
- validity through `validateDataRoot()`.

Never point the commit test at the real data root.

**Step 4: Browser verification**

Start the worktree editor on the next available port using a temporary copy of the data root. Verify toolbar placement, export download, inspect summary, confirmation, reload, dialog overflow, dirty-state block and console errors at desktop and the existing minimum viewport.

**Step 5: Verify repository privacy and cleanliness**

Run:

```bash
git diff --check
git status --short
git ls-files resumes.json 'resumes/*' assets/photo.png .env.local
```

Expected: no tracked private runtime data and no uncommitted generated artifacts.

**Step 6: Commit documentation**

```bash
git add README.md docs/v2-1b-boundaries.md docs/v2-1b-acceptance-checklist.md \
  docs/plans/2026-07-10-v2-1-backup-import-export-design.md
git commit -m "docs: document resume data transfer workflow"
```

### Task 7: Review, Integration, and Gitee Push

**Files:**
- Review all changes from the design commit to `HEAD`.

**Step 1: Review high-risk boundaries**

Check for archive traversal, symlink following, ZIP bombs, hash bypass, token reuse, staging ownership mistakes, concurrent writes, rollback data loss, response privacy leaks and stale UI state.

**Step 2: Run final verification after review fixes**

Run:

```bash
npm test
git diff main...HEAD --check
```

Repeat the temporary-root round trip and browser smoke test after any review fix.

**Step 3: Integrate**

Use `superpowers:finishing-a-development-branch`. Merge the verified branch into `main`, rerun `npm test` on the merged result, push `main` to Gitee, and remove only the V2.1B worktree and feature branch. Do not remove the unrelated V1.1 worktree.
