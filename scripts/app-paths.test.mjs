import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { readLocalEnv, resolveAppPaths } from "./app-paths.mjs";

function makeProject() {
  return mkdtempSync(path.join(tmpdir(), "resume-app-paths-test-"));
}

test("process environment data root overrides local configuration", () => {
  const projectRoot = makeProject();
  writeFileSync(
    path.join(projectRoot, ".env.local"),
    'RESUME_BUILDER_DATA_DIR="/tmp/from-local-file"\n'
  );

  const paths = resolveAppPaths({
    projectRoot,
    homeDir: "/Users/tester",
    env: { RESUME_BUILDER_DATA_DIR: "/tmp/from-process" }
  });

  assert.equal(paths.projectRoot, projectRoot);
  assert.equal(paths.dataRoot, "/tmp/from-process");
  assert.equal(paths.source, "environment");
});

test("local configuration overrides the default data root", () => {
  const projectRoot = makeProject();
  const configured = path.join(tmpdir(), "Resume Data With Spaces");
  writeFileSync(
    path.join(projectRoot, ".env.local"),
    `RESUME_BUILDER_DATA_DIR="${configured}"\n`
  );

  assert.deepEqual(readLocalEnv(projectRoot), {
    RESUME_BUILDER_DATA_DIR: configured
  });

  const paths = resolveAppPaths({ projectRoot, homeDir: "/Users/tester", env: {} });
  assert.equal(paths.dataRoot, configured);
  assert.equal(paths.source, ".env.local");
});

test("default data root lives in the current home Documents directory", () => {
  const projectRoot = makeProject();

  const paths = resolveAppPaths({ projectRoot, homeDir: "/Users/tester", env: {} });

  assert.equal(paths.dataRoot, "/Users/tester/Documents/Resume Builder");
  assert.equal(paths.source, "default");
});

test("configured tilde expands without losing spaces", () => {
  const projectRoot = makeProject();

  const paths = resolveAppPaths({
    projectRoot,
    homeDir: "/Users/tester",
    env: { RESUME_BUILDER_DATA_DIR: "~/Private Resume Data" }
  });

  assert.equal(paths.dataRoot, "/Users/tester/Private Resume Data");
});

test("blank and relative configured data roots are rejected", () => {
  const projectRoot = makeProject();

  assert.throws(
    () => resolveAppPaths({
      projectRoot,
      homeDir: "/Users/tester",
      env: { RESUME_BUILDER_DATA_DIR: "   " }
    }),
    /must not be blank/i
  );
  assert.throws(
    () => resolveAppPaths({
      projectRoot,
      homeDir: "/Users/tester",
      env: { RESUME_BUILDER_DATA_DIR: "relative/data" }
    }),
    /must be absolute/i
  );
});

test("data root cannot equal or live inside the project root", () => {
  const projectRoot = makeProject();
  mkdirSync(path.join(projectRoot, "private-data"));

  for (const dataRoot of [projectRoot, path.join(projectRoot, "private-data")]) {
    assert.throws(
      () => resolveAppPaths({
        projectRoot,
        homeDir: "/Users/tester",
        env: { RESUME_BUILDER_DATA_DIR: dataRoot }
      }),
      /outside the project root/i
    );
  }
});

test("data root symlinks cannot point back inside the project root", () => {
  const projectRoot = makeProject();
  const dataRootAlias = `${projectRoot}-data-alias`;
  symlinkSync(projectRoot, dataRootAlias);

  assert.throws(
    () => resolveAppPaths({
      projectRoot,
      homeDir: "/Users/tester",
      env: { RESUME_BUILDER_DATA_DIR: dataRootAlias }
    }),
    /outside the project root/i
  );
});

test("missing local configuration returns an empty object", () => {
  const projectRoot = makeProject();

  assert.deepEqual(readLocalEnv(projectRoot), {});
});
