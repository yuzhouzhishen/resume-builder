# V2 多份简历管理实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add safe local management of multiple named resumes with isolated YAML, backups, photos, previews, PDFs and PNGs while preserving the existing one-page A4 editor workflow.

**Architecture:** Introduce a `resumes.json` registry and a focused `resume-registry.mjs` module that resolves all resume-scoped paths from allowlisted IDs. Refactor generation and editor APIs to receive a resume ID, then add a preview-toolbar selector and modal workflows for create, switch, rename and delete. Existing resume YAML schema and shared template renderer remain unchanged.

**Tech Stack:** Node.js HTTP server, js-yaml, browser JavaScript, HTML/CSS, Playwright, Node test runner.

---

### Task 1: Resume registry and safe paths

**Files:**
- Create: `scripts/resume-registry.mjs`
- Create: `scripts/resume-registry.test.mjs`
- Modify: `package.json`

**Step 1: Write failing registry tests**

Cover loading a valid registry, rejecting duplicate IDs/names, resolving YAML/backups/output paths, rejecting unknown IDs and generating stable unique IDs.

```js
const registry = loadResumeRegistry(rootDir);
assert.equal(registry.activeId, "cpp");
assert.equal(resolveResumePaths(rootDir, registry, "cpp").yaml,
  path.join(rootDir, "resumes/cpp.yaml"));
assert.throws(() => resolveResumePaths(rootDir, registry, "../../x"), /Unknown resume id/);
```

**Step 2: Run tests and verify RED**

```bash
node --test scripts/resume-registry.test.mjs
```

Expected: fail because `resume-registry.mjs` does not exist.

**Step 3: Implement the minimal registry module**

Export:

```js
loadResumeRegistry(rootDir)
saveResumeRegistry(rootDir, registry)
validateResumeRegistry(registry)
resolveResumeEntry(registry, resumeId)
resolveResumePaths(rootDir, registry, resumeId)
createResumeId(registry, displayName)
```

Use a temporary sibling file plus `renameSync()` for registry writes. Validate all registry paths against `resumes/<id>.yaml`; never accept client-provided file paths.

**Step 4: Run focused tests and verify GREEN**

**Step 5: Add the registry test file to `npm test` and commit**

```bash
git add scripts/resume-registry.mjs scripts/resume-registry.test.mjs package.json
git commit -m "feat: add resume registry"
```

### Task 2: Migrate current data and make generation resume-aware

**Files:**
- Move: `resume.yaml` to `resumes/cpp.yaml`
- Create: `resumes.json`
- Modify: `scripts/generate.mjs`
- Modify: `scripts/render.test.mjs`
- Modify: `.gitignore`

**Step 1: Write failing generation tests**

Test that `generateResume({ rootDir, resumeId: "cpp" })` reads `resumes/cpp.yaml`, writes to `output/cpp/`, and that omitted `resumeId` uses `activeId`. Test CLI argument parsing for `--resume cpp` and unknown IDs.

**Step 2: Run focused tests and verify RED**

**Step 3: Move the current YAML and create the initial registry**

```json
{
  "activeId": "cpp",
  "items": [
    { "id": "cpp", "name": "C++ 应届生", "file": "resumes/cpp.yaml" }
  ]
}
```

Keep existing root backups untouched. Update `.gitignore` so `output/*` remains ignored while nested `.gitkeep` files can be tracked when needed.

**Step 4: Refactor generation**

Change `generateResume(options)` to resolve registry paths, create `output/<id>/`, and return `resumeId` plus scoped output paths. Keep `renderResumeHtml()` pure and unchanged.

**Step 5: Verify focused tests and commit**

```bash
git add .gitignore resumes resumes.json scripts/generate.mjs scripts/render.test.mjs
git commit -m "feat: generate scoped resume outputs"
```

### Task 3: Resume list and lifecycle APIs

**Files:**
- Modify: `scripts/editor-server.mjs`
- Modify: `scripts/editor-server.test.mjs`

**Step 1: Write failing API tests**

Add tests for:

- `GET /api/resumes`
- `POST /api/resumes/duplicate`
- `POST /api/resumes/from-example`
- `PATCH /api/resumes/:id`
- `DELETE /api/resumes/:id`
- `POST /api/resumes/:id/activate`

Assert duplicate names, unknown IDs, path-like IDs and deleting the final resume are rejected without changing files.

**Step 2: Run focused tests and verify RED**

**Step 3: Implement lifecycle handlers**

Lifecycle operations must update YAML and registry consistently. Create the new YAML before publishing it in the registry. On delete, update the registry first, then remove only allowlisted YAML/backups/output paths. Shared assets are retained.

**Step 4: Run focused tests and verify GREEN**

**Step 5: Commit**

```bash
git add scripts/editor-server.mjs scripts/editor-server.test.mjs
git commit -m "feat: add resume lifecycle APIs"
```

