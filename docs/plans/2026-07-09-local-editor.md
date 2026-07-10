# Local Resume Editor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local browser-based editor for `resume.yaml` with left-side A4 preview and right-side form editing, while reusing the existing one-page PDF generator.

**Architecture:** Keep `resume.yaml` as the single source of truth. A local Node.js server reads, validates, and saves resume data through `scripts/resume-data.mjs`, calls the existing generator to produce `output/resume.pdf`, `output/preview.html`, and `output/resume.png`, then serves a browser UI for editing and previewing. The UI is a local workbench, not a public website.

**Tech Stack:** Node.js built-in HTTP server, existing `js-yaml`, existing Playwright generator, vanilla HTML/CSS/JavaScript, existing Poppler verification flow.

---

## 1. Current State

The v0 command-line generator is stable enough to support a local editor:

- Main content file: `~/Downloads/resume-builder/resume.yaml`
- Data module: `~/Downloads/resume-builder/scripts/resume-data.mjs`
- Generator CLI: `~/Downloads/resume-builder/scripts/generate.mjs`
- Outputs:
  - `~/Downloads/resume-builder/output/resume.pdf`
  - `~/Downloads/resume-builder/output/preview.html`
  - `~/Downloads/resume-builder/output/resume.png`
- Examples:
  - `~/Downloads/resume-builder/examples/cpp.yaml`
  - `~/Downloads/resume-builder/examples/ai-agent.yaml`

The current YAML schema includes:

```yaml
profile: {}
layout:
  sectionOrder:
    - internships
    - skills
    - projects
skills: []
internships: []
projects: []
```

This schema should remain the source of truth for v1. The local editor must not introduce a second data format.

## 2. Product Boundary

v1 should be a local editing workbench.

In scope:

- Start a local server with one command.
- Open a browser UI on `localhost`.
- Edit `profile`, `skills`, `internships`, `projects`, and `layout.sectionOrder`.
- Save changes back to `resume.yaml`.
- Generate PDF/PNG using the existing generator.
- Refresh the preview after generation.
- Load existing examples into `resume.yaml` after confirmation.
- Replace the photo through a local browser upload flow.
- Show clear validation and generation errors.

Out of scope for v1:

- Online hosting.
- Login or multi-user support.
- Cloud storage.
- Word export.
- AI rewriting.
- Drag-and-drop rich text editing.
- Multiple visual templates.
- Continuous PDF generation on every keystroke.

## 3. UI Layout

The UI should be optimized for visual checking while editing.

Primary layout:

```text
┌────────────────────────────────────┬────────────────────────┐
│ Left: A4 preview                   │ Right: editor panel    │
│                                    │                        │
│ output preview / status / errors   │ module tabs            │
│                                    │ active module form     │
│ resume page                        │                        │
│                                    │ bottom actions         │
└────────────────────────────────────┴────────────────────────┘
```

Left side:

- Occupies the main width.
- Shows the latest generated resume output.
- Prefer `output/resume.png` for stable visual preview after generation.
- Optionally allow switching to `output/preview.html` later.
- Keeps A4 aspect ratio visible.
- Has a compact status bar above the page:
  - density profile, for example `tight`
  - page status, for example `1 page A4`
  - save state, for example `saved` or `unsaved`
  - generation state, for example `generated` or `needs generate`

Right side:

- Fixed-width editor panel, around `400-460px`.
- Scrolls independently from the preview.
- Top module selector:
  - `基本信息`
  - `照片`
  - `实习经历`
  - `专业技能`
  - `项目经历`
  - `排版顺序`
- Active module renders a focused form.
- Bottom action bar stays reachable:
  - `保存`
  - `生成 PDF`
  - `打开 PDF`
  - `载入样例`

Visual style:

- Quiet, utilitarian, document-tool feeling.
- No landing page.
- No hero section.
- No decorative gradients or ornamental backgrounds.
- Use restrained neutral surfaces, clear dividers, and a small blue accent for primary actions and links.
- Keep density high but readable.
- Use familiar icons for add, delete, move up, move down, save, generate, and open.

## 4. Editing Model

The editor should treat the form state as a draft copy of `resume.yaml`.

State model:

```text
server resume.yaml
  -> GET /api/resume
  -> browser draft state
  -> user edits forms
  -> PUT /api/resume
  -> validate + save YAML
  -> POST /api/generate
  -> update output files
  -> refresh preview
```

Important states:

- `clean`: browser state matches saved YAML.
- `dirty`: browser state differs from saved YAML.
- `saved`: latest draft has been persisted to YAML.
- `needs generate`: YAML was saved after the last PDF generation.
- `generating`: Playwright export is running.
- `generated`: output files reflect latest YAML.
- `error`: validation or generation failed.

