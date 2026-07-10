# V2.1A Local Data Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate runtime resume data from the public code repository, automatically and losslessly migrate the current local data, and keep the editor and CLI behavior unchanged.

**Architecture:** Add a shared application-path module that resolves `projectRoot` and `dataRoot`, plus a migration module that prepares and validates `dataRoot` before any runtime operation. Refactor the generator and editor server to read code/templates from `projectRoot` and all user data from `dataRoot`. Migrate the real working copy only after fixture-based tests pass, then stop tracking personal files without deleting the local copies.

**Tech Stack:** Node.js 20.12+ standard library, `js-yaml`, Playwright, Node test runner, local HTTP server.

---

## Execution Safety

The original workspace currently contains user data that is intentionally not committed:

```text
M  resumes.json
?? resumes/variant-1.yaml
?? resumes/variant-2.yaml
```

Never reset, restore, stash, overwrite or delete these files. Tasks 1-5 may be developed in an isolated worktree with temporary fixtures. After Task 5, merge only the tested code and sanitized-example commits into the original workspace; verify the merge does not touch `resumes.json`, `resumes/` or `assets/photo.png`. Task 6 must then use the original workspace at `~/Downloads/resume-builder`, because the feature worktree does not contain the user's untracked resumes.

Do not run `git rm`, remove tracked personal runtime files or merge a branch that deletes them until the external migration has succeeded and hashes have been checked. Sanitizing `examples/` is safe because it does not modify the runtime registry, registered YAML or real photo. Use `git rm --cached`, never plain `git rm`, when removing real data from Git tracking.

### Task 1: Resolve project and data roots consistently

**Files:**
- Create: `scripts/app-paths.mjs`
- Create: `scripts/app-paths.test.mjs`
- Create: `.env.example`
- Modify: `package.json`

**Step 1: Write failing path-resolution tests**

Cover:

- process environment overrides `.env.local`;
- `.env.local` overrides the default;
- default is `<home>/Documents/Resume Builder`;
- `~` is expanded;
- paths containing spaces are preserved;
- blank and relative configured paths are rejected;
- `dataRoot` equal to or nested under `projectRoot` is rejected;
- returned paths are absolute and include `projectRoot` and `dataRoot`.

```js
const paths = resolveAppPaths({
  projectRoot,
  homeDir: "/Users/tester",
  env: { RESUME_BUILDER_DATA_DIR: "/tmp/resume-data" }
});
assert.equal(paths.dataRoot, "/tmp/resume-data");
```

**Step 2: Run the focused test and verify RED**

```bash
node --test scripts/app-paths.test.mjs
```

Expected: fail because `app-paths.mjs` does not exist.

**Step 3: Implement the minimal path module**

Export:

```js
resolveAppPaths({ projectRoot, env, homeDir })
readLocalEnv(projectRoot)
```

Use Node's `util.parseEnv()` for `.env.local`; do not add a handwritten dotenv parser. Resolution order is process environment, local file, then default. Do not mutate `process.env` inside the library. Add `engines.node >=20.12` to `package.json` because `util.parseEnv()` requires it.

**Step 4: Add public configuration documentation**

Commit `.env.example` with only a generic commented example:

```dotenv
# RESUME_BUILDER_DATA_DIR="/absolute/path/to/resume-builder-data"
```

Do not create or commit the user's `.env.local` in this task.

**Step 5: Run GREEN and update the test script**

```bash
node --test scripts/app-paths.test.mjs
npm test
```

Add `scripts/app-paths.test.mjs` to `npm test`.

**Step 6: Commit**

```bash
git add scripts/app-paths.mjs scripts/app-paths.test.mjs .env.example package.json
git commit -m "feat: resolve external resume data paths"
```

### Task 2: Validate, initialize and migrate a data root

