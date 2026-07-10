import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureDataRoot, validateDataRoot } from "./data-root.mjs";
import { loadResumeYaml, saveResumeYaml, validateResume } from "./resume-data.mjs";
import { loadResumeRegistry } from "./resume-registry.mjs";

const fixtureResume = {
  profile: {
    name: "测试候选人",
    target: "软件工程师",
    school: "示例大学",
    major: "计算机科学",
    phone: "000-0000-0000",
    email: "candidate@example.com",
    photo: "assets/photo.svg"
  },
  layout: {
    sectionOrder: ["skills", "internships", "projects"]
  },
  skills: [{ title: "编程", items: ["掌握基础编程能力。"] }],
  internships: [],
  projects: []
};

const fixtureRegistry = {
  activeId: "cpp",
  items: [{ id: "cpp", name: "示例简历", file: "resumes/cpp.yaml" }]
};

function makeRoots() {
  const parent = mkdtempSync(path.join(tmpdir(), "resume-data-root-test-"));
  const projectRoot = path.join(parent, "project");
  const dataRoot = path.join(parent, "data");
  mkdirSync(projectRoot);
  writePublicExample(projectRoot);
  return { parent, projectRoot, dataRoot };
}

function writePublicExample(projectRoot) {
  mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
  mkdirSync(path.join(projectRoot, "examples"), { recursive: true });
  writeFileSync(path.join(projectRoot, "assets/photo.svg"), "<svg></svg>");
  saveResumeYaml(path.join(projectRoot, "examples/cpp.yaml"), fixtureResume);
}

function writeDataFixture(rootDir, options = {}) {
  mkdirSync(path.join(rootDir, "resumes"), { recursive: true });
  mkdirSync(path.join(rootDir, "assets"), { recursive: true });
  writeFileSync(path.join(rootDir, "assets/photo.svg"), "<svg></svg>");
  writeFileSync(path.join(rootDir, "resumes.json"), `${JSON.stringify(fixtureRegistry, null, 2)}\n`);
  if (options.invalidYaml) {
    writeFileSync(path.join(rootDir, "resumes/cpp.yaml"), "profile: [broken\n");
  } else {
    saveResumeYaml(path.join(rootDir, "resumes/cpp.yaml"), fixtureResume);
  }
}

function prepareOptions(projectRoot, dataRoot, overrides = {}) {
  return {
    projectRoot,
    dataRoot,
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    uniqueId: () => "test-run",
    ...overrides
  };
}

test("existing valid data root is reused without migration", () => {
  const { projectRoot, dataRoot } = makeRoots();
  writeDataFixture(dataRoot);

  const result = ensureDataRoot(prepareOptions(projectRoot, dataRoot));

  assert.equal(result.status, "existing");
  assert.equal(result.dataRoot, dataRoot);
  assert.equal(result.registry.activeId, "cpp");
  assert.equal(existsSync(path.join(dataRoot, ".migration.json")), false);
});

test("an in-progress published root is not exposed as ready data", () => {
  const { projectRoot, dataRoot } = makeRoots();
  writeDataFixture(dataRoot);
  writeFileSync(path.join(dataRoot, ".migration-in-progress"), JSON.stringify({
    version: 1,
    migrationId: "other-process",
    pid: process.pid,
    createdAt: "2026-07-10T12:00:00.000Z",
    type: "legacy-copy",
    sourceRoot: projectRoot
  }));

  assert.throws(
    () => ensureDataRoot(prepareOptions(projectRoot, dataRoot, { readyTimeoutMs: 0 })),
    /migration is still in progress/i
  );
  assert.equal(existsSync(path.join(dataRoot, "resumes/cpp.yaml")), true);
});

test("a valid published root recovers automatically after its publisher exits", () => {
  const { projectRoot, dataRoot } = makeRoots();
  writeDataFixture(projectRoot);
  cpSync(projectRoot, dataRoot, { recursive: true });
  writeFileSync(path.join(dataRoot, ".migration-in-progress"), JSON.stringify({
    version: 1,
    migrationId: "stale-process",
    pid: 999999,
    createdAt: "2026-07-10T12:00:00.000Z",
    type: "legacy-copy",
    sourceRoot: projectRoot
  }));

  const result = ensureDataRoot(prepareOptions(projectRoot, dataRoot, {
    readyTimeoutMs: 0,
    isProcessAlive: () => false
  }));

  assert.equal(result.status, "existing");
  assert.equal(existsSync(path.join(dataRoot, ".migration-in-progress")), false);
});

