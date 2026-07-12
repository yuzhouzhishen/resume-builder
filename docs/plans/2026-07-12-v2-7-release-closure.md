# Resume Builder V2.7 Release Closure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close V2.7 as a documented, verified local release and publish the `v2.7.0` Git tag.

**Architecture:** Keep the existing local Node application and external private data directory unchanged. Release work is limited to version metadata, current boundaries, acceptance evidence, full local verification, one release commit and an annotated Git tag.

**Tech Stack:** Node.js, npm, Git, Markdown, existing `node:test` and privacy gate.

### Task 1: Record The V2.7 Boundary

**Files:**
- Create: `docs/v2-7-boundaries.md`
- Create: `docs/v2-7-acceptance-checklist.md`
- Modify: `README.md`

1. Summarize the current editing, recovery, history and launcher workflow.
2. Preserve the one-page A4, local-only and external-data boundaries.
3. Separate automated coverage, macOS evidence and pending Windows real-machine checks.
4. Add the new documents to the README document index.

### Task 2: Set Release Metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

1. Change the application version from `0.1.0` to `2.7.0` without changing dependencies.
2. Confirm both npm metadata files contain the same version.

### Task 3: Verify And Publish

1. Run `TZ=UTC npm test` and require every test and the privacy scan to pass.
2. Run `git diff --check` and inspect the tracked diff.
3. Commit the release closure directly to `main` and push `origin/main`.
4. Create annotated tag `v2.7.0` on the verified release commit and push only that tag.