The editor should not run PDF generation on every keystroke. v1 should use explicit actions:

1. User edits form.
2. User clicks `保存`.
3. User clicks `生成 PDF`.
4. Left preview refreshes.

This keeps behavior predictable and avoids heavy background rendering.

## 5. Forms

### Basic Info

Fields map to `profile`:

- `name`
- `target`
- `school`
- `major`
- `phone`
- `email`
- `photo`

`photo` may be shown as a read-only path when the photo upload module is used.

### Photo

v1 should support replacing the photo without hand-editing paths.

Browser flow:

1. User selects a local image file.
2. Browser reads it as a data URL.
3. Browser sends `{ filename, dataUrl }` to the server.
4. Server writes it into `assets/`.
5. Server updates `profile.photo` to the new asset path.
6. UI marks the resume as saved or dirty depending on the chosen implementation.

This avoids multipart parsing and keeps dependencies minimal.

Supported formats:

- `.png`
- `.jpg`
- `.jpeg`
- `.webp`
- `.svg`

The UI should show the current photo preview.

### Internships

Each internship item maps to:

- `start`
- `end`
- `organization`
- `role`
- `summary`
- `items`
- `linkLabel`
- `link`

Controls:

- Add internship.
- Delete internship with confirmation.
- Move internship up/down.
- Add bullet.
- Delete bullet.
- Move bullet up/down.
- Use multi-line text areas for summary and bullet text.

### Skills

Each skill group maps to:

- `title`
- `items`

Controls:

- Add skill group.
- Delete skill group.
- Move skill group up/down.
- Add bullet.
- Delete bullet.
- Move bullet up/down.

### Projects

Each project maps to:

- `start`
- `end`
- `name`
- `role`
- `summary`
- `items`
- `linkLabel`
- `link`

Controls mirror internships.

### Layout Order

Controls edit:

```yaml
layout:
  sectionOrder:
    - internships
    - skills
    - projects
```

v1 can use simple up/down buttons instead of drag-and-drop.

Rules:

- Allowed keys: `skills`, `internships`, `projects`
- Each key must appear exactly once.
- Display labels:
  - `skills` -> `专业技能`
  - `internships` -> `实习经历`
  - `projects` -> `项目经历`

## 6. Server API

The server should bind to `127.0.0.1` only.

Recommended command:

```bash
npm run editor
```

Recommended URL:

```text
http://127.0.0.1:4321
```

Port policy:

- Try `127.0.0.1:4321` first.
- If the port is occupied, automatically try the next port.
- Keep trying up to a small limit, for example `4321-4330`.
- Print the final URL clearly, for example `Editor running at http://127.0.0.1:4322`.
- If all candidate ports are occupied, fail with a clear message listing the attempted range.

Request body policy:

- JSON request bodies must have a hard size limit.
- Use a default maximum of `5MB`.
- If the request exceeds the limit, stop reading and return `413 Payload Too Large`.
- Photo uploads through data URLs must also respect this limit and validate decoded byte size.

Endpoints:

### `GET /api/resume`

Returns parsed and validated resume data.

Success:

```json
{
  "ok": true,
  "resume": {}
}
```

Failure:

```json
{
  "ok": false,
  "error": "profile.email is required"
}
```

### `PUT /api/resume`

Accepts JSON resume data, validates with `validateResume()`, writes `resume.yaml` with `saveResumeYaml()`.

Success:

```json
{
  "ok": true
}
```

### `POST /api/generate`

Runs the generator against the saved YAML.

Success:

```json
{
  "ok": true,
  "density": "tight",
  "contentHeight": 1074,
  "outputs": {
    "pdf": "/output/resume.pdf",
    "png": "/output/resume.png",
    "html": "/output/preview.html"
  }
}
```

Failure:

```json
{
  "ok": false,
  "error": "Content does not fit one A4 page after tight profile.\nOverflow: 38px.\nSuggestion: shorten the longest section or reduce 1-2 bullet items."
}
```

### `GET /api/examples`

Returns available example files and display names:

```json
{
  "ok": true,
  "examples": [
    { "id": "cpp", "label": "C++", "path": "examples/cpp.yaml" },
    { "id": "ai-agent", "label": "AI Agent", "path": "examples/ai-agent.yaml" }
  ]
}
```

### `POST /api/load-example`

Accepts:

```json
{
  "id": "ai-agent"
}
```

Loads the example YAML, validates it, and saves it to `resume.yaml`.

