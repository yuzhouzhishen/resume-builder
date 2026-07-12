# Resume Builder V2.6 Edit History Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add session-local Undo and Redo for all reversible resume edits.

**Architecture:** Maintain bounded whole-resume snapshots in the editor state and create history checkpoints at logical transaction boundaries. Restore snapshots through the existing dirty-state, local-draft and buffered-preview pipeline.

**Tech Stack:** Vanilla JavaScript, HTML, CSS, Node.js `node:test`, Playwright.

---

### Task 1: Add Browser Regression Tests

**Files:**
- Modify: `scripts/editor-server.test.mjs`

1. Add a failing test for toolbar state and coalesced text Undo/Redo.
2. Add a failing test for keyboard shortcuts and clearing Redo after a new edit.
3. Add a failing test for structural and layout operations.
4. Add a failing test for dirty state around Save and local-draft synchronization.
5. Run only these tests and confirm failures are caused by missing history controls.

### Task 2: Implement Snapshot History

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Add bounded `past` and `future` stacks and snapshot helpers.
2. Add 600ms field transaction coalescing and explicit transaction boundaries.
3. Route form inputs and reversible actions through history checkpoints.
4. Apply Undo/Redo by restoring a snapshot, recalculating dirty state, synchronizing local drafts and scheduling preview.
5. Reset history at resume and server-side replacement lifecycle boundaries.
6. Run focused tests until green.

### Task 3: Add Toolbar And Shortcuts

**Files:**
- Modify: `editor/index.html`
- Modify: `editor/styles.css`
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Add 34px Undo and Redo buttons between resume management and Data Management.
2. Bind disabled and busy states in the existing render pipeline.
3. Bind `Cmd/Ctrl + Z`, `Cmd/Ctrl + Shift + Z` and `Ctrl + Y`.
4. Verify tooltip, focus and narrow-toolbar behavior.

### Task 4: Document And Verify

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-07-12-v2-6-edit-history-design.md`

1. Document button behavior, shortcuts and session-only boundary.
2. Mark the design implemented.
3. Run focused tests, complete editor tests, `TZ=UTC npm test`, staged privacy scan and diff checks.
4. Commit directly to `main` with the GitHub noreply identity and push `origin/main`.
