# V2.4.1 Preview Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove visible iframe reloads and intermediate candidate jumps from layout-only editing while preserving V2.4 fitting semantics.

**Architecture:** Track content revisions independently from layout dirty state. Reuse the current iframe for layout-only requests, measure candidates on an offscreen page clone, and apply only the selected candidate to the visible root. Update continuous range controls in place.

**Tech Stack:** Node.js ESM, vanilla JavaScript, Playwright, `node:test`.

### Task 1: Add Preview Stability Regression Tests

**Files:**
- Modify: `scripts/editor-server.test.mjs`

1. Add a browser test proving a layout-only change sends `POST /api/preview` without changing iframe document identity or increasing its load count.
2. Instrument the iframe root and prove an overflowing preferred candidate is measured offscreen while only the fitting candidate reaches the visible root.
3. Prove a range input retains DOM identity and focus after an `input` event.
4. Prove a content edit still reloads updated HTML.
5. Run the focused tests and confirm they fail for the current visible reload and form rerender behavior.

### Task 2: Measure Candidates Offscreen

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Refactor content measurement to accept a page element.
2. Create and remove an invisible measurement host containing a clone of `#resume-page`.
3. Apply each candidate to the clone and measure it after one animation frame.
4. Apply only the selected candidate to the visible document root.
5. Preserve allowlisted variables, overflow calculations and fallback candidates.
6. Run focused tests and commit `fix: measure draft layouts offscreen`.

### Task 3: Reuse Preview HTML For Layout-Only Changes

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Add current and rendered content revisions to editor state.
2. Increment content revision for content mutations but not layout-control mutations.
3. When revisions match, consume returned candidates without assigning `iframe.srcdoc` and finalize the draft directly.
4. Keep the existing reload path for content changes and record its rendered revision after load.
5. Guard both paths with the current draft generation counter.
6. Run focused tests and commit `fix: reuse preview for layout-only drafts`.

### Task 4: Keep Range Controls Mounted

**Files:**
- Modify: `editor/app.js`
- Test: `scripts/editor-server.test.mjs`

1. Add an in-place range synchronization helper.
2. Make range `input` update draft state without calling `renderForm()`.
3. Update output, ARIA text and boundary button states in place.
4. Keep discrete step, mode, margin and reset actions unchanged.
5. Run the complete editor test file and commit `fix: stabilize layout range controls`.

### Task 5: Document And Verify

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-07-11-v2-4-1-preview-stability-design.md`

1. Document stable layout-only preview behavior and the deferred content double buffer.
2. Run `TZ=UTC npm test`, `git diff --check` and `npm run privacy:check`.
3. Perform fictional-data Playwright acceptance for iframe load count, visible candidate history, focus and final A4 status.
4. Mark the design implemented and commit `docs: document V2.4.1 preview stability`.
5. Push the branch and provide the PR link; PR creation and merge follow the established manual GitHub step.