This must require UI confirmation because it overwrites the current resume content.

### `POST /api/photo`

Accepts:

```json
{
  "filename": "portrait.png",
  "dataUrl": "data:image/png;base64,..."
}
```

Server behavior:

- Validate extension and MIME.
- Decode base64.
- Write to `assets/photo.<ext>` or a timestamped asset filename.
- Update `profile.photo`.
- Save `resume.yaml`.
- Return updated resume data.

### Static Files

Serve:

- `/` -> editor UI
- `/output/resume.png`
- `/output/resume.pdf`
- `/output/preview.html`
- `/templates/resume.css` for preview HTML

## 7. Generator Refactor Needed For v1

Current CLI generation works, but server integration should avoid spawning a shell when possible.

Refactor target:

- Export an async function from `scripts/generate.mjs`, for example:

```js
export async function generateResume(options = {}) {
  // load, validate, select density, write outputs
  // return { density, metrics, outputPaths }
}
```

- Keep CLI behavior:

```js
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  generateResume().catch(...)
}
```

The server can call `generateResume()` directly. This makes errors structured and easier to show in the editor.

## 8. Error Handling

Validation errors:

- Show in the right editor panel.
- Keep the user's draft in the browser.
- Do not overwrite `resume.yaml`.

Generation errors:

- Show in the left preview status area.
- Keep the last successful preview visible.
- Display overflow error exactly enough to act:

```text
Content does not fit one A4 page after tight profile.
Overflow: 38px.
Suggestion: shorten the longest section or reduce 1-2 bullet items.
```

Photo errors:

- Unsupported file type.
- Invalid base64 data URL.
- File too large. v1 should enforce a concrete server-side limit, initially `5MB` for JSON body and decoded photo bytes.
- Cannot write to `assets/`.

Server errors:

- Show a short UI error.
- Log full details in terminal.

Unsaved changes:

- If the user loads an example or refreshes while dirty, confirm first.

## 9. Testing Plan

Keep testing mostly at module and API levels.

Required tests:

- Existing `npm test` stays green.
- `resume-data.mjs` load/save/validate tests remain green.
- Server API tests:
  - `GET /api/resume` returns current YAML.
  - `PUT /api/resume` saves valid data.
  - `PUT /api/resume` rejects missing required fields.
  - `POST /api/load-example` loads a valid example.
  - `POST /api/photo` rejects unsupported extension.
- Generator integration:
  - `POST /api/generate` returns selected density and output paths.
  - Generated PDF remains one standard A4 page.

Manual UI checks:

- Left preview remains visible while editing right panel.
- Save marks draft clean.
- Generate refreshes preview.
- Example load warns before overwrite.
- Photo replacement updates right-top photo.
- Layout order changes section order after generation.

## 10. Implementation Tasks

### Task 1: Export Generator Function

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/generate.mjs`
- Test: `~/Downloads/resume-builder/scripts/render.test.mjs`

**Step 1:** Write a failing test that imports `generateResume` from `scripts/generate.mjs`.

**Step 2:** Run:

```bash
npm test
```

Expected: fails because `generateResume` is not exported.

**Step 3:** Refactor the existing internal `generate()` function into exported `generateResume(options = {})`.

**Step 4:** Keep CLI behavior unchanged.

**Step 5:** Run:

```bash
npm test
npm run generate
```

Expected: tests pass and output files are still produced.

### Task 2: Add Editor Server Skeleton

**Files:**

- Create: `~/Downloads/resume-builder/scripts/editor-server.mjs`
- Modify: `~/Downloads/resume-builder/package.json`
- Test: `~/Downloads/resume-builder/scripts/editor-server.test.mjs`

**Step 1:** Add `npm run editor` script:

```json
"editor": "node scripts/editor-server.mjs"
```

**Step 2:** Implement a Node HTTP server bound to `127.0.0.1:4321`.

**Step 3:** Add port probing: try `4321` first, then `4322` and onward up to `4330`; print the selected URL.

**Step 4:** Serve a placeholder `/` page.

**Step 5:** Add tests for server startup, `GET /`, and fallback when the preferred port is occupied.

**Step 6:** Run:

```bash
node --test scripts/editor-server.test.mjs
```

Expected: server responds `200`.

### Task 3: Implement Resume API

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/editor-server.mjs`
- Test: `~/Downloads/resume-builder/scripts/editor-server.test.mjs`

**Endpoints:**

- `GET /api/resume`
- `PUT /api/resume`

**Step 1:** Write failing API tests.

