# Resume Builder V2.6 Edit History Design

Date: 2026-07-12

Status: Implemented.

## Goal

Add visible Undo and Redo controls for the current resume editing session. History must cover text, structure and layout edits while preserving the existing explicit Save, draft preview and browser-local recovery workflows.

## Architecture

Use bounded whole-resume snapshots rather than browser-native input history or per-action inverse commands. Resume data is small, and every editable operation already mutates `state.resume`, so snapshots cover all current operations without duplicating inverse logic for add, delete, move and layout actions.

The history state contains `past` and `future` stacks with a maximum of 50 snapshots. Each snapshot stores a structured clone of the resume plus the active editing area, module and selected preview path needed to return the user to useful context.

## Transaction Boundaries

- Consecutive input events from the same field are one history transaction.
- The transaction closes after 600ms of inactivity, on blur, when another field is edited, or before a non-input action.
- A layout slider drag is one transaction rather than one snapshot per input event.
- Add, confirmed delete, move, layout mode, margin, step and reset actions each create one transaction.
- A new edit after Undo clears the Redo stack.
- Duplicate snapshots are not stored.

## Save And Lifecycle

Save does not clear history. `savedResumeSignature` remains the official baseline, so Undo after Save becomes unsaved and returning to the saved snapshot becomes clean again.

Switching resumes, creating a resume, loading an example, replacing a photo, restoring a backup, importing data and historical recovery reset the in-memory history. Page reload also resets history; V2.5 browser-local recovery restores content only.

Applying Undo or Redo recalculates dirty state from the saved signature, synchronizes the browser-local draft, rerenders the form and schedules the existing buffered A4 preview.

## Interface

Place two compact icon-only buttons between resume management and Data Management in the preview toolbar. Use familiar curved Unicode symbols so no icon dependency or hand-drawn SVG is introduced:

- `↶`: Undo, `Cmd/Ctrl + Z`.
- `↷`: Redo, `Cmd/Ctrl + Shift + Z`; also `Ctrl + Y` on Windows/Linux.

Both controls have labels and tooltips, use the existing 34px toolbar geometry, and are disabled when their stack is empty or the editor is busy.

## Non-Goals

- Persisting the Undo/Redo stack across reloads or devices.
- Multi-tab history merging.
- Undoing server-side resume creation, deletion, photo replacement, example loading, backup restore, data import or historical recovery.
- Changing YAML, export packages or server APIs.

## Acceptance

- Multiple keystrokes in one field undo as one edit and redo correctly.
- Add, delete, move and layout changes are reversible.
- Undo followed by a new edit clears Redo.
- Buttons and keyboard shortcuts expose the same behavior and disabled state.
- Undo after Save is unsaved; returning to the saved snapshot is clean.
- Undo/Redo updates the A4 draft and V2.5 browser-local recovery record.
