# Resume Builder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local resume generator that lets the user edit only structured resume content and produces a one-page PDF matching the provided resume's information structure and visual density.

**Architecture:** Keep content, template, and generation separate. `resume.yaml` stores the resume content, HTML/CSS owns layout, and a Node.js generator renders the template through Playwright, measures whether it fits one page, chooses the loosest valid density profile, then exports PDF and PNG verification artifacts.

**Tech Stack:** Node.js, npm, js-yaml, Playwright/Chromium, HTML/CSS print layout, Poppler `pdfinfo`/`pdftoppm`.

---

## 1. Background

The source resume is a one-page PDF:

- File: `/path/to/source-resume.pdf`
- Page count: 1
- Page size: about `595.44 x 892.8 pt`; this is not standard A4 height and should not be copied for v0 output
- Source toolchain: Word 2016, then processed by ilovepdf
- Visual structure: top profile block with right-side photo, then `专业技能`, `实习经历`, `项目经历`
- Current density: already close to the single-page limit
- Current PDF issue to avoid: mixed fonts and Symbol bullets can render as square-like marks on some machines

The goal is not to edit the PDF directly. The PDF is treated as a visual and structural reference. The maintainable source of truth should be a content file plus a stable template.

## 2. Product Boundary

v0 must stay narrow.

In scope:

- One local folder under `~/Downloads/resume-builder`
- One editable content file: `resume.yaml`
- Fixed right-top photo module
- Placeholder photo for v0, later replaceable by the user
- One output PDF: `output/resume.pdf`
- One HTML preview: `output/preview.html`
- One rendered PNG check: `output/resume.png`
- Automatic layout fitting through limited density profiles

Out of scope for v0:

- GUI app
- Online deployment
- Word/docx export
- Multiple resume templates
- Multi-page resume
- AI content rewriting
- Drag-and-drop editing
- Optional modules that are not in the provided PDF

## 3. User Workflow

The intended daily workflow is:

```bash
cd ~/Downloads/resume-builder
./generate
```

Then check:

```text
output/resume.pdf
output/resume.png
```

To edit content, the user modifies only:

```text
~/Downloads/resume-builder/resume.yaml
```

To replace the photo later, the user replaces the file referenced by:

```yaml
profile:
  photo: assets/photo.svg
```

The template and generator are implementation details. The user should not need to edit them for normal resume content changes.

## 4. Directory Layout

```text
~/Downloads/resume-builder/
  generate
  resume.yaml
  README.md
  assets/
    photo.svg
  package.json
  package-lock.json
  scripts/
    generate.mjs
    render.test.mjs
  templates/
    resume.html
    resume.css
  output/
    resume.pdf
    preview.html
    resume.png
  docs/
    plans/
      2026-07-08-resume-builder.md
```

## 5. Content Schema

`resume.yaml` should mirror the source PDF structure. Do not generalize v0 beyond the current resume.

Top-level fields:

```yaml
profile:
  name: 测试候选人
  target: C++开发工程师
  school: 示例大学（应届生）
  major: 计算机科学与技术
  phone: 000-0000-0000
  email: candidate@example.com
  photo: assets/photo.svg

skills:
  - title: C/C++编程
    items: []
  - title: 操作系统/Linux 系统编程
    items: []
  - title: 计算机网络/Linux 网络编程
    items: []

internships:
  - start: 2025.08
    end: 至今
    organization: 示例科技有限公司
    role: 软件开发实习生
    summary: ""
    items: []
    linkLabel: 项目代码链接
    link: https://example.com/resume-project

projects:
  - start: 2025.04
    end: 2025.07
    name: 并发内存池实验
    role: 后端开发
    summary: 基于Google 开源项目 tcmalloc 的简化版设计与实现
    items: []
    linkLabel: 项目代码链接
    link: https://example.com/project
```

Rules:

- The generator validates required fields before rendering.
- Empty lists are allowed during early editing but should produce warnings.
- v0 does not support arbitrary extra sections.
- v0 does not rewrite, shorten, or delete user content.

## 6. Rendering Design

The render flow is:

```text
resume.yaml
  -> parse and validate
  -> render template HTML
  -> inject density profile CSS variables
  -> Playwright page measurement
  -> choose first fitting density profile
  -> write output/preview.html
  -> export output/resume.pdf
  -> render output/resume.png
  -> report selected density and warnings
```

YAML parsing:

- Use `js-yaml` from npm.
- Do not invoke another language runtime from Node for YAML parsing.
- The project owns its dependencies in `package.json`; first-time setup is `npm install`.
- If dependencies are missing, the generator should fail with a clear `npm install` message.

