# Resume Builder V2.5 Local Draft Recovery Design

Date: 2026-07-12

Status: Implemented.

## Goal

Recover unsaved edits after an accidental reload, browser crash or computer restart without writing YAML or weakening the explicit Save workflow.

## Storage Model

Each resume uses a versioned browser-local key:

```text
resume-builder:local-draft:v1:<resumeId>
```

The JSON record contains `version`, `resumeId`, `baseSignature`, `updatedAt` and the complete resume object. The signature is a stable JSON representation of the last YAML loaded into the editor. Photos remain external paths, so image bytes are not duplicated into browser storage.

Writes are debounced during editing and flushed on `pagehide` or `beforeunload`. Storage errors never block editing; the editor reports that crash recovery is unavailable for the current change.

## Recovery Flow

After a resume and its backups load, the editor checks for a matching local draft. A modal offers:

- `暂不处理`: keep the saved YAML visible and preserve the local draft for a later reload.
- `放弃草稿`: delete the browser draft and keep the saved YAML.
- `恢复草稿`: load the browser draft into the form, mark it unsaved and render a draft preview without writing YAML.

If `baseSignature` differs from the current YAML signature, the dialog warns that saved data changed after the draft was created. Recovery remains explicit so the user can still rescue content.

Malformed, wrong-version or mismatched-ID records are ignored and removed.

## Lifecycle

- Successful Save updates the saved signature and removes that resume's local draft.
- Explicit discard before switching or creating removes the current resume's draft.
- Deleting a resume removes its draft.
- Loading an example, replacing a photo or restoring a YAML backup removes the replaced resume's draft after success.
- Whole-data import or historical recovery clears all browser drafts because resume IDs may now refer to different data.
- A failed save or failed replacement keeps the draft.

## Non-Goals

- Automatic YAML saving.
- Cross-device recovery or cloud synchronization.
- Merging a local draft with changed YAML.
- Multi-tab conflict resolution.
- Including unsaved browser drafts in exported ZIP packages.

## Acceptance

- Editing creates a versioned per-resume local draft without changing YAML.
- Reloading offers recovery before any overwrite.
- Restore updates the form and preview and remains unsaved.
- Discard and successful Save remove the draft.
- A changed YAML base produces a visible warning.
- Corrupt records do not break editor initialization.