**Step 2:** Implement JSON body parsing with a concrete `5MB` maximum and `413 Payload Too Large` response.

**Step 3:** Implement API using `loadResumeYaml`, `saveResumeYaml`, and `validateResume`.

**Step 4:** Run tests.

Expected: valid data saves, invalid data returns JSON error and does not overwrite YAML.

### Task 4: Implement Generate API

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/editor-server.mjs`
- Test: `~/Downloads/resume-builder/scripts/editor-server.test.mjs`

**Endpoint:**

- `POST /api/generate`

**Step 1:** Write failing API test.

**Step 2:** Call `generateResume()`.

**Step 3:** Return density, metrics, and output paths.

**Step 4:** Run tests and a manual `npm run editor` check.

### Task 5: Implement Example API

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/editor-server.mjs`
- Test: `~/Downloads/resume-builder/scripts/editor-server.test.mjs`

**Endpoints:**

- `GET /api/examples`
- `POST /api/load-example`

**Step 1:** Write failing tests for listing and loading examples.

**Step 2:** Implement allowlisted example IDs only: `cpp`, `ai-agent`.

**Step 3:** Save selected example into `resume.yaml`.

**Step 4:** Run tests.

### Task 6: Implement Photo API

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/editor-server.mjs`
- Test: `~/Downloads/resume-builder/scripts/editor-server.test.mjs`

**Endpoint:**

- `POST /api/photo`

**Step 1:** Write failing tests for supported and unsupported files.

**Step 2:** Parse JSON data URL.

**Step 3:** Enforce the `5MB` request body limit and decoded image byte limit.

**Step 4:** Decode and write into `assets/`.

**Step 5:** Update `profile.photo` and save YAML.

**Step 6:** Run tests.

### Task 7: Build Static Editor Shell

**Files:**

- Create: `~/Downloads/resume-builder/editor/index.html`
- Create: `~/Downloads/resume-builder/editor/styles.css`
- Create: `~/Downloads/resume-builder/editor/app.js`
- Modify: `~/Downloads/resume-builder/scripts/editor-server.mjs`

**Step 1:** Serve static files from `/editor/`.

**Step 2:** Build the app shell:

```text
left preview | right editor panel
```

**Step 3:** Show output PNG in the left preview.

**Step 4:** Add right panel module selector.

**Step 5:** Keep UI dense, utilitarian, and document-focused.

### Task 8: Build Editor Forms

**Files:**

- Modify: `~/Downloads/resume-builder/editor/app.js`
- Modify: `~/Downloads/resume-builder/editor/index.html`
- Modify: `~/Downloads/resume-builder/editor/styles.css`

**Step 1:** Load resume data from `GET /api/resume`.

**Step 2:** Render profile form.

**Step 3:** Render internship form with bullet controls.

**Step 4:** Render skills form with group and bullet controls.

**Step 5:** Render projects form with bullet controls.

**Step 6:** Render layout order controls.

**Step 7:** Serialize draft state to `PUT /api/resume`.

### Task 9: Wire Actions And Status

**Files:**

- Modify: `~/Downloads/resume-builder/editor/app.js`
- Modify: `~/Downloads/resume-builder/editor/styles.css`

**Step 1:** Implement dirty/saved/generated status.

**Step 2:** Wire `保存` to `PUT /api/resume`.

**Step 3:** Wire `生成 PDF` to `POST /api/generate`.

**Step 4:** Refresh preview image with a cache-busting query string.

**Step 5:** Wire example loading with confirmation.

**Step 6:** Wire photo replacement.

### Task 10: Final Verification

**Files:**

- Modify: `~/Downloads/resume-builder/README.md`

**Step 1:** Document:

```bash
npm run editor
```

**Step 2:** Run:

```bash
npm test
npm run generate
```

**Step 3:** Start editor:

```bash
npm run editor
```

**Step 4:** Manual browser verification:

- Load page.
- Edit one profile field.
- Save.
- Generate PDF.
- Confirm preview refresh.
- Restore the edited field.
- Load C++ example.
- Load AI Agent example.
- Replace photo with a test image.

**Step 5:** Verify final PDF:

```bash
pdfinfo output/resume.pdf
```

Expected: `Pages: 1`, `Page size: 595.92 x 842.88 pts (A4)`.

## 11. Follow-Up Decisions

Defer these until after v1 works:

- Whether to add live HTML preview before manual PDF generation.
- Whether to support drag-and-drop for section and bullet ordering.
- Whether to add a visual overflow heatmap by section.
- Whether to support multiple saved resume files.
- Whether to add AI-assisted rewriting.
- Whether to package as a desktop app.
