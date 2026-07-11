# V2.4 Limited Layout Controls Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add bounded per-resume layout controls with deterministic automatic A4 fitting, exact fixed mode, live draft feedback and matching formal PDF output.

**Architecture:** A pure `scripts/layout-settings.mjs` module owns defaults, validation, interpolation, CSS variables and ordered candidates. The preview API and Playwright generator both consume that module; the browser only applies returned candidates and measures the iframe. Existing YAML remains compatible, while the editor materializes defaults only after an explicit layout edit and save.

**Tech Stack:** Node.js ESM, `node:test`, `js-yaml`, built-in HTTP server, vanilla HTML/CSS/JavaScript, Playwright, Poppler.

**Development workflow:** Implement on `feature/v2.4-layout-controls` in the existing checkout, as explicitly chosen for this personal project. Do not create another worktree. Use TDD and commit after every task.

---

### Task 1: Build The Shared Layout Settings Engine

**Files:**
- Create: `scripts/layout-settings.mjs`
- Create: `scripts/layout-settings.test.mjs`
- Modify: `package.json:10`

**Step 1: Write failing tests for defaults and exact validation**

Create tests that import the planned public API:

```js
import {
  DEFAULT_LAYOUT_SETTINGS,
  resolveLayoutSettings,
  validateLayoutSettings
} from "./layout-settings.mjs";

test("layout settings resolve backward-compatible defaults", () => {
  assert.deepEqual(resolveLayoutSettings({}), DEFAULT_LAYOUT_SETTINGS);
});

test("layout settings accept bounded values", () => {
  assert.deepEqual(validateLayoutSettings({
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  }), {
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  });
});
```

Add table-driven rejection tests for unknown keys, invalid enums, non-finite values, values outside the design bounds, non-integer spacing levels and values that do not align to the `0.1pt` / `0.01` steps.

**Step 2: Run the new test to verify it fails**

Run:

```bash
node --test scripts/layout-settings.test.mjs
```

Expected: FAIL because `scripts/layout-settings.mjs` does not exist.

**Step 3: Implement defaults and validation**

Create the module with frozen constants:

```js
export const DEFAULT_LAYOUT_SETTINGS = Object.freeze({
  mode: "auto",
  fontSizePt: 10.8,
  lineHeight: 1.38,
  spacingLevel: 67,
  marginPreset: "normal"
});

export const LAYOUT_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_LAYOUT_SETTINGS));

export function resolveLayoutSettings(layout = {}) {
  return validateLayoutSettings({ ...DEFAULT_LAYOUT_SETTINGS, ...layout });
}
```

Use integerized comparisons (`fontSizePt * 10`, `lineHeight * 100`) rather than floating-point remainder checks. Keep all error messages path-free and stable, such as `layout.fontSizePt must be between 10.2 and 11.2 in 0.1 steps`.

**Step 4: Write failing interpolation and candidate tests**

Cover exact spacing anchors:

```js
assert.deepEqual(spacingVariables(0), {
  "--item-gap": "1px",
  "--section-gap": "4px",
  "--experience-gap": "3px",
  "--bullet-indent": "14px"
});

assert.deepEqual(spacingVariables(50), {
  "--item-gap": "2px",
  "--section-gap": "6px",
  "--experience-gap": "4px",
  "--bullet-indent": "15px"
});
```

Use anchors `0`, `50`, `67`, `100`, with relaxed values `4px / 10px / 6px / 17px`. Test interpolation on both sides of `67`, rounded to at most two decimals.

Test margin mappings and proportional typography variables for the four hard-coded resume sizes:

```js
assert.equal(vars["--body-size"], "10.8pt");
assert.equal(vars["--profile-size"], "12.3pt");
assert.equal(vars["--section-title-size"], "14pt");
assert.equal(vars["--skill-title-size"], "12.6pt");
assert.equal(vars["--experience-title-size"], "13pt");
```

Test candidate invariants:

- Preferred candidate is first.
- Auto candidates reduce spacing, then margins, then line height, then font size.
- Candidates are unique and monotonic within each phase.
- Hard minimum `10.2 / 1.25 / 0 / narrow` is last.
- Fixed mode returns exactly one candidate.

**Step 5: Implement interpolation, CSS variables and candidates**

Export:

