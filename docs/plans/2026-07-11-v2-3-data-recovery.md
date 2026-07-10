# V2.3 Resume Data Recovery Center Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a browser-driven recovery center that lists validated pre-import and pre-restore snapshots and restores a selected whole-data snapshot without consuming it or risking the current data.

**Architecture:** A new `scripts/data-recovery.mjs` module owns allowlisted snapshot discovery, opaque IDs, validation, staging copies, atomic replacement, and rollback. `scripts/editor-server.mjs` exposes thin list/restore endpoints and generalizes the existing import mutation gate into a shared whole-data replacement gate; the vanilla editor extends its existing data dialog with list and confirmation states. All destructive tests use temporary data roots and injected filesystem functions, never the user's configured private directory.

**Tech Stack:** Node.js ESM, Node standard filesystem and crypto APIs, existing registry/YAML validation, built-in HTTP server, vanilla HTML/CSS/JavaScript, Node test runner, Playwright.

---

### Task 1: Discover And Validate Recovery Snapshots

**Files:**
- Create: `scripts/data-recovery.mjs`
- Create: `scripts/data-recovery.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing snapshot discovery tests**

Create temporary valid data roots and sibling snapshots. Define the public shape through a test like:

```js
const snapshots = listDataSnapshots({ dataRoot });

assert.deepEqual(snapshots.map(({ type }) => type), [
  "pre-restore",
  "pre-import"
]);
assert.match(snapshots[0].id, /^[a-f0-9]{64}$/);
assert.equal(snapshots[0].valid, true);
assert.equal(snapshots[0].resumeCount, 2);
assert.equal(snapshots[0].activeResumeName, "C++ 示例");
```

Cover exact basename matching, `.pre-import-*`, `.pre-restore-*`, optional numeric collision suffixes and newest-first UTC timestamp sorting. Assert that unrelated siblings and malformed timestamps are ignored.

**Step 2: Write the failing safety and invalid-state tests**

Assert that:

- a candidate root symlink is represented as invalid and never traversed;
- a nested symlink or special file makes the candidate invalid;
- invalid registry, YAML or referenced photo produces `valid: false` with a path-free public reason;
- IDs are full SHA-256 hashes of allowlisted basenames and no absolute path appears in returned JSON;
- two calls over unchanged directories return the same IDs and ordering.

**Step 3: Register the test and verify RED**

Add `scripts/data-recovery.test.mjs` to the first `node --test` group in `package.json`.

Run:

```bash
node --test scripts/data-recovery.test.mjs
```

Expected: FAIL because `scripts/data-recovery.mjs` does not exist.

**Step 4: Implement minimal discovery**

Implement:

```js
export function listDataSnapshots(options) {
  // Return public snapshot summaries only.
}
```

Build an escaped regular expression from `path.basename(dataRoot)`, parse timestamps with explicit UTC components, and verify parsed components to reject impossible dates. Use `lstatSync()` recursively to allow only regular files and directories, then call `validateDataRoot(candidateRoot)`. Compute IDs with:

```js
createHash("sha256").update(candidateBasename).digest("hex")
```

Convert validation failures to a stable code such as `invalid-data` and a path-free public reason such as `Snapshot data is invalid.` rather than returning `error.message`, which contains absolute paths. The browser maps the code to Chinese display text.

**Step 5: Run the discovery tests and verify GREEN**

Run:

```bash
node --test scripts/data-recovery.test.mjs
```

Expected: all discovery and safety tests pass.

**Step 6: Commit**

```bash
git add package.json scripts/data-recovery.mjs scripts/data-recovery.test.mjs
git commit -m "feat: discover recoverable data snapshots"
```

### Task 2: Restore Through A Staged Atomic Transaction

**Files:**
- Modify: `scripts/data-recovery.mjs`
- Modify: `scripts/data-recovery.test.mjs`

**Step 1: Write the failing successful-restore test**

Define the manager API:

```js
const manager = createDataRecoveryManager({
  dataRoot,
  now: () => new Date("2026-07-11T08:09:10.000Z"),
  tokenFactory: () => "restore-token"
});
const [snapshot] = manager.list();
const result = manager.restore(snapshot.id);
```

Assert that the selected data becomes official, the original snapshot still exists unchanged, the old official root is preserved as `.pre-restore-20260711-080910`, the returned registry matches the restored root, and the response exposes only the backup basename.

**Step 2: Write failing collision, stale-ID, and lifecycle tests**

Cover:

- an existing `.pre-restore-<timestamp>` causes a `-2` suffix rather than overwrite;
- an unknown ID and a candidate removed or invalidated after listing are rejected without writes;
- `isRestoring()` is true only during the injected transaction;
- `dispose()` removes only an owned unpublished staging directory;
- a second restore from the same snapshot succeeds because the source snapshot remains.

**Step 3: Write failing rollback tests**

Inject `copy`, `rename`, `validate` and `remove` operations to prove:

- copy or staging validation failure leaves current data and all snapshots untouched;
- publishing the staging directory failing after the first rename restores the old root;
- final validation failure moves the failed publication to a unique `.failed-restore-<token>` path and restores the old root;
- failure to restore the old root reports a high-signal error and never deletes either surviving directory;
- no failure path recursively removes `dataRoot`, `.pre-import-*` or `.pre-restore-*`.

**Step 4: Run selected tests and verify RED**

Run:

```bash
node --test --test-name-pattern="restore|rollback|stale|dispose" scripts/data-recovery.test.mjs
```

Expected: FAIL because the manager and restore transaction are missing.

**Step 5: Implement the recovery manager**

Implement:

```js
export function createDataRecoveryManager(options) {
  return {
    list(),
    restore(snapshotId),
    dispose(),
    isRestoring()
  };
}
```

`restore()` must rescan snapshots, copy the source to `.<basename>.restore-<token>` in the same parent directory, validate the copy, reserve a unique pre-restore path, and use two atomic renames. Validate again after publication. Roll back or quarantine exactly as specified in the design; clear owned staging in `finally` only when it is not the official root.

**Step 6: Run all recovery tests and verify GREEN**

Run:

```bash
node --test scripts/data-recovery.test.mjs
```

Expected: all discovery, transaction and rollback tests pass.

**Step 7: Commit**

```bash
git add scripts/data-recovery.mjs scripts/data-recovery.test.mjs
git commit -m "feat: restore data snapshots atomically"
```

### Task 3: Add Recovery APIs And A Shared Replacement Gate

**Files:**
- Modify: `scripts/editor-server.mjs`
- Modify: `scripts/editor-server.test.mjs`

**Step 1: Write failing list and restore API tests**

Using only temporary fixture roots, assert:

```text
GET  /api/data/recovery/snapshots
POST /api/data/recovery/restore { "snapshotId": "..." }
```

The list response must include valid and invalid summaries without absolute paths. A successful restore must return the registry response shape plus `preRestoreBackup` and `generation: "needs generate"`. Unknown IDs return 404; invalid or stale snapshots return 409; malformed bodies return 400.

**Step 2: Write failing shared-gate tests**

Inject import and recovery managers to prove:

- restore returns 423 while an earlier save or generation is still writing;
- import commit and restore cannot start together;
- while either replacement is active, new official mutations and data export are rejected;
- a failed request releases the pending replacement gate;
- server close disposes both managers;
- ordinary snapshot listing does not acquire the destructive gate.

**Step 3: Run selected server tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=30000 \
  --test-name-pattern="recovery|replacement gate" \
  scripts/editor-server.test.mjs
```