Page size:

- Generate standard A4 output, not the source PDF's non-standard page height.
- CSS should use `@page { size: A4; margin: 0; }`.
- Playwright PDF export should use `{ format: "A4", printBackground: true }`.
- Because standard A4 is shorter than the source PDF, the density profiles must fit the content into true A4.

Fonts and symbols:

- Avoid Word/Symbol bullets.
- Use CSS-controlled bullets or a stable bullet character.
- Use a stable Chinese font stack available on macOS first, with fallbacks.
- Keep PDF output visually stable by avoiding unembedded special symbol fonts.

## 7. Automatic Fit Policy

Single-page output is a hard constraint.

The generator should try density profiles in order and choose the loosest profile that fits:

```js
normal  -> compact -> tight
```

Example profile dimensions:

```text
normal:
  bodyFontSize: 10.8pt
  bodyLineHeight: 1.38
  itemGap: 3px
  sectionGap: 8px

compact:
  bodyFontSize: 10.5pt
  bodyLineHeight: 1.32
  itemGap: 2px
  sectionGap: 6px

tight:
  bodyFontSize: 10.2pt
  bodyLineHeight: 1.25
  itemGap: 1px
  sectionGap: 4px
```

Lower bounds:

- Body text must not go below `10.2pt`
- Experience header text must not go below `11.5pt`
- Section title text must not go below `13pt`
- Line height must not go below `1.25`
- List spacing must not go below `1px`

The generator may adjust:

- Body font size
- Body line height
- Section gap
- List item gap
- Experience header gap
- Bullet indent
- Link wrapping

The generator must not:

- Delete content
- Rewrite content
- Hide low-priority bullets
- Add a second page
- Keep shrinking text after the `tight` profile fails

If all profiles fail, output a clear error:

```text
Content does not fit one page after tight profile.
Overflow: 38px.
Suggestion: shorten the longest section or reduce 1-2 bullet items.
```

## 8. Measurement and Validation

Before PDF export:

- Render HTML in Playwright using standard A4 page dimensions.
- Measure the resume container height.
- Detect horizontal overflow.
- Detect whether any section bottom exceeds page bottom.
- Choose the loosest valid density profile.

After PDF export:

- Run `pdfinfo output/resume.pdf` and assert `Pages: 1`.
- Render with `pdftoppm` to `output/resume.png`.
- The final check is visual: inspect `output/resume.png` for spacing, clipping, and readability.

## 9. Error Handling

The generator should fail early for:

- Missing `resume.yaml`
- Invalid YAML
- Missing required profile fields
- Missing photo file
- Unsupported top-level sections
- No density profile fits in one page
- Playwright unavailable
- npm dependencies unavailable; run `npm install`
- Poppler unavailable for PNG verification

Warnings should not block output when:

- A section item list is empty
- A link is very long but still wraps correctly
- Placeholder photo is still being used

## 10. Implementation Plan

### Task 1: Scaffold Project

**Files:**

- Create: `~/Downloads/resume-builder/generate`
- Create: `~/Downloads/resume-builder/package.json`
- Create: `~/Downloads/resume-builder/README.md`
- Create: `~/Downloads/resume-builder/assets/photo.svg`
- Create: `~/Downloads/resume-builder/scripts/generate.mjs`
- Create: `~/Downloads/resume-builder/scripts/render.test.mjs`
- Create: `~/Downloads/resume-builder/templates/resume.html`
- Create: `~/Downloads/resume-builder/templates/resume.css`
- Create: `~/Downloads/resume-builder/output/.gitkeep`

**Steps:**

1. Create the directory structure.
2. Add `package.json` with `scripts.generate`, `scripts.test`, and dependencies `js-yaml` and `playwright`.
3. Add an executable `generate` wrapper that calls `node scripts/generate.mjs`.
4. Add a placeholder `photo.svg` with fixed portrait aspect ratio.
5. Add `README.md` with the v0 workflow and `npm install` setup.
6. Do not implement rendering yet.

**Verify:**

```bash
find ~/Downloads/resume-builder -maxdepth 3 -type f | sort
```

Expected: all files above exist.

### Task 2: Create Resume Data

**Files:**

- Create: `~/Downloads/resume-builder/resume.yaml`

**Steps:**

1. Transcribe the current PDF content into `resume.yaml`.
2. Keep the same module order as the PDF.
3. Keep the right-top photo path as `assets/photo.svg`.
4. Do not add optional modules.

**Verify:**

```bash
npm test
```

Expected: YAML parsing tests include top-level keys `profile`, `skills`, `internships`, `projects`.