```js
export function spacingVariables(level) {}
export function cssVariablesForLayout(settings) {}
export function buildLayoutCandidates(layout) {}
export function publicLayoutCandidate(candidate) {}
```

Candidate objects contain normalized numeric values plus a `cssVariables` object. Generate spacing levels by including the preferred value and lower anchors, then bounded 5-point steps without duplicates. Generate line height in `0.01` steps and font size in `0.1pt` steps. Do not build a Cartesian product; preserve the approved phase order.

**Step 6: Add the new test file to the complete test command**

Add `scripts/layout-settings.test.mjs` to the first `node --test` group in `package.json`.

**Step 7: Run focused and complete non-browser tests**

Run:

```bash
node --test scripts/layout-settings.test.mjs scripts/render.test.mjs
```

Expected: PASS.

**Step 8: Commit**

```bash
git add package.json scripts/layout-settings.mjs scripts/layout-settings.test.mjs
git commit -m "feat: add bounded layout settings engine"
```

---

### Task 2: Validate Per-Resume YAML Without Breaking Old Files

**Files:**
- Modify: `scripts/resume-data.mjs:1-183`
- Modify: `scripts/render.test.mjs:190-225`
- Test: `scripts/layout-settings.test.mjs`

**Step 1: Write failing resume validation tests**

Add tests proving:

- A layout containing only `sectionOrder` remains valid.
- All new fields are accepted together.
- Missing new fields do not mutate or materialize the input object.
- Unknown `layout` fields are rejected.
- Invalid mode, range, step and margin values are rejected with stable field names.
- `resolveResumeLayout(data)` returns a full settings object without modifying `data`.

Example:

```js
const data = structuredClone(validResume);
data.layout = { sectionOrder: ["internships", "skills", "projects"] };
validateResume(data, dir);
assert.deepEqual(data.layout, { sectionOrder: ["internships", "skills", "projects"] });
assert.equal(resolveResumeLayout(data).fontSizePt, 10.8);
```

**Step 2: Run tests and verify failure**

Run:

```bash
node --test scripts/render.test.mjs
```

Expected: FAIL because new layout fields and `resolveResumeLayout` are not implemented.

**Step 3: Integrate the shared validator**

Import `LAYOUT_SETTING_KEYS` and `resolveLayoutSettings`. Change `validateLayout` so allowed keys are exactly `sectionOrder` plus the shared setting keys. Continue validating complete section order separately, then validate only the present setting fields merged over defaults.

Export:

```js
export function resolveResumeLayout(data) {
  return resolveLayoutSettings(data?.layout || {});
}
```

Do not make `validateResume` write defaults into loaded YAML.

**Step 4: Run focused tests**

Run:

```bash
node --test scripts/layout-settings.test.mjs scripts/render.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/resume-data.mjs scripts/render.test.mjs
git commit -m "feat: validate per-resume layout preferences"
```

---

### Task 3: Convert The Resume Template To Explicit Layout Variables

**Files:**
- Modify: `templates/resume.css:6-48,69-186`
- Modify: `scripts/generate.mjs:31-267`
- Modify: `scripts/render.test.mjs:230-360`

**Step 1: Write failing HTML and CSS tests**

Add tests asserting that rendered HTML can embed a candidate's variables and that the CSS uses variables instead of fixed typography values:

```js
const candidate = buildLayoutCandidates({ mode: "fixed" })[0];
const html = renderResumeHtml(data, { layoutCandidate: candidate, cssText });
assert.match(html, /--body-size:\s*10\.8pt/);
assert.match(html, /--page-x:\s*8mm/);
assert.match(html, /data-layout-mode="fixed"/);
```

Assert the template defines and consumes `--profile-size`, `--section-title-size`, `--skill-title-size` and `--experience-title-size`.

Keep one compatibility test for `data-density`, but allow the value `custom`; existing generated files and selectors must not break during migration.

**Step 2: Run tests and verify failure**

Run:

```bash
node --test scripts/render.test.mjs
```

Expected: FAIL because layout candidates are not embedded and CSS still hard-codes typography.

**Step 3: Replace density-specific CSS with variables**

Keep current values as `:root` defaults. Remove the three `body[data-density]` variable blocks after their anchor values are protected by Task 1 tests. Add:

```css
--profile-size: 12.3pt;
--section-title-size: 14pt;
--skill-title-size: 12.6pt;
--experience-title-size: 13pt;
```

