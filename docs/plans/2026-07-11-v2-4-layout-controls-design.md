# Resume Builder V2.4 Limited Layout Controls Design

Date: 2026-07-11

Status: Implemented and verified on 2026-07-11.

## Summary

V2.4 adds constrained per-resume layout controls to the existing local editor. The default workflow remains automatic one-page A4 fitting. Users may also lock exact values and receive an overflow error instead of allowing the renderer to keep shrinking content.

The feature extends the existing single template. It does not add template selection, per-section typography, free-form CSS, color themes, multi-page output or Word export.

## Goals

- Keep automatic one-page A4 fitting as the default.
- Let every resume store independent preferred layout settings.
- Expose only bounded global typography, spacing and margin controls.
- Preserve and generalize the previous `normal -> compact -> tight` one-page fitting capability.
- Keep draft preview and formal PDF generation on the same candidate-building rules.
- Report the effective values and total overflow without silently rewriting YAML.
- Preserve all current multi-resume, backup, import/export, recovery and privacy behavior.

## Non-Goals

V2.4 does not provide:

- Per-section, per-card or per-bullet font and spacing overrides.
- Editable photo dimensions or arbitrary page dimensions.
- Drag-and-drop ordering, collapsing or quick duplication of content cards.
- Template switching, color themes or custom CSS.
- Multi-page resumes, Word export or content rewriting.
- Exact attribution of overflow to one YAML field.

## Per-Resume Data Model

Layout settings remain inside each resume YAML:

```yaml
layout:
  sectionOrder:
    - internships
    - skills
    - projects
  mode: auto
  fontSizePt: 10.8
  lineHeight: 1.38
  spacingLevel: 67
  marginPreset: normal
```

The new fields store preferred values, not the effective values selected by automatic fitting.

- `mode`: `auto` or `fixed`.
- `fontSizePt`: `10.2` through `11.2`, in `0.1pt` steps.
- `lineHeight`: `1.25` through `1.42`, in `0.01` steps.
- `spacingLevel`: integer `0` through `100`.
- `marginPreset`: `narrow`, `normal` or `wide`.

`spacingLevel` is an abstract compactness control rather than a percentage. Its anchors preserve the existing density profiles:

- `0`: current `tight` gaps.
- `50`: current `compact` gaps.
- `67`: current `normal` gaps and the default.
- `100`: a bounded relaxed profile above `normal`.

Intermediate values linearly interpolate each spacing variable independently. This is necessary because the current item, section and experience gaps do not shrink by one common percentage.

Old YAML containing only `layout.sectionOrder` remains valid. Missing new fields use `auto`, `10.8`, `1.38`, `67` and `normal`. Loading an old resume does not write files. The editor materializes defaults in its draft state; they are written only on the next explicit save of that resume.

Resume duplication, backups, package export/import and whole-data recovery naturally carry these settings because they already copy or replace the resume YAML.

## Margin Presets

The page remains standard A4 with zero print margin and an internal `.page` padding controlled by variables:

| Preset | Horizontal | Vertical |
| --- | ---: | ---: |
| `narrow` | 6mm | 4mm |
| `normal` | 8mm | 6mm |
| `wide` | 10mm | 8mm |

The photo remains a fixed module. Page size, photo size and the basic two-column information structure are not user-editable.

## Typography Model

The body size is the user-controlled base. Existing hard-coded profile, section title, experience title, summary, link and metadata sizes move to named CSS variables. Candidate construction calculates those values from fixed ratios so the visual hierarchy scales as one system.

The change must not leave headings unchanged while only shrinking bullets. Letter spacing remains zero. The fixed photo dimensions and A4 geometry do not scale with typography.

## Shared Layout Module

One pure shared module owns:

- Defaults and supported enum values.
- Numeric normalization and validation.
- Spacing interpolation.
- Margin preset mapping.
- Typography ratios and CSS variable construction.
- Ordered auto candidates and the single fixed candidate.
- Stable public metadata for the editor and generation API.

The editor preview and formal generator must not maintain separate density tables. The existing hard-coded `DENSITY_PROFILES` becomes compatibility input for spacing anchors and regression tests, then candidate construction replaces direct profile iteration.

## Automatic Fitting

Automatic fitting starts with the stored preferred values. It produces deterministic candidates in this order:

1. Decrease `spacingLevel` toward `0`.
2. Move `wide -> normal -> narrow`, or `normal -> narrow`.
3. Decrease line height toward `1.25`.
4. Decrease body font size toward `10.2pt`.

Every phase keeps the values reached by earlier phases. Duplicate candidates are removed. The original preferred candidate is always first, and the hard minimum candidate is always last.

Spacing uses bounded level steps, line height uses `0.01`, and body size uses `0.1pt`. Formal generation should reuse one Playwright page while applying candidate CSS variables and measuring after layout, rather than creating a new browser page for every candidate.