**Files:**
- Create: `scripts/data-root.mjs`
- Create: `scripts/data-root.test.mjs`
- Modify: `package.json`
- Modify: `scripts/resume-data.mjs`
- Modify: `scripts/render.test.mjs`
- Reuse: `scripts/resume-registry.mjs`

**Step 1: Write failing preparation tests**

Use only `mkdtempSync()` fixtures. Cover:

- existing valid `dataRoot` is returned unchanged;
- existing invalid or non-empty unrecognized target fails without writes;
- missing target plus valid legacy data copies registry, registered YAML, assets, backups and output;
- a missing photo or invalid YAML prevents publication;
- absolute photo paths and `../` paths escaping `dataRoot` are rejected;
- migration creates `.migration.json`;
- validation failure leaves no official target directory;
- no legacy data initializes from a sanitized example and placeholder photo;
- two concurrent first-run preparations publish one valid target and clean the losing temporary directory;
- repeated preparation is idempotent.

Inject a deterministic clock and temporary suffix generator so tests do not depend on real time or UUIDs.

```js
const result = ensureDataRoot({ projectRoot, dataRoot, now, uniqueId });
assert.equal(result.status, "migrated");
assert.equal(loadResumeRegistry(dataRoot).activeId, "cpp");
```

**Step 2: Run RED**

```bash
node --test scripts/data-root.test.mjs
```

Expected: fail because `data-root.mjs` does not exist.

**Step 3: Implement data-root validation**

Export:

```js
validateDataRoot(dataRoot)
ensureDataRoot({ projectRoot, dataRoot, now, uniqueId })
```

`validateDataRoot()` must load and validate `resumes.json`, resolve every registered YAML, validate each resume against `dataRoot`, and reject any registry item whose file or photo escapes `dataRoot`. Strengthen `validateResume()` so `profile.photo` must be a relative path contained by the supplied asset root, not merely an existing absolute result.

**Step 4: Implement atomic migration**

Create a unique temporary sibling of `dataRoot`, copy legacy data into it, validate the temporary directory, write `.migration.json`, then `renameSync()` it into place. Never merge into an existing target. Clean only the unpublished temporary directory after failure.

Create the target parent directory when needed, but never create the official `dataRoot` before temporary validation succeeds.

If a competing process publishes `dataRoot` first, remove only the current process's temporary directory, validate the winner and return it as `existing`. Never overwrite the winner.

Copy the full current `assets/`, `backups/` and `output/` trees to preserve legacy files, but only publish after all registered resumes validate. The source remains untouched.

**Step 5: Implement sanitized initialization**

When no target and no legacy registry exist, materialize one allowlisted example into a normal data-root structure and copy its placeholder asset. Do not create a mostly empty YAML.

**Step 6: Run GREEN and the full suite**

```bash
node --test scripts/data-root.test.mjs
npm test
```

Add the new test to `npm test`.

**Step 7: Commit**

```bash
git add scripts/data-root.mjs scripts/data-root.test.mjs scripts/resume-data.mjs scripts/render.test.mjs package.json
git commit -m "feat: prepare and migrate resume data roots"
```

### Task 3: Separate generator code paths from data paths

**Files:**
- Modify: `scripts/generate.mjs`
- Modify: `scripts/render.test.mjs`
- Modify: `scripts/resume-registry.mjs`
- Modify: `scripts/resume-registry.test.mjs`

**Step 1: Write failing generator isolation tests**

Create distinct temporary `projectRoot` and `dataRoot`. Assert that:

- registry, YAML and photo are read from `dataRoot`;
- templates and CSS are read from `projectRoot`;
- PDF, PNG and preview are written under `dataRoot/output/<id>`;
- no output or backup directory is created under `projectRoot`;
- omitted `resumeId` uses `dataRoot/resumes.json.activeId`;
- unknown IDs still list available IDs.
- render and generation tests no longer read a repository-root `resumes.json` or real user YAML; all runtime-data assertions use temporary fixtures.
- generated `preview.html` contains its effective resume CSS and renders without a filesystem-relative link back to `projectRoot`.