Expected: FAIL with 404 responses or missing manager wiring.

**Step 4: Add thin handlers and manager injection**

Import `createDataRecoveryManager`, create one manager per server, and support `options.dataRecoveryManager` for isolated tests. Add handlers that map manager status errors to JSON and use `path.basename()` for any backup name returned to the browser.

**Step 5: Generalize the mutation gate**

Replace import-specific gate concepts with shared replacement concepts:

```js
createDataMutationGate({
  isReplacing: () => dataImportManager.isCommitting()
    || dataRecoveryManager.isRestoring()
});
```

Expose `beginReplacement()`, `endReplacement()` and `isReplacementLocked()`. Route both import commit and recovery restore through `beginReplacement()`. Keep `/api/preview` behavior unchanged, keep normal GET reads available, and block export during replacement.

**Step 6: Run server and package tests**

Run:

```bash
node --test scripts/data-package.test.mjs scripts/data-recovery.test.mjs
node --test --test-concurrency=1 --test-timeout=30000 scripts/editor-server.test.mjs
```

Expected: all tests pass, including existing import concurrency tests.

**Step 7: Commit**

```bash
git add scripts/editor-server.mjs scripts/editor-server.test.mjs
git commit -m "feat: expose protected data recovery APIs"
```

### Task 4: Build The Recovery Center Dialog

**Files:**
- Modify: `editor/index.html`
- Modify: `editor/app.js`
- Modify: `editor/styles.css`
- Modify: `scripts/editor-server.test.mjs`

**Step 1: Write failing browser tests for entry and states**

Add Playwright tests proving that:

- `数据管理` contains `恢复历史数据` below import;
- a dirty draft blocks opening and focuses the save action;
- loading, no-snapshot, valid-list and invalid-snapshot states render correctly;
- invalid rows cannot be selected and show a concise reason;
- selecting a row reveals its resume names and enables the primary action;
- the first primary action opens a separate confirmation state rather than restoring immediately.

Stub API responses through the existing editor test server or temporary recovery fixtures; never point a test at the configured personal data root.

**Step 2: Run browser tests and verify RED**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=30000 \
  --test-name-pattern="recovery center|historical data" \
  scripts/editor-server.test.mjs
```

Expected: FAIL because the menu item and dialog states do not exist.

**Step 3: Add menu, state and list rendering**

Add `#recoverDataButton` to the existing data manager menu. Extend state with:

