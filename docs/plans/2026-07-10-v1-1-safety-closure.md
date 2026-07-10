# V1.1 编辑安全收尾实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Protect unsaved resume drafts from accidental page exits and provide a reliable `Cmd/Ctrl + S` shortcut for the existing explicit save operation.

**Architecture:** Reuse the editor's existing `state.dirty` flag. A `beforeunload` listener only cancels navigation while the in-memory resume differs from the saved YAML. A document-level keyboard listener maps `Cmd/Ctrl + S` to `saveResume()`, while preserving normal browser behavior for other shortcuts and editable controls. No automatic persistence or PDF generation is added.

**Tech Stack:** Browser JavaScript, Node test runner, Playwright, Markdown documentation.

**Status:** Completed and verified on 2026-07-10.

---

### Task 1: Unsaved navigation guard

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Write a failing browser test that dispatches `beforeunload` after an unsaved edit and expects the event to be canceled.
2. Assert a clean editor does not cancel `beforeunload`.
3. Assert saving the draft clears the guard.
4. Add one listener that checks `state.dirty`, calls `preventDefault()`, and sets `event.returnValue = ""`.
5. Run the focused editor tests and confirm they pass.

### Task 2: Cmd/Ctrl + S shortcut

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Write a failing browser test with a controlled save endpoint.
2. Edit a field, dispatch `Meta+S`, and assert exactly one save request is made.
3. Assert the browser default is prevented and the save state returns to `已保存`.
4. Add a document-level `keydown` listener for `event.metaKey || event.ctrlKey` plus `event.key.toLowerCase() === "s"`.
5. Run the focused editor tests and confirm existing button-save behavior remains green.

### Task 3: Documentation and acceptance coverage

**Files:**
- Modify: `README.md`
- Modify: `docs/v1-boundaries.md`
- Modify: `docs/v1-acceptance-checklist.md`

1. Document that browser exit is warned only for unsaved drafts.
2. Document `Cmd/Ctrl + S` as an explicit save shortcut.
3. Clarify that this is not automatic saving and does not generate PDF.
4. Add the V1.1 manual checks and record the automated coverage result.

### Task 4: Verification and delivery

1. Run `npm test`.
2. Run `npm run generate` and verify the PDF remains one-page A4.
3. Inspect the worktree and commit the V1.1 changes.
4. Push `main` to the Gitee `origin` remote.
5. Verify the remote commit matches local `HEAD`.