**Step 2: Run RED**

```bash
node --test --test-name-pattern='data root|project root|generateResume' scripts/render.test.mjs
```

Expected: current `rootDir` implementation reads templates and data from one directory, so the split-root fixture fails.

**Step 3: Refactor generation options**

Use:

```js
generateResume({ projectRoot, dataRoot, resumeId, ...testDoubles })
```

Load registry and resolve resume paths from `dataRoot`. Validate `profile.photo` and call `assetToDataUri()` relative to `dataRoot`. Parameterize density measurement and template loading so CSS/HTML come from `projectRoot`. Inline the effective resume CSS into the formal `preview.html` so it remains viewable after being moved outside the repository; draft previews may continue using the server `/templates/` route.

The CLI entry point must call `resolveAppPaths()` and `ensureDataRoot()` once before `generateResume()`. Keep `--resume <id>` behavior unchanged.

**Step 4: Remove ambiguous path naming**

Rename `resolveResumePaths(rootDir, ...)` parameters and local variables to `dataRoot` without changing its allowlist behavior. Keep public output URLs relative; console file messages may be relative to `dataRoot`.

**Step 5: Run GREEN**

```bash
node --test scripts/resume-registry.test.mjs
node --test scripts/render.test.mjs
npm test
```

**Step 6: Commit**

```bash
git add scripts/generate.mjs scripts/render.test.mjs scripts/resume-registry.mjs scripts/resume-registry.test.mjs
git commit -m "refactor: generate resumes from external data root"
```

### Task 4: Separate editor server static and data mappings

**Files:**
- Modify: `scripts/editor-server.mjs`
- Modify: `scripts/editor-server.test.mjs`

**Step 1: Introduce split-root server fixtures**

Update test helpers to pass explicit `projectRoot` and `dataRoot`. Existing fixture content belongs in `dataRoot`; editor files, templates and examples remain in the real or fixture `projectRoot`.

Add failing tests proving:

- `/editor/` and `/templates/` resolve only from `projectRoot`;
- `/assets/` and `/output/` resolve only from `dataRoot`;
- all resume APIs read and write only `dataRoot`;
- `POST /api/generate` passes both roots to `generateResume`;
- path traversal remains rejected on both roots.

**Step 2: Run RED**

```bash
node --test --test-concurrency=1 --test-timeout=10000 --test-name-pattern='project root|data root|static files' scripts/editor-server.test.mjs
```

**Step 3: Refactor server construction**

Replace `options.rootDir` with explicit app paths:

```js
createEditorServer({ projectRoot, dataRoot, ...options })
startEditorServer({ projectRoot, dataRoot, ...options })
```

The command-line startup path resolves and prepares the data root before binding a port. Unit tests may pass already-prepared temporary roots and must not invoke the real migration.

**Step 4: Refactor handlers**

All registry, resume, backup, photo and output handlers use `dataRoot`. Example lookup and template files use `projectRoot`. Draft preview validates the draft photo against `dataRoot`. Keep API payloads and browser URLs unchanged.

Log:

```text
Resume editor running at http://127.0.0.1:4321
Resume data: /absolute/data/root (existing|migrated|initialized)
```

**Step 5: Run focused and full tests**

```bash
node --test --test-concurrency=1 --test-timeout=10000 scripts/editor-server.test.mjs
npm test
```

**Step 6: Commit**

```bash
git add scripts/editor-server.mjs scripts/editor-server.test.mjs
git commit -m "refactor: serve resumes from external data root"
```

### Task 5: Sanitize public examples and bootstrap assets

**Files:**
- Modify: `examples/cpp.yaml`
- Modify: `examples/ai-agent.yaml`
- Keep: `assets/photo.svg`
- Modify: `scripts/editor-server.test.mjs`
- Modify: `scripts/render.test.mjs`
- Modify: `docs/plans/2026-07-08-resume-builder.md`
- Modify: `scripts/data-root.test.mjs`

