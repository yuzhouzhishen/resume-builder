# Resume Builder V2.5 Local Draft Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve unsaved per-resume edits in browser-local storage and offer explicit recovery after reload.

**Architecture:** Add a small versioned storage adapter inside the editor, track the signature of the last loaded YAML, and integrate cleanup with existing save/discard/replacement lifecycle points. Recovery reuses the existing modal and draft preview pipeline.

**Tech Stack:** Vanilla JavaScript, Web Storage, Node.js `node:test`, Playwright.

---

### Task 1: Add Browser Recovery Regression Tests

**Files:**
- Modify: `scripts/editor-server.test.mjs`

1. Test that an edit writes a versioned ID-scoped record while YAML stays unchanged.
2. Reload and test explicit Restore updates form and preview while remaining unsaved.
3. Test Discard and successful Save remove the record.
4. Test a changed base displays a warning and corrupt records are removed safely.
5. Run focused tests and confirm they fail before implementation.

### Task 2: Implement Local Draft Storage

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Add key construction, record parsing, signature and validation helpers.
2. Debounce writes from `markDirty()` and flush on page lifecycle events.
3. Report quota/security failures without blocking editing.
4. Run storage-focused tests.

### Task 3: Implement Recovery And Cleanup Lifecycle

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Offer recovery after a resume loads.
2. Restore through the existing dirty-preview flow.
3. Clear records after Save and explicit discard.
4. Clear appropriate records after delete, example/photo/backup replacement and whole-data replacement.
5. Run the complete editor test file.

### Task 4: Document And Verify

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-07-12-v2-5-local-draft-recovery-design.md`

1. Document recovery behavior, local-only privacy and ZIP exclusion.
2. Mark the design implemented.
3. Run `TZ=UTC npm test`, `git diff --check` and the privacy gate.
4. Commit directly to `main` with a GitHub noreply identity and push for CI verification.