### Task 3: Implement YAML Loading with js-yaml and Validation

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/generate.mjs`
- Modify: `~/Downloads/resume-builder/scripts/render.test.mjs`

**Steps:**

1. Write Node tests for required-field validation.
2. Write Node tests for invalid YAML, unsupported top-level sections, and missing photo paths.
3. Implement `loadResumeYaml(path)` with `js-yaml`.
4. Implement `validateResume(data)` with specific error messages.
5. Run tests and fix until validation passes.

**Verify:**

```bash
npm test
```

Expected: all validation tests pass.

### Task 4: Implement HTML Rendering

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/generate.mjs`
- Modify: `~/Downloads/resume-builder/templates/resume.html`
- Modify: `~/Downloads/resume-builder/templates/resume.css`
- Modify: `~/Downloads/resume-builder/scripts/render.test.mjs`

**Steps:**

1. Add HTML escaping tests.
2. Add render tests for profile, section titles, skills, internships, projects, and links.
3. Implement a small renderer that injects resume data into HTML.
4. Keep template structure fixed to the PDF.
5. Use CSS variables for density-controlled values.

**Verify:**

```bash
npm test
```

Expected: renderer tests pass.

### Task 5: Implement A4 Density Selection

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/generate.mjs`
- Modify: `~/Downloads/resume-builder/templates/resume.css`

**Steps:**

1. Define `normal`, `compact`, and `tight` density profiles.
2. Render each profile in Playwright with standard A4 dimensions.
3. Measure page height and horizontal overflow.
4. Pick the first fitting profile.
5. If none fit, throw a one-page overflow error with approximate overflow pixels and a general suggestion. Do not promise exact section attribution.

**Verify:**

```bash
~/Downloads/resume-builder/generate
```

Expected: console prints selected density profile and writes `output/preview.html`.

### Task 6: Export A4 PDF and PNG

**Files:**

- Modify: `~/Downloads/resume-builder/scripts/generate.mjs`
- Modify: `~/Downloads/resume-builder/generate`

**Steps:**

1. Export standard A4 `output/resume.pdf` from the selected Playwright page.
2. Run `pdfinfo` and assert page count is 1.
3. Run `pdftoppm` to create `output/resume.png`.
4. Surface Poppler errors clearly if PNG generation fails, including `brew install poppler` guidance.

**Verify:**

```bash
pdfinfo ~/Downloads/resume-builder/output/resume.pdf
```

Expected: `Pages: 1`.

### Task 7: Visual Review and First Tuning Pass

**Files:**

- Modify: `~/Downloads/resume-builder/templates/resume.css`
- Modify: `~/Downloads/resume-builder/scripts/generate.mjs` if density values need changes

**Steps:**

1. Open or inspect `output/resume.png`.
2. Compare against the source PDF screenshot.
3. Tune margins, title bar height, section gaps, bullet indent, and link styling.
4. Regenerate after each meaningful change.
5. Stop when the output is readable, one page, and close to the original visual density.

**Verify:**

```bash
~/Downloads/resume-builder/generate
```

Expected:

- `output/resume.pdf` is one page.
- `output/resume.png` has no clipped text.
- Bullet symbols do not render as squares.
- Long links wrap or fit without horizontal overflow.

### Task 8: README Finalization

**Files:**

- Modify: `~/Downloads/resume-builder/README.md`

**Steps:**

1. Document how to edit `resume.yaml`.
2. Document how to replace the placeholder photo.
3. Document how to generate PDF.
4. Document what to do if content does not fit one page.
5. Document v0 non-goals so future changes do not accidentally expand scope.

**Verify:**

```bash
sed -n '1,220p' ~/Downloads/resume-builder/README.md
```

Expected: README is enough for the user to edit content and regenerate the PDF without reading implementation code.

## 11. Completion Criteria

v0 is complete only when:

- `resume.yaml` contains the current PDF content.
- `./generate` completes successfully.
- `output/resume.pdf` exists.
- `output/resume.pdf` is exactly one page.
- `output/resume.png` exists.
- The rendered PNG is visually readable and close to the source PDF structure.
- The chosen density profile is reported.
- No content is silently deleted or rewritten.
- Missing dependencies and overflow cases produce clear errors.

## 12. Future Work

Only consider these after v0 is visually acceptable:

- Replace placeholder photo with a real portrait.
- Tune density profile values based on real output.
- Add a tiny local preview server.
- Add schema comments or examples inside `resume.yaml`.
- Add optional sections if the resume actually needs them.
- Add an app-like editor if editing YAML becomes a real friction point.