The first candidate whose vertical and horizontal overflow are both within the existing tolerance is selected. If the hard minimum still overflows, fitting stops and reports the total overflow. It never goes below the defined bounds.

## Fixed Mode

Fixed mode creates exactly one candidate from the stored values. It never reduces margins, spacing, line height or font size. If that candidate overflows, draft preview reports the overflow and formal generation refuses to create a new PDF, PNG or generated HTML.

Saving an overflowing YAML remains allowed. This supports unfinished editing and avoids coupling content persistence to PDF availability.

## Draft Preview Data Flow

1. The editor sends the current unsaved resume to `POST /api/preview` using the existing debounce and generation counter.
2. The server validates content and layout, renders HTML, and returns the ordered layout candidates.
3. The iframe applies each candidate's CSS variables and measures the A4 page using the existing client-side measurement path.
4. The first fitting candidate becomes the effective draft layout. If none fits, the final candidate and overflow amount become the draft status.

The server remains responsible for validation and candidate construction. The browser is responsible only for applying returned variables and measuring its rendered iframe. Stale preview responses continue to be ignored.

## Formal Generation Data Flow

Formal generation reloads the saved YAML, rebuilds candidates through the same shared module and measures them in Playwright. It must not trust the previous browser measurement.

A successful response includes:

- Mode.
- Effective font size and line height.
- Effective spacing level and margin preset.
- Content width and height.
- Vertical and horizontal overflow, both zero within tolerance.
- Existing output URLs.

The generated HTML embeds the selected CSS variables so opening it later reproduces the PDF layout without rerunning fitting.

## Editor UI

The existing top-level entries remain two:

- `内容编辑`
- `排版设置`, renamed from `排版顺序`

The layout panel contains, in order:

1. `自动适配 / 固定参数` segmented control.
2. Font size slider with numeric stepper.
3. Line-height slider with numeric stepper.
4. Content compactness slider with `紧凑 / 较紧 / 标准 / 宽松` anchors.
5. `窄 / 标准 / 宽` margin segmented control.
6. Restore-default command.
7. Existing section order controls.

Controls use labels, stable dimensions, keyboard operation and visible focus states. Numeric values are not entered as arbitrary text. The A4 preview updates as a draft without saving. Layout changes use the same dirty-state, save shortcut, resume-switch protection and backup behavior as content edits.

The status bar shows effective rather than merely preferred values, for example:

```text
自动 · 10.5pt · 行距 1.32 · 紧凑 · 标准边距 · A4 单页
```

When no candidate fits it shows `超出 A4 38px`. The YAML may still be saved, but the generate action is unavailable until the saved content fits. The formal endpoint independently enforces the same rule.

## Error Handling

- Unknown layout keys, enum values, non-finite numbers, out-of-range values and invalid steps are rejected with stable messages.
- Errors do not echo YAML contents, personal data or absolute filesystem paths.
- Draft measurement failure uses the existing safe draft-preview error state.
- Automatic exhaustion reports mode, effective minimum values and total overflow.
- Fixed overflow reports the exact fixed values and total overflow.
- A failed generation does not replace previously generated output files.
- Restoring defaults changes only layout fields and section order defaults; it does not modify resume content.

## Testing

Automated tests cover:

- Defaults, schema validation, ranges, steps and unknown keys.
- Backward compatibility with old `layout.sectionOrder` YAML.
- Spacing anchors and interpolation.
- Margin and typography CSS variables.
- Deterministic candidate ordering, deduplication and hard minima.
- Fixed mode producing exactly one candidate.
- Draft preview selecting the first fitting candidate and reporting overflow.
- Formal generation matching draft candidate semantics.
- Overflow allowing save while blocking generation.
- Per-resume isolation, duplication and switching.
- Backup, package import/export and recovery regressions.
- Desktop and narrow editor layouts, keyboard controls and visible status.
- Standard A4, single-page PDF output and existing click-to-edit markers.
- Complete privacy and CI gates.

Manual acceptance uses fictional data in an external temporary data root. It checks the four control anchors, auto and fixed overflow behavior, save versus generate behavior, effective status text, PDF visual consistency and multi-resume isolation. Transaction failure cases remain automated and are not created against personal data.

## Delivery Boundaries

V2.4 is complete when old resumes open unchanged, every resume can independently save bounded settings, draft and formal fitting agree, overflowing fixed layouts cannot generate partial output, existing tight resumes retain their one-page capability, all tests and privacy checks pass, and desktop plus narrow visual acceptance shows no clipped controls or A4 content.

## Implementation Result

The implementation uses `scripts/layout-settings.mjs` as the single candidate and CSS-variable source for the preview API and formal generator. Automated privacy, editor, rendering and generation suites pass in UTC. Manual acceptance used an external fictional data root and verified old YAML, preferred auto fitting, every auto compression phase, fixed fitting, fixed overflow, standard one-page A4 PDFs, desktop and narrow editor geometry, draft/formal metadata agreement and click-to-edit behavior.