**Step 1: Write failing privacy and sample tests**

Tests must assert that examples:

- validate with the placeholder photo;
- still contain profile, layout, skills, internships and projects;
- can initialize a new data root and can be used by “从样例新建”;
- do not contain any profile values, account names, local message paths, organizations or project URLs copied from the private resumes.

Do not rely only on a substring list: explicitly assert the sample profile uses documented fictional values.

**Step 2: Run RED**

```bash
node --test --test-name-pattern='example|sanitized|privacy' scripts/render.test.mjs scripts/data-root.test.mjs
```

Expected: current examples contain real personal data and reference `assets/photo.png`.

**Step 3: Replace personal example content**

Write two compact but schema-complete fictional resumes. Point both to `assets/photo.svg`. Replace personal values in test fixtures with documented fictional values, and sanitize the early plan's source-file path and YAML examples. Preserve enough bullets and links to exercise wrapping, section order and one-page density selection.

Do not modify `resumes.json` or any `resumes/*.yaml` in this task.

**Step 4: Ensure examples materialize their assets**

When initializing or creating from an example, copy the allowlisted placeholder from `projectRoot/assets/photo.svg` to `dataRoot/assets/photo.svg` if missing. Never overwrite an existing user asset with the same path unless its bytes already match the public placeholder.

**Step 5: Run GREEN and generation tests**

```bash
node --test scripts/data-root.test.mjs
node --test scripts/render.test.mjs
node --test --test-concurrency=1 --test-timeout=10000 scripts/editor-server.test.mjs
npm test
```

**Step 6: Commit**

```bash
git add examples assets/photo.svg scripts/data-root.mjs scripts/data-root.test.mjs scripts/render.test.mjs scripts/editor-server.test.mjs scripts/editor-server.mjs docs/plans/2026-07-08-resume-builder.md
git commit -m "chore: sanitize public resume examples"
```

### Task 6: Migrate the real data and stop tracking personal files

**Files and directories:**
- Create locally, never commit: `.env.local`
- Create outside the repository: the private absolute directory configured in `.env.local`
- Modify: `.gitignore`
- Stop tracking without deleting locally: `resumes.json`, `resumes/cpp.yaml`, `assets/photo.png`
- Preserve locally: `resumes/variant-1.yaml`, `resumes/variant-2.yaml`, all existing backups and outputs

This task must run in the original workspace, not a feature worktree.

Before starting, confirm Tasks 1-5 are present in the original workspace and run `git diff -- resumes.json resumes assets/photo.png` to verify the integration did not alter the user's runtime data.

**Step 1: Record the source state before any write**

Capture:

```bash
git status --short
shasum -a 256 resumes.json resumes/*.yaml assets/photo.png
find backups output -type f | sort
```

Save the command output under `/tmp`, not in the repository. Confirm all registry entries are present and each YAML loads successfully.

**Step 2: Create the private local configuration**

First update `.gitignore` so `.env.local`, `/resumes.json`, `/resumes/` and personal raster assets are ignored while the public `assets/photo.svg` remains tracked. Then create `.env.local` with:

```dotenv
RESUME_BUILDER_DATA_DIR="<the private absolute path confirmed for this machine>"
```

Confirm `git check-ignore -v .env.local` succeeds before starting migration, so the private absolute path cannot be accidentally staged.

**Step 3: Trigger the automatic migration**

Start the updated editor or call the tested preparation entry point. This write is outside the repository and requires explicit permission in the Codex sandbox.

Expected terminal result:

```text
Resume data: <private-data-root> (migrated)
```

**Step 4: Verify byte preservation before changing Git tracking**

Compare source and destination SHA-256 values for `resumes.json`, every registered YAML and every referenced photo. Compare backup/output file lists and confirm `.migration.json` references the original project root.