### Task 4: Scope existing editor APIs by resume ID

**Files:**
- Modify: `scripts/editor-server.mjs`
- Modify: `scripts/editor-server.test.mjs`
- Modify: `scripts/generate.mjs`

**Step 1: Write failing isolation tests**

Create two resumes and prove that save, preview, generate, backups, restore and photo upload for `cpp` never alter `ai-agent`. Assert generated URLs include `/output/<id>/` and uploaded photos use `<id>-photo.<ext>`.

**Step 2: Run tests and verify RED**

**Step 3: Update handlers**

Require `resumeId` in query or JSON bodies as appropriate:

```text
GET /api/resume?resumeId=cpp
PUT /api/resume?resumeId=cpp
GET /api/backups?resumeId=cpp
POST /api/generate { resumeId: "cpp" }
POST /api/photo { resumeId: "cpp", filename, dataUrl }
```

Preview remains file-free but validates assets against the project root. Restore and example handlers write only the selected resume.

**Step 4: Run isolation and full server tests**

**Step 5: Commit**

```bash
git add scripts/editor-server.mjs scripts/editor-server.test.mjs scripts/generate.mjs
git commit -m "feat: isolate resume editor operations"
```

### Task 5: Add the toolbar selector and responsive layout

**Files:**
- Modify: `editor/index.html`
- Modify: `editor/styles.css`
- Modify: `editor/app.js`
- Modify: `scripts/editor-server.test.mjs`

**Step 1: Write failing browser tests**

Assert the preview toolbar contains the current-resume selector, add button and menu button; switching a clean resume reloads form, preview URL, backups and PDF URL. Verify 1440x900 and 1024x900 toolbars have no overlap or horizontal clipping.

**Step 2: Run focused tests and verify RED**

**Step 3: Implement toolbar UI**

Use a real `<select>` for resumes and icon buttons for add and menu actions with `aria-label` and tooltip text. Keep status chips and output actions in separate groups. Use container-responsive CSS to move status chips to a second row when the preview pane is narrow.

**Step 4: Make editor state resume-aware**

Add `state.resumes` and `state.activeResumeId`. Every request and preview URL uses the active ID. Switching cancels draft requests and clears selected preview paths before loading the target.

**Step 5: Run tests, capture screenshots and commit**

```bash
git add editor scripts/editor-server.test.mjs
git commit -m "feat: add resume switcher toolbar"
```

### Task 6: Create, rename, delete and unsaved-switch dialogs

**Files:**
- Modify: `editor/index.html`
- Modify: `editor/styles.css`
- Modify: `editor/app.js`
- Modify: `scripts/editor-server.test.mjs`

**Step 1: Write failing interaction tests**

Cover:

- duplicate current and switch;
- create from example and switch;
- rename with empty/duplicate validation;
- delete confirmation and final-resume disabled state;
- dirty switch: save-and-switch, discard-and-switch, cancel;
- failed save leaves the current resume active.

**Step 2: Run focused tests and verify RED**

**Step 3: Implement one reusable modal shell**

Use centered `<dialog>` markup with clear title, body, primary/secondary/destructive actions, focus return and Escape support. Menus close after selection and on outside click. Do not nest cards or add a separate management page.

**Step 4: Implement state transitions**

Do not mutate `activeResumeId` until required save/create/activate requests succeed. New resumes start in `PDF 待生成` and render draft HTML when no disk preview exists.

**Step 5: Run focused and full browser tests, then commit**

```bash
git add editor scripts/editor-server.test.mjs
git commit -m "feat: manage resume variants in editor"
```

### Task 7: Documentation, migration checks and final verification

**Files:**
- Modify: `README.md`
- Create: `docs/v2-boundaries.md`
- Create: `docs/v2-acceptance-checklist.md`
- Modify: `docs/plans/2026-07-10-v2-multi-resume-design.md`

**Step 1: Document daily use and migration**

Explain `resumes.json`, `resumes/*.yaml`, independent output paths, switching safeguards, CLI `--resume`, and the fact that old root backups remain legacy safety copies.

**Step 2: Run all automated checks**

```bash
npm test
npm run generate
npm run generate -- --resume cpp
pdfinfo output/cpp/resume.pdf
```

Expected: all tests pass; generated PDF is one standard A4 page.

**Step 3: Perform visual QA**

Capture and inspect 1440x900 and 1024x900 states with at least two resumes. Verify the selector, menus, dialogs, full A4 preview and fixed editor footer do not overlap.

**Step 4: Update acceptance evidence and commit**

```bash
git add README.md docs
git commit -m "docs: document multi-resume workflow"
```

**Step 5: Review branch diff and integrate**

Run `git diff main...HEAD --check`, inspect user data migration carefully, then merge the feature branch into `main` only after verification.