Replace the corresponding hard-coded declarations. Continue to use `--page-x`, `--page-y`, `--body-line-height`, gap and indent variables.

**Step 4: Teach HTML rendering to embed a selected candidate**

Replace `densityStyle(profile)` with a general CSS variable serializer that accepts only trusted shared-module output. Extend `renderResumeHtml` with `layoutCandidate`; inject a root-level style block or body style before content. Add `data-layout-mode` and keep `data-density` as a compatibility label (`normal`, `compact`, `tight` for exact legacy anchors, otherwise `custom`).

**Step 5: Run render tests**

Run:

```bash
node --test scripts/layout-settings.test.mjs scripts/render.test.mjs
```

Expected: PASS with existing click markers, escaping and section order tests unchanged.

**Step 6: Commit**

```bash
git add templates/resume.css scripts/generate.mjs scripts/render.test.mjs
git commit -m "refactor: render resumes from layout variables"
```

---

### Task 4: Replace Density Selection With Shared Candidate Measurement

**Files:**
- Modify: `scripts/generate.mjs:248-414`
- Modify: `scripts/render.test.mjs:40-120,360-end`

**Step 1: Extend the Playwright harness and write failing selection tests**

Change the fake page so `evaluate` returns metrics from a queue and records applied CSS variables. Add tests that prove:

- Auto mode selects the first fitting shared candidate.
- Fixed mode measures once and does not compress.
- Exhausted auto mode reports effective minima and exact overflow.
- Fixed overflow reports exact fixed values.
- Overflow occurs before any output file is replaced.
- The selected generated HTML contains the same variables as the measured candidate.
- One browser page is reused across candidates.

**Step 2: Run focused generation tests and verify failure**

Run:

```bash
node --test scripts/render.test.mjs
```

Expected: FAIL because generation still iterates `DENSITY_PROFILES` and creates one page per profile.

**Step 3: Implement single-page candidate measurement**

Create one page, set content and CSS once, then for each candidate apply variables and wait one animation frame before evaluating metrics. Return:

```js
{
  candidate,
  metrics,
  verticalOverflow,
  horizontalOverflow,
  overflow
}
```

Close the page in every success and failure path. Preserve the existing `2px` tolerance.

**Step 4: Stage output before publication**

Generate preview HTML, PDF and PNG under unique temporary filenames inside the resume output directory. Verify the staged PDF and PNG before renaming the three files to their final names. At minimum, fitting, PDF verification and PNG rendering failures must leave existing final outputs unchanged. Clean only staging files created by this generation attempt.

Do not delete or rewrite unrelated output entries.

**Step 5: Return effective metadata while preserving compatibility**

Return:

```js
{
  resumeId,
  density: compatibilityDensity(candidate),
  layout: publicLayoutCandidate(candidate),
  metrics,
  overflow: { vertical: 0, horizontal: 0, total: 0 },
  outputPaths
}
```

Console output should print mode and effective values, not only a density name.

**Step 6: Run focused tests**

Run:

```bash
node --test scripts/layout-settings.test.mjs scripts/render.test.mjs
```

Expected: PASS.

**Step 7: Commit**

```bash
git add scripts/generate.mjs scripts/render.test.mjs
git commit -m "feat: fit A4 using shared layout candidates"
```

---

### Task 5: Return Layout Candidates From Preview And Generation APIs

**Files:**
- Modify: `scripts/editor-server.mjs:621-685`
- Modify: `scripts/editor-server.test.mjs:1810-1870,2680-2720`

**Step 1: Write failing API tests**

For `POST /api/preview`, assert the response contains:

```js
{
  ok: true,
  resumeId: "cpp",
  html: "...",
  layout: {
    mode: "auto",
    candidates: [/* public candidate records */]
  }
}
```

Assert fixed mode returns one candidate, invalid settings return `400`, and the response contains no absolute paths.

For `POST /api/generate`, update the injected generator result and assert effective layout plus overflow metadata is forwarded while existing output URLs and `density` remain available.

