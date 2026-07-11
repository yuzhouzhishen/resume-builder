# Resume Builder V2.4.1 Preview Stability Design

Date: 2026-07-11

Status: Implemented on `feature/v2.4.1-preview-stability`.

## Problem

V2.4 reloads the visible preview iframe after every draft request and applies automatic layout candidates to that visible document one frame at a time. Layout-only edits therefore produce a short iframe reload and expose intermediate font, spacing and wrapping states. Numeric range input also rebuilds the complete editor form on every input event.

The behavior is functionally correct but visually unstable: the preview flashes, text and sections appear to jump through multiple layouts, and the focused control is replaced while dragging.

## Scope

V2.4.1 stabilizes layout-control interactions without changing YAML, layout bounds, candidate order, A4 measurement, formal generation or overflow policy.

- Layout-only edits reuse the current preview document when its content revision still matches the current resume.
- Candidate measurement runs on an offscreen clone of `#resume-page`.
- The visible document receives only the selected candidate.
- Range input updates its value, output and boundary buttons in place instead of rebuilding the form.
- Content edits continue to request and load new draft HTML. Full content double buffering is explicitly deferred.

## Preview Revisions

The editor tracks a monotonically increasing content revision separately from general dirty state. Content fields, additions, deletions and section reordering increment it. Typography, line height, spacing, margin and mode changes do not.

The current iframe records the content revision it renders. A layout-only draft response may reuse the iframe only when:

- the iframe contains `#resume-page`;
- the rendered content revision equals the current content revision; and
- the response is still the latest draft generation.

Otherwise the editor follows the existing HTML reload path. This prevents layout reuse from hiding pending content changes.

## Offscreen Candidate Measurement

Candidate fitting clones the current `#resume-page` into an absolutely positioned, invisible measurement host in the same iframe document. Candidate CSS variables are applied to the clone, not the document root. The existing A4 geometry measurement runs against the clone. The host is removed in `finally`.

After the first fitting candidate or final overflowing candidate is selected, its allowlisted CSS variables are applied once to the visible document root. Intermediate candidates never affect the visible resume.

## Control Updates

Range `input` events update the in-memory YAML draft and schedule the existing debounced preview request. The current range element remains mounted. Its output text, `aria-valuetext`, normalized value and plus/minus disabled states update in place.

Segmented controls, step buttons and reset may continue to rerender the compact layout panel because they are discrete actions rather than continuous dragging.

## Error And Compatibility Behavior

- If an offscreen clone cannot be created, draft preview enters the existing safe error state.
- Stale responses and stale measurements cannot overwrite newer content or layout state.
- Older preview API responses without candidate metadata retain the existing fallback candidate.
- Saving, overflow gating and formal generation remain unchanged.
- A final selected layout can still cause one legitimate reflow when wrapping changes; repeated candidate jumps and iframe flashes are removed.

## Non-Goals

- Double-buffered content editing previews.
- Animation between layout states.
- New layout controls or changed fitting rules.
- Changes to PDF, PNG or generated HTML output.

## Acceptance

- A layout-only change sends a preview request but does not fire another visible iframe load.
- The iframe document identity remains stable across a layout-only change.
- Intermediate candidates are measured but never applied to the visible document root.
- The selected candidate and overflow status match the current V2.4 behavior.
- A range element retains identity and focus while its value changes.
- Content edits still load updated HTML and preserve click-to-edit behavior.

## Implementation Result

V2.4.1 implements content revision tracking, offscreen candidate measurement and in-place range synchronization without changing the preview API or persisted layout schema. Automated browser coverage verifies stable iframe identity for layout-only drafts, a full reload for content drafts, hidden intermediate candidates, retained range focus and stale-response protection.

Full content-edit double buffering remains deferred. A content change can still cause one iframe load and one final reflow because the HTML structure itself may have changed.