test("existing unrecognized target fails without overwriting it", () => {
  const { projectRoot, dataRoot } = makeRoots();
  mkdirSync(dataRoot);
  writeFileSync(path.join(dataRoot, "keep.txt"), "keep-me");

  assert.throws(
    () => ensureDataRoot(prepareOptions(projectRoot, dataRoot)),
    /invalid resume data root/i
  );
  assert.equal(readFileSync(path.join(dataRoot, "keep.txt"), "utf8"), "keep-me");
});

test("legacy project data migrates through a validated temporary directory", () => {
  const { projectRoot, dataRoot } = makeRoots();
  writeDataFixture(projectRoot);
  mkdirSync(path.join(projectRoot, "backups/cpp"), { recursive: true });
  mkdirSync(path.join(projectRoot, "output/cpp"), { recursive: true });
  writeFileSync(path.join(projectRoot, "backups/cpp/resume-20260710-120000.yaml"), "backup");
  writeFileSync(path.join(projectRoot, "output/cpp/preview.html"), "preview");
  writeFileSync(path.join(projectRoot, "resume.backup.yaml"), "legacy-root-backup");

  const result = ensureDataRoot(prepareOptions(projectRoot, dataRoot));

  assert.equal(result.status, "migrated");
  assert.deepEqual(loadResumeRegistry(dataRoot), fixtureRegistry);
  assert.deepEqual(loadResumeYaml(path.join(dataRoot, "resumes/cpp.yaml")), fixtureResume);
  assert.equal(readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"), "<svg></svg>");
  assert.equal(readFileSync(path.join(dataRoot, "backups/cpp/resume-20260710-120000.yaml"), "utf8"), "backup");
  assert.equal(readFileSync(path.join(dataRoot, "output/cpp/preview.html"), "utf8"), "preview");
  assert.equal(readFileSync(path.join(dataRoot, "resume.backup.yaml"), "utf8"), "legacy-root-backup");
  assert.equal(existsSync(path.join(dataRoot, ".migration-in-progress")), false);
  assert.equal(existsSync(path.join(projectRoot, "resumes/cpp.yaml")), true);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataRoot, ".migration.json"), "utf8")), {
    version: 1,
    type: "legacy-copy",
    createdAt: "2026-07-10T12:00:00.000Z",
    sourceRoot: projectRoot
  });
});

test("legacy data changing during copy aborts migration without publishing stale content", () => {
  const { parent, projectRoot, dataRoot } = makeRoots();
  writeDataFixture(projectRoot);
  const changedResume = structuredClone(fixtureResume);
  changedResume.profile.name = "复制期间更新的姓名";

  assert.throws(
    () => ensureDataRoot(prepareOptions(projectRoot, dataRoot, {
      afterLegacyCopy: () => {
        saveResumeYaml(path.join(projectRoot, "resumes/cpp.yaml"), changedResume);
      }
    })),
    /changed during migration/i
  );
  assert.equal(existsSync(dataRoot), false);
  assert.equal(existsSync(path.join(parent, ".data.migrating-test-run")), false);
});

test("legacy data changing during publication quarantines the target without deleting concurrent writes", () => {
  const { parent, projectRoot, dataRoot } = makeRoots();
  writeDataFixture(projectRoot);
  const changedResume = structuredClone(fixtureResume);
  changedResume.profile.name = "发布期间更新的姓名";
  const publish = (temporaryRoot, officialRoot) => {
    renameSync(temporaryRoot, officialRoot);
    writeFileSync(path.join(officialRoot, "concurrent-save.txt"), "preserve-me");
    saveResumeYaml(path.join(projectRoot, "resumes/cpp.yaml"), changedResume);
  };

  assert.throws(
    () => ensureDataRoot(prepareOptions(projectRoot, dataRoot, { publish })),
    /changed during migration/i
  );
  const quarantinedRoot = path.join(parent, ".data.migrating-test-run");
  assert.equal(existsSync(dataRoot), false);
  assert.equal(readFileSync(path.join(quarantinedRoot, "concurrent-save.txt"), "utf8"), "preserve-me");
  assert.equal(existsSync(path.join(quarantinedRoot, ".migration-in-progress")), true);
});

test("invalid legacy yaml prevents publication and removes the temporary directory", () => {
  const { parent, projectRoot, dataRoot } = makeRoots();
  writeDataFixture(projectRoot, { invalidYaml: true });

  assert.throws(
    () => ensureDataRoot(prepareOptions(projectRoot, dataRoot)),
    /invalid yaml/i
  );
  assert.equal(existsSync(dataRoot), false);
  assert.equal(existsSync(path.join(parent, ".data.migrating-test-run")), false);
});