**Step 2: Run API tests and verify failure**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=60000 scripts/editor-server.test.mjs
```

Expected: FAIL because the APIs do not expose layout metadata.

**Step 3: Implement preview metadata**

After validating the draft resume, call `buildLayoutCandidates(resolveResumeLayout(resume))`. Render the preferred candidate into the returned HTML and serialize candidates through `publicLayoutCandidate`. Do not return internal filesystem data or untrusted CSS keys.

**Step 4: Forward formal generation metadata**

Extend `handleGenerateApi` without removing existing response fields. Return effective layout and structured overflow from `generateResume`.

**Step 5: Run focused server tests**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=60000 scripts/editor-server.test.mjs
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/editor-server.mjs scripts/editor-server.test.mjs
git commit -m "feat: expose effective layout metadata"
```

---

### Task 6: Build The Layout Settings Editor

**Files:**
- Modify: `editor/app.js:1-220,1413-1665,1860-1880,2489-2510`
- Modify: `editor/styles.css:409-867`
- Modify: `scripts/editor-server.test.mjs:930-1165,1410-1495`

**Step 1: Write failing browser tests for the panel**

Add browser tests that:

- See top-level labels `内容编辑` and `排版设置`.
- Open the layout area and see auto/fixed controls, four bounded settings, restore defaults and section order.
- Use range inputs and `-` / `+` buttons with correct labels and disabled boundary states.
- Change settings and observe dirty state plus a draft preview request containing the new YAML.
- Restore defaults without changing profile or resume content.
- Switch resumes and observe independent layout values.
- Duplicate a resume and retain layout values.
- Keep controls usable with keyboard navigation.

**Step 2: Run the focused browser tests and verify failure**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=60000 scripts/editor-server.test.mjs
```

Expected: FAIL because the layout panel only renders section ordering.

**Step 3: Materialize defaults only for editor state**

Change `ensureLayout` to add missing editor defaults in memory while preserving existing section order. This is allowed because the server-loaded object is a draft copy; no file is written until save.

Track:

```js
state.layoutCandidates = [];
state.effectiveLayout = null;
state.layoutOverflow = null;
```

Reset those fields when loading or switching resumes.

**Step 4: Render accessible controls**

Rename the area label to `排版设置`. Extend `renderLayout` with:

- Two-button segmented mode control.
- Range inputs with fixed `min`, `max` and `step`.
- Read-only current-value output.
- Familiar minus and plus buttons with precise `aria-label` values.
- Four compactness anchor labels.
- Three-button margin segmented control.
- Restore-default command.
- Existing order rows below a divider.

Use stable responsive grid dimensions. Do not put the page section inside nested cards.

**Step 5: Handle layout actions and inputs**

Use `data-layout-field`, `data-layout-value` and explicit actions. Convert range values to numbers before assigning. Clamp steppers to bounds. Every real change calls `markDirty()` exactly once and schedules the existing draft preview. Re-render while preserving focus by field/action identifier.

**Step 6: Add restrained styles**

Use existing panel, line, text and accent tokens. Keep compact headings consistent with other modules. Add visible `:focus-visible`, disabled and selected states. At narrow widths, stack labels and controls without horizontal page scrolling; the footer remains visible.

**Step 7: Run focused editor tests**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=60000 scripts/editor-server.test.mjs
```

Expected: PASS.

**Step 8: Commit**

```bash
git add editor/app.js editor/styles.css scripts/editor-server.test.mjs
git commit -m "feat: add per-resume layout controls"
```

---

### Task 7: Apply Draft Candidates And Enforce The Overflow Gate

**Files:**
- Modify: `editor/app.js:315-420,1413-1460,2157-2185,2539-2565`
- Modify: `editor/index.html:42-49`
- Modify: `scripts/editor-server.test.mjs:940-1120,1400-1510`

**Step 1: Write failing draft fitting tests**

Mock preview responses with two public candidates and browser measurements so tests prove:

- Candidate CSS variables are applied in order.
- The first fitting candidate becomes `state.effectiveLayout`.
- Fixed mode applies one candidate only.
- All-candidate overflow reports exact total pixels.
- A stale preview response cannot replace newer layout state.
- Saved overflow keeps Save available but disables Generate.
- Returning to a fitting draft enables Generate after save.
- The status strip reports effective values and does not always claim `A4 单页`.
- Formal generation response replaces draft effective metadata with authoritative server metadata.

