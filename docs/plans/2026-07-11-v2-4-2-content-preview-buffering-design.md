# Resume Builder V2.4.2 Content Preview Buffering Design

Date: 2026-07-11

Status: Implemented on `fix/content-preview-buffering`.

## Problem

V2.4.1 keeps layout-only edits inside the current iframe, but content edits still assign a new `srcdoc`. The new document becomes visible before A4 candidate selection finishes, so users can briefly see an intermediate layout and an iframe reload even when only one character changed.

## Design

When the current iframe already contains `#resume-page`, the editor parses the draft HTML without navigating the iframe. It imports only the new A4 page into the existing document, measures that page in the existing offscreen host, and selects the final layout candidate while the old page remains visible.

After measurement, the editor synchronously applies the selected CSS variables and replaces the visible `#resume-page`. Because both operations happen in one task, the browser cannot paint the new content with an intermediate candidate. The iframe document, stylesheet, click-to-edit listener and scale transform remain unchanged.

If no valid page exists, such as the first preview of a new installation, the editor retains the existing `srcdoc` loading fallback. Stale draft versions cannot commit an imported page.

## Acceptance

- Content edits do not fire an iframe `load` event when a valid page is already visible.
- The iframe document identity remains stable.
- The old page remains visible while the draft request and A4 measurement are pending.
- The visible page is replaced exactly once with the new content and final layout.
- Layout-only edits continue to reuse the existing page.
- Save, backup restore, resume creation and click-to-edit continue to operate on the visible document.