test("missing legacy photo prevents publication", () => {
  const { projectRoot, dataRoot } = makeRoots();
  writeDataFixture(projectRoot);
  writeFileSync(path.join(projectRoot, "assets/photo.svg"), "removed");
  const resume = structuredClone(fixtureResume);
  resume.profile.photo = "assets/missing.svg";
  saveResumeYaml(path.join(projectRoot, "resumes/cpp.yaml"), resume);

  assert.throws(
    () => ensureDataRoot(prepareOptions(projectRoot, dataRoot)),
    /photo file not found/i
  );
  assert.equal(existsSync(dataRoot), false);
});

test("photo paths must remain relative and inside the data root", () => {
  const { parent, dataRoot } = makeRoots();
  writeDataFixture(dataRoot);
  writeFileSync(path.join(parent, "outside.svg"), "<svg></svg>");

  for (const photo of [path.join(parent, "outside.svg"), "../outside.svg"]) {
    const resume = structuredClone(fixtureResume);
    resume.profile.photo = photo;
    assert.throws(() => validateResume(resume, dataRoot), /photo path.*inside/i);
  }
});

test("registered resume yaml symlinks cannot escape the data root", () => {
  const { parent, dataRoot } = makeRoots();
  writeDataFixture(dataRoot);
  const outsideYaml = path.join(parent, "outside.yaml");
  saveResumeYaml(outsideYaml, fixtureResume);
  unlinkSync(path.join(dataRoot, "resumes/cpp.yaml"));
  symlinkSync(outsideYaml, path.join(dataRoot, "resumes/cpp.yaml"));

  assert.throws(
    () => validateDataRoot(dataRoot),
    /resume yaml path.*inside/i
  );
});

test("unused asset directory symlinks cannot escape the data root", () => {
  const { parent, dataRoot } = makeRoots();
  writeDataFixture(dataRoot);
  const resume = structuredClone(fixtureResume);
  resume.profile.photo = "photos/photo.svg";
  mkdirSync(path.join(dataRoot, "photos"));
  writeFileSync(path.join(dataRoot, "photos/photo.svg"), "<svg></svg>");
  saveResumeYaml(path.join(dataRoot, "resumes/cpp.yaml"), resume);
  rmSync(path.join(dataRoot, "assets"), { recursive: true });
  const outsideAssets = path.join(parent, "outside-assets");
  mkdirSync(outsideAssets);
  symlinkSync(outsideAssets, path.join(dataRoot, "assets"));

  assert.throws(
    () => validateDataRoot(dataRoot),
    /resume assets path.*inside/i
  );
});

test("existing data root reports a clear startup error when it is not writable", () => {
  const { dataRoot } = makeRoots();
  writeDataFixture(dataRoot);
  const access = () => {
    const error = new Error("permission denied");
    error.code = "EACCES";
    throw error;
  };

  assert.throws(
    () => validateDataRoot(dataRoot, { access }),
    /not writable.*permission denied/i
  );
});

test("a missing target without legacy data initializes from the public example", () => {
  const { projectRoot, dataRoot } = makeRoots();

  const result = ensureDataRoot(prepareOptions(projectRoot, dataRoot));

  assert.equal(result.status, "initialized");
  assert.equal(loadResumeRegistry(dataRoot).activeId, "cpp");
  assert.equal(loadResumeYaml(path.join(dataRoot, "resumes/cpp.yaml")).profile.name, "测试候选人");
  assert.equal(readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"), "<svg></svg>");
});

test("preparing the same root twice is idempotent", () => {
  const { projectRoot, dataRoot } = makeRoots();

  assert.equal(ensureDataRoot(prepareOptions(projectRoot, dataRoot)).status, "initialized");
  assert.equal(ensureDataRoot(prepareOptions(projectRoot, dataRoot)).status, "existing");
});

test("a concurrent publisher wins without being overwritten", () => {
  const { projectRoot, dataRoot } = makeRoots();
  writeDataFixture(projectRoot);
  const publish = (temporaryRoot, officialRoot) => {
    cpSync(temporaryRoot, officialRoot, { recursive: true, errorOnExist: true });
    rmSync(path.join(officialRoot, ".migration-in-progress"), { force: true });
    const error = new Error("target already exists");
    error.code = "EEXIST";
    throw error;
  };

  const result = ensureDataRoot(prepareOptions(projectRoot, dataRoot, { publish }));

  assert.equal(result.status, "existing");
  assert.equal(validateDataRoot(dataRoot).activeId, "cpp");
  assert.equal(existsSync(path.join(path.dirname(dataRoot), ".data.migrating-test-run")), false);
});