**Step 2: Run focused browser tests and verify failure**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=60000 scripts/editor-server.test.mjs
```

Expected: FAIL because draft fitting still cycles density names and the status always says `A4 单页`.

**Step 3: Replace density cycling with candidate application**

Store candidates from the latest `/api/preview` response. For each candidate, set only allowlisted CSS variables on the iframe document root, wait one animation frame and call the existing measurement function. Save structured effective layout and overflow state.

Remove `draftDensityNames`. Keep `fitTolerancePx` and the existing preview generation counter.

**Step 4: Render truthful status and generation state**

Render an effective summary such as:

```text
自动 · 10.5pt · 行距 1.32 · 紧凑 · 标准边距
```

Render either `A4 单页` or `超出 A4 38px`. Disable Generate when dirty, busy, generating or the current saved draft is known to overflow. Keep Save enabled for overflowing drafts.

Update the initial static status in `editor/index.html` so it does not incorrectly claim a fit before data loads.

**Step 5: Use authoritative generation metadata**

After successful generation, set `state.effectiveLayout` from the response, clear overflow, refresh generated preview and keep the compatibility density only for old API fallback.

**Step 6: Run focused editor tests**

Run:

```bash
node --test --test-concurrency=1 --test-timeout=60000 scripts/editor-server.test.mjs
```

Expected: PASS.

**Step 7: Commit**

```bash
git add editor/app.js editor/index.html scripts/editor-server.test.mjs
git commit -m "feat: report and gate A4 layout overflow"
```

---

### Task 8: Document Boundaries And Verify The Release Candidate

**Files:**
- Create: `docs/v2-4-boundaries.md`
- Create: `docs/v2-4-acceptance-checklist.md`
- Modify: `README.md:43-65,110-135`
- Modify: `docs/plans/2026-07-11-v2-4-layout-controls-design.md:1-209`
- Modify only if verification exposes defects: files touched by Tasks 1-7

**Step 1: Write boundary and acceptance documents**

Document:

- Per-resume settings and backward compatibility.
- Auto versus fixed behavior and exact ranges.
- Spacing anchors rather than misleading percentages.
- Save allowed versus formal generation blocked on overflow.
- A4, photo, template and local-data boundaries.
- Explicit non-goals.
- Safe fictional-data manual setup.
- Desktop and narrow acceptance matrix.

Mark the design status implemented only after all verification passes. Add both documents and the implementation plan to README.

**Step 2: Run formatting and privacy gates**

Run:

```bash
git diff --check
npm run privacy:check
```

Expected: both PASS with no personal paths or data.

**Step 3: Run the complete automated suite**

Run:

```bash
TZ=UTC npm test
```

Expected: all tests pass with no failures, cancellations or skips.

**Step 4: Generate every registered fictional fixture**

Use a temporary external data root containing at least:

- An old YAML with only `sectionOrder`.
- Auto mode that fits at its preferred values.
- Auto mode that requires each compression phase.
- Fixed mode that fits.
- Fixed mode that overflows.
- Two resumes with visibly different settings.

Run the editor and formal generation. Confirm every successful PDF is standard one-page A4 with no text clipping, broken links or displaced photo.

**Step 5: Perform browser visual acceptance**

At desktop and representative narrow widths, confirm:

- The entire A4 preview remains visible within its pane.
- The right panel and sticky footer do not overlap.
- Long labels and values do not overflow controls.
- Range and segmented controls have stable dimensions and keyboard focus.
- Draft effective values match formal generation values.
- Overflow status is visible and Generate is unavailable while Save remains available.
- Click-to-edit markers and preview selection backgrounds still work.

Use Playwright screenshots for evidence. Do not use personal resume data for screenshots.

**Step 6: Re-run the complete gate after any verification fix**

Run:

```bash
TZ=UTC npm test
git diff --check
git status --short
```

Expected: complete PASS and only intended source/document changes.

**Step 7: Commit release documentation and any verified fixes**

```bash
git add README.md docs/v2-4-boundaries.md docs/v2-4-acceptance-checklist.md docs/plans/2026-07-11-v2-4-layout-controls-design.md
git commit -m "docs: define V2.4 layout control boundaries"
```

If verification required code fixes, commit those separately before the documentation commit with a focused `fix:` message.

**Step 8: Prepare integration**

Confirm the branch is clean and ahead of `main`. Do not merge, push, create a PR or delete the branch without presenting the final verification evidence and receiving the user's choice.
