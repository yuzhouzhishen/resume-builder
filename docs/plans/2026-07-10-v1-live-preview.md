# V1 Live Draft Preview Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update the A4 HTML preview from unsaved editor data after a short debounce without writing YAML or generating PDF/PNG files.

**Architecture:** Add a validation-only preview endpoint that reuses `renderResumeHtml()`. The editor sends the in-memory resume after 300ms, loads returned HTML through iframe `srcdoc`, selects a density by DOM measurement, and keeps save/PDF generation as explicit operations.

**Tech Stack:** Node HTTP server, HTML/CSS, browser JavaScript, Node test runner, Playwright.

**Status:** Completed and verified on 2026-07-10.

---

### Task 1: Preview API

**Files:**
- Modify: `scripts/editor-server.mjs`
- Test: `scripts/editor-server.test.mjs`

1. Write a failing `POST /api/preview` test.
2. Assert draft content appears in returned HTML.
3. Assert `resume.yaml` and `output/preview.html` are unchanged.
4. Implement validation and `renderResumeHtml()` reuse.
5. Run the focused API tests.

### Task 2: Debounced editor preview

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Write a failing test that edits a field and waits for iframe draft HTML.
2. Assert YAML remains unchanged and status displays `草稿预览`.
3. Write a failing rapid-input test and assert only the latest draft is shown.
4. Implement the 300ms scheduler and stale-response guard.
5. Run the focused editor tests.

### Task 3: Draft density and selection

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Write a failing test for `normal -> compact -> tight` selection.
2. Implement same-origin iframe content measurement.
3. Keep preview-to-form field selection working in `srcdoc` mode.
4. Report tight overflow without changing saved content.
5. Run focused tests.

### Task 4: Structural edits and generated preview handoff

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Verify add/delete/move/layout actions schedule the draft preview.
2. Verify save keeps the current draft visible and marks `PDF 待生成`.
3. Verify formal generation clears `srcdoc` and reloads `output/preview.html`.

### Task 5: Documentation and verification

**Files:**
- Modify: `README.md`
- Create: `docs/v1-boundaries.md`
- Create: `docs/v1-acceptance-checklist.md`

1. Document live-preview state semantics and persistence boundaries.
2. Update the automated test count.
3. Run `npm test`.
4. Run `npm run generate` and verify one-page A4 with `pdfinfo`.
5. Capture `1440x900` and `1024x900` editor screenshots.