Run the editor against the external directory and manually check all migrated resumes. Generate one PDF and verify it is one A4 page.

Stop immediately if any hash, active ID, file count or UI content differs.

**Step 5: Stop tracking personal files without deleting local copies**

Only after Step 4 passes:

```bash
git rm --cached resumes.json resumes/cpp.yaml assets/photo.png
```

Do not use plain `git rm`. Confirm the files still exist on disk and are ignored. Confirm `resumes/variant-1.yaml` and `resumes/variant-2.yaml` remain untouched.

**Step 6: Verify repository privacy boundary**

```bash
git status --short
git check-ignore -v .env.local resumes.json resumes/cpp.yaml resumes/variant-1.yaml resumes/variant-2.yaml assets/photo.png
git diff --cached --name-status
```

The staged diff must contain only ignore rules and deletions from Git tracking, never the contents of the private files.

**Step 7: Commit the tracking cleanup**

```bash
git add .gitignore
git commit -m "chore: move personal resume data outside repository"
```

Before committing, inspect `git diff --cached` and confirm no personal YAML or image is being added.

### Task 7: Document V2.1A boundaries and daily workflow

**Files:**
- Modify: `README.md`
- Create: `docs/v2-1-boundaries.md`
- Create: `docs/v2-1-acceptance-checklist.md`
- Modify: `docs/v2-acceptance-checklist.md`
- Modify: `docs/plans/2026-07-10-v2-1-data-isolation-design.md`

**Step 1: Update daily-use documentation**

Document:

- code root versus data root;
- `.env.local` and the generic default;
- the current machine's data directory without committing the private config file;
- automatic first-run migration and no-overwrite rules;
- where YAML, backups and outputs now live;
- how to diagnose the active data root from startup logs;
- V2.1B import/export as the next phase.

**Step 2: Record boundaries and acceptance checks**

The boundary document must state that V2.1A does not delete old local files, does not rewrite Gitee history and does not implement import/export. The acceptance checklist must include hash comparison, three-resume switching, external output generation and a clean Git status after edits.

Update stale V2 automated-test counts to the actual final count rather than assuming `101` or `102`.

**Step 3: Run final automated verification**

```bash
npm test
npm run generate
pdfinfo "$RESUME_BUILDER_DATA_DIR/output/<active-id>/resume.pdf"
git diff --check
```

Expected: all tests pass, generation writes only to `dataRoot`, and PDF reports one standard A4 page.

**Step 4: Run final manual verification**

Start `npm run editor` and verify:

- all migrated resumes are listed;
- edits and saves survive reload;
- backup and restore are scoped to the active resume;
- generated preview/PDF open normally;
- the repository remains clean after a content edit and generation;
- browser console has no errors at 1440x900 and 1024x900.

**Step 5: Update design status and commit docs**

After implementation and verification, change the design status from “尚未实施” to the actual result and record the final automated test count.

```bash
git add README.md docs
git commit -m "docs: document external resume data workflow"
```

### Task 8: Final review and Gitee push

**Step 1: Inspect the complete repository state**

```bash
git status --short
git log --oneline -10
git ls-files resumes.json 'resumes/*' assets/photo.png .env.local
```

Expected: no private runtime data is tracked; only intended code, sanitized examples, placeholder assets and documentation remain.

**Step 2: Search the current tree for known personal strings**

Use `git grep` to search tracked files for the known name, phone, email and personal photo filename. Investigate every hit. Do not use an unrestricted filesystem search because ignored local legacy data is intentionally still present. This is a current-tree check only; historical cleanup remains separate.

**Step 3: Request code review and fix findings**

Use `superpowers:requesting-code-review`, then rerun `npm test`, generation and the real-data smoke test after any changes.

**Step 4: Push only after verification**

```bash
git push origin main
```

Report the pushed commit, test count, external data directory and the fact that existing Gitee history has not yet been rewritten.