```js
recoverySnapshots: [],
selectedRecoverySnapshotId: ""
```

Add dialog modes `recovery-loading`, `recovery-list`, `recovery-confirm`, `recovering` and `recovery-error`. Reuse `formatDataPackageDate()`, HTML escaping, existing dialog busy state and existing focus restoration. Render snapshot rows as a flat selectable list, not nested cards.

**Step 4: Write failing success and failure interaction tests**

Assert that confirmation sends exactly one restore request, disables close/cancel/primary controls while busy, applies the returned registry, reloads the selected resume in draft-only mode, marks formal output as needing generation, and shows a success message containing only the backup name. A failed request keeps the confirmation open and supports retry without losing the selection.

**Step 5: Implement restore interaction**

Add `requestDataRecovery()`, `loadRecoverySnapshots()`, `selectRecoverySnapshot()` and `commitDataRecovery()`. Re-check `state.dirty` before both opening and final commit. On success call `applyRegistry(body)`, close without clearing unrelated import state, then `loadSelectedResume({ draftOnly: true })`.

**Step 6: Style and verify responsive behavior**

Add restrained list-row styles with fixed status alignment, visible keyboard focus, selected background, disabled invalid state, and scroll containment inside the existing modal. Verify long resume names wrap without widening the dialog at desktop and narrow viewports.

Run:

```bash
node --test --test-concurrency=1 --test-timeout=30000 scripts/editor-server.test.mjs
```

Expected: all editor server and browser tests pass.

**Step 7: Commit**

```bash
git add editor/index.html editor/app.js editor/styles.css scripts/editor-server.test.mjs
git commit -m "feat: add the data recovery center UI"
```

### Task 5: Document Boundaries And Manual Acceptance

**Files:**
- Create: `docs/v2-3-boundaries.md`
- Create: `docs/v2-3-acceptance-checklist.md`
- Modify: `README.md`

**Step 1: Write the V2.3 boundary document**

Document both snapshot types, whole-data semantics, source preservation, automatic pre-restore backup, external data-root requirement, dirty-draft block, public error boundary, rollback behavior and explicit non-goals. State that snapshots contain unencrypted personal data and remain outside Git.

**Step 2: Write the acceptance checklist**

Include manual checks for:

- no-snapshot and invalid-snapshot states;
- restore from pre-import and pre-restore snapshots;
- same snapshot restored twice;
- current data appearing as a new recovery point;
- dirty draft blocking;
- restore followed by draft preview and explicit PDF regeneration;
- restarting the editor after restore;
- real private paths never appearing in Git status or browser API payloads.

**Step 3: Update README navigation and data-management instructions**

Add V2.3 links near the other version documents. Extend `数据导出、导入与换电脑` with recovery center usage and distinguish whole-data recovery from the per-resume `最近备份` feature.

**Step 4: Run privacy and documentation checks**

Run:

```bash
npm run privacy:check
```

Expected: PASS with no personal data, archive or private path tracked.

**Step 5: Commit**

```bash
git add README.md docs/v2-3-boundaries.md docs/v2-3-acceptance-checklist.md
git commit -m "docs: define V2.3 recovery boundaries"
```

### Task 6: Verify The Complete V2.3 Release Candidate

**Files:**
- Modify only if verification exposes a defect in an already touched V2.3 file.

**Step 1: Run focused recovery tests**

```bash
node --test scripts/data-recovery.test.mjs
node --test --test-concurrency=1 --test-timeout=30000 \
  --test-name-pattern="recovery|replacement gate|data import" \
  scripts/editor-server.test.mjs
```

Expected: all focused tests pass.

**Step 2: Run the full local CI gate**

```bash
npm test
```

Expected: privacy scan and every unit, HTTP, browser and render test pass with zero failures or cancellations.

**Step 3: Perform isolated manual browser acceptance**

Start the editor with a synthetic external data directory, not the user's real directory:

```bash
RESUME_BUILDER_DATA_DIR=/tmp/resume-builder-v2-3-manual npm run editor
```

Create recovery fixtures through test-safe import/restore flows, then check the V2.3 acceptance document at desktop and narrow widths. Confirm the complete A4 preview and bottom controls remain visible.

**Step 4: Review safety invariants**

Use `superpowers:requesting-code-review` and specifically review:

- no client-controlled paths reach filesystem operations;
- no recursive removal can target official or historical data;
- all restore failures preserve at least one valid current copy;
- import and restore share one exclusive replacement gate;
- no API or tracked fixture contains private absolute paths or real resume data.

**Step 5: Inspect the final diff and Git status**

```bash
git diff --check main...HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted/generated/private files.

**Step 6: Commit any verification-only fixes**

If verification required code changes, add only the affected V2.3 files and commit:

```bash
git commit -m "fix: close V2.3 recovery verification gaps"
```

If no fixes were needed, do not create an empty commit.
