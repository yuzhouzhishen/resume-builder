import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateDataRoot } from "./data-root.mjs";
import { createDataRecoveryManager, listDataSnapshots } from "./data-recovery.mjs";
import { saveResumeYaml } from "./resume-data.mjs";

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
  items: [
    { id: "cpp", name: "C++ 示例", file: "resumes/cpp.yaml" },
    { id: "second", name: "第二份简历", file: "resumes/second.yaml" }
  ]
};

function makeDataRoot(t, basename = "resume.data+[draft]") {
  const parent = mkdtempSync(path.join(tmpdir(), "resume-data-recovery-test-"));
  const dataRoot = path.join(parent, basename);
  writeDataFixture(dataRoot);
  t.after(() => rmSync(parent, { force: true, recursive: true }));
  return { parent, dataRoot };
}

function writeDataFixture(rootDir, options = {}) {
  mkdirSync(path.join(rootDir, "resumes"), { recursive: true });
  mkdirSync(path.join(rootDir, "assets"), { recursive: true });
  writeFileSync(path.join(rootDir, "assets/photo.svg"), "<svg></svg>");
  writeFileSync(
    path.join(rootDir, "resumes.json"),
    options.invalidRegistry
      ? "{broken\n"
      : `${JSON.stringify(fixtureRegistry, null, 2)}\n`
  );
  saveResumeYaml(path.join(rootDir, "resumes/cpp.yaml"), fixtureResume);
  saveResumeYaml(path.join(rootDir, "resumes/second.yaml"), {
    ...structuredClone(fixtureResume),
    profile: {
      ...structuredClone(fixtureResume.profile),
      name: "第二位候选人"
    }
  });
  if (options.invalidYaml) {
    writeFileSync(path.join(rootDir, "resumes/cpp.yaml"), "profile: [broken\n");
  }
  if (options.missingPhoto) {
    unlinkSync(path.join(rootDir, "assets/photo.svg"));
  }
}

function writeSnapshot(dataRoot, suffix, options) {
  const basename = `${path.basename(dataRoot)}.${suffix}`;
  const rootDir = path.join(path.dirname(dataRoot), basename);
  writeDataFixture(rootDir, options);
  return { basename, rootDir };
}

function snapshotId(basename) {
  return createHash("sha256").update(basename).digest("hex");
}

function captureError(action) {
  let captured;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured, "Expected action to throw");
  return captured;
}

test("restores a snapshot through a staged transaction without consuming its source", (t) => {
  const { dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const sourceBefore = readFileSync(path.join(source.rootDir, "assets/photo.svg"));
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "restore-token"
  });
  const [snapshot] = manager.list();

  const result = manager.restore(snapshot.id);

  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>selected-source</svg>"
  );
  assert.equal(existsSync(source.rootDir), true);
  assert.deepEqual(readFileSync(path.join(source.rootDir, "assets/photo.svg")), sourceBefore);
  assert.equal(result.preRestoreBackup, `${path.basename(dataRoot)}.pre-restore-20260711-080910`);
  assert.equal(path.isAbsolute(result.preRestoreBackup), false);
  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.equal(
    readFileSync(
      path.join(path.dirname(dataRoot), result.preRestoreBackup, "assets/photo.svg"),
      "utf8"
    ),
    "<svg>official-before</svg>"
  );

  const restoredAgain = manager.restore(snapshot.id);
  assert.equal(existsSync(source.rootDir), true);
  assert.deepEqual(readFileSync(path.join(source.rootDir, "assets/photo.svg")), sourceBefore);
  assert.equal(restoredAgain.preRestoreBackup, `${path.basename(dataRoot)}.pre-restore-20260711-080910-2`);
});

test("preserves an existing pre-restore timestamp path and uses the next suffix", (t) => {
  const { dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const reservedBackup = `${dataRoot}.pre-restore-20260711-080910`;
  mkdirSync(reservedBackup);
  writeFileSync(path.join(reservedBackup, "sentinel.txt"), "do not overwrite");
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "collision-token"
  });

  const result = manager.restore(snapshotId(source.basename));

  assert.equal(result.preRestoreBackup, `${path.basename(reservedBackup)}-2`);
  assert.equal(readFileSync(path.join(reservedBackup, "sentinel.txt"), "utf8"), "do not overwrite");
  assert.equal(
    readFileSync(path.join(`${reservedBackup}-2`, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
});

test("rejects malformed and unknown snapshot IDs without filesystem writes", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "unused-token"
  });
  const initialEntries = readdirSync(parent).sort();
  const officialBefore = readFileSync(path.join(dataRoot, "resumes.json"));
  const sourceBefore = readFileSync(path.join(source.rootDir, "resumes.json"));

  for (const invalidId of [null, "", "A".repeat(64), "a".repeat(63), "../snapshot"]) {
    const error = captureError(() => manager.restore(invalidId));
    assert.equal(error.statusCode, 400);
    assert.equal(error.message.includes(parent), false);
    assert.equal(manager.isRestoring(), false);
  }
  const unknown = captureError(() => manager.restore("f".repeat(64)));
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.message.includes(parent), false);
  assert.equal(manager.isRestoring(), false);
  assert.deepEqual(readdirSync(parent).sort(), initialEntries);
  assert.deepEqual(readFileSync(path.join(dataRoot, "resumes.json")), officialBefore);
  assert.deepEqual(readFileSync(path.join(source.rootDir, "resumes.json")), sourceBefore);
});

test("rescans before restore and rejects removed or newly invalid snapshots without writes", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const removedSource = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const invalidSource = writeSnapshot(dataRoot, "pre-restore-20260710-080910");
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "unused-token"
  });
  const listed = manager.list();
  const removed = listed.find(({ id }) => id === snapshotId(removedSource.basename));
  const invalid = listed.find(({ id }) => id === snapshotId(invalidSource.basename));
  rmSync(removedSource.rootDir, { recursive: true });
  writeFileSync(path.join(invalidSource.rootDir, "resumes.json"), "{broken\n");
  const entriesBefore = readdirSync(parent).sort();
  const officialBefore = readFileSync(path.join(dataRoot, "resumes.json"));

  const removedError = captureError(() => manager.restore(removed.id));
  assert.equal(removedError.statusCode, 404);
  assert.equal(removedError.message.includes(parent), false);
  const invalidError = captureError(() => manager.restore(invalid.id));
  assert.equal(invalidError.statusCode, 409);
  assert.equal(invalidError.message.includes(parent), false);
  assert.equal(manager.isRestoring(), false);
  assert.deepEqual(readdirSync(parent).sort(), entriesBefore);
  assert.deepEqual(readFileSync(path.join(dataRoot, "resumes.json")), officialBefore);
});

test("reports restoring only inside transaction callbacks and dispose cannot remove active staging", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const unrelatedStaging = path.join(parent, `.${path.basename(dataRoot)}.restore-not-owned`);
  mkdirSync(unrelatedStaging);
  let manager;
  let selectedId;
  manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "lifecycle-token",
    copy(sourceRoot, stagingRoot, options) {
      assert.equal(manager.isRestoring(), true);
      cpSync(sourceRoot, stagingRoot, options);
      manager.dispose();
      assert.equal(existsSync(stagingRoot), true);
      assert.equal(existsSync(unrelatedStaging), true);
      const locked = captureError(() => manager.restore(selectedId));
      assert.equal(locked.statusCode, 423);
    },
    validate(rootDir) {
      assert.equal(manager.isRestoring(), true);
      return validateDataRoot(rootDir);
    }
  });
  [selectedId] = manager.list().map(({ id }) => id);
  assert.equal(manager.isRestoring(), false);

  manager.restore(selectedId);

  assert.equal(manager.isRestoring(), false);
  assert.equal(existsSync(unrelatedStaging), true);
  assert.equal(existsSync(dataRoot), true);
  manager.dispose();
  assert.equal(existsSync(dataRoot), true);
  assert.equal(existsSync(unrelatedStaging), true);
});

test("restore cleans only owned staging when copy or staging validation fails", (t) => {
  for (const failure of ["copy", "validation"]) {
    const { parent, dataRoot } = makeDataRoot(t);
    writeFileSync(path.join(dataRoot, "assets/photo.svg"), `<svg>official-${failure}</svg>`);
    const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
    const otherSnapshot = writeSnapshot(dataRoot, "pre-restore-20260710-080910");
    writeFileSync(path.join(source.rootDir, "assets/photo.svg"), `<svg>source-${failure}</svg>`);
    const officialBefore = readFileSync(path.join(dataRoot, "assets/photo.svg"));
    const sourceBefore = readFileSync(path.join(source.rootDir, "assets/photo.svg"));
    const otherBefore = readFileSync(path.join(otherSnapshot.rootDir, "resumes.json"));
    const entriesBefore = readdirSync(parent).sort();
    const token = `${failure}-failure-token`;
    const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-${token}`);
    const removeCalls = [];
    const options = {
      dataRoot,
      tokenFactory: () => token,
      remove(target, removeOptions) {
        removeCalls.push({ target, options: removeOptions });
        rmSync(target, removeOptions);
      }
    };
    if (failure === "copy") {
      options.copy = (sourceRoot, targetRoot, copyOptions) => {
        cpSync(sourceRoot, targetRoot, copyOptions);
        throw new Error(`copy failed at ${parent}`);
      };
    } else {
      options.validate = (rootDir) => {
        if (rootDir === stagingRoot) {
          throw new Error(`staging validation failed at ${parent}`);
        }
        return validateDataRoot(rootDir);
      };
    }
    const manager = createDataRecoveryManager(options);

    const error = captureError(() => manager.restore(snapshotId(source.basename)));

    assert.equal(
      error.code,
      failure === "copy" ? "restore-copy-failed" : "restore-staging-invalid"
    );
    assert.equal(error.message.includes(parent), false);
    assert.equal(manager.isRestoring(), false);
    assert.deepEqual(readdirSync(parent).sort(), entriesBefore);
    assert.deepEqual(readFileSync(path.join(dataRoot, "assets/photo.svg")), officialBefore);
    assert.deepEqual(readFileSync(path.join(source.rootDir, "assets/photo.svg")), sourceBefore);
    assert.deepEqual(readFileSync(path.join(otherSnapshot.rootDir, "resumes.json")), otherBefore);
    assert.deepEqual(removeCalls, [{
      target: stagingRoot,
      options: { force: true, recursive: true }
    }]);
  }
});

test("restore rolls back the old root when publishing staging fails", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-publish-token`);
  const removeCalls = [];
  let renameCalls = 0;
  let manager;
  manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "publish-token",
    rename(sourceRoot, targetRoot) {
      renameCalls += 1;
      assert.equal(manager.isRestoring(), true);
      if (renameCalls === 2) {
        throw new Error(`publish failed at ${parent}`);
      }
      renameSync(sourceRoot, targetRoot);
    },
    remove(target, options) {
      removeCalls.push(target);
      rmSync(target, options);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.code, "restore-publish-failed");
  assert.match(error.message, /publication failed.*previous data was restored/i);
  assert.equal(error.message.includes(parent), false);
  assert.equal(renameCalls, 3);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(existsSync(`${dataRoot}.pre-restore-20260711-080910`), false);
  assert.equal(existsSync(source.rootDir), true);
  assert.deepEqual(removeCalls, [stagingRoot]);
  assert.equal(manager.isRestoring(), false);
});

test("restore quarantines a failed final publication uniquely and restores the old root", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const existingQuarantine = `${dataRoot}.failed-restore-final-token`;
  mkdirSync(existingQuarantine);
  writeFileSync(path.join(existingQuarantine, "sentinel.txt"), "existing quarantine");
  const removeCalls = [];
  let validationCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "final-token",
    validate(rootDir) {
      validationCalls += 1;
      if (rootDir === dataRoot) {
        throw new Error(`final validation failed at ${parent}`);
      }
      return validateDataRoot(rootDir);
    },
    remove(target, options) {
      removeCalls.push(target);
      rmSync(target, options);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.code, "restore-final-validation-failed");
  assert.match(error.message, /final validation.*previous data was restored.*quarantined/i);
  assert.equal(error.message.includes(parent), false);
  assert.equal(validationCalls, 2);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(
    readFileSync(path.join(`${existingQuarantine}-2`, "assets/photo.svg"), "utf8"),
    "<svg>selected-source</svg>"
  );
  assert.equal(
    readFileSync(path.join(existingQuarantine, "sentinel.txt"), "utf8"),
    "existing quarantine"
  );
  assert.equal(existsSync(`${dataRoot}.pre-restore-20260711-080910`), false);
  assert.equal(existsSync(source.rootDir), true);
  assert.deepEqual(removeCalls, []);
  assert.equal(manager.isRestoring(), false);
});

test("restore rollback failure preserves every surviving root and reports manual recovery", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-rollback-token`);
  const removeCalls = [];
  let renameCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "rollback-token",
    rename(sourceRoot, targetRoot) {
      renameCalls += 1;
      if (renameCalls === 1) {
        renameSync(sourceRoot, targetRoot);
        return;
      }
      if (renameCalls === 2) {
        mkdirSync(dataRoot);
        writeFileSync(path.join(dataRoot, "survivor.txt"), "new official survivor");
        throw new Error(`publish failed at ${parent}`);
      }
      throw new Error(`rollback failed at ${parent}`);
    },
    remove(target, options) {
      removeCalls.push(target);
      rmSync(target, options);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.code, "restore-rollback-failed");
  assert.match(error.message, /previous data could not be restored.*manual recovery/i);
  assert.equal(error.message.includes(parent), false);
  assert.equal(renameCalls, 3);
  assert.equal(readFileSync(path.join(dataRoot, "survivor.txt"), "utf8"), "new official survivor");
  assert.equal(
    readFileSync(path.join(backupRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(
    readFileSync(path.join(source.rootDir, "assets/photo.svg"), "utf8"),
    "<svg>selected-source</svg>"
  );
  assert.deepEqual(removeCalls, [stagingRoot]);
  assert.equal(manager.isRestoring(), false);
});

test("restore preserves rollback failure when staging cleanup also fails", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-priority-token`);
  let renameCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "priority-token",
    rename(sourceRoot, targetRoot) {
      renameCalls += 1;
      if (renameCalls === 1) {
        renameSync(sourceRoot, targetRoot);
        return;
      }
      if (renameCalls === 2) {
        throw new Error(`publish failed at ${parent}`);
      }
      throw new Error(`rollback failed at ${parent}`);
    },
    remove() {
      throw new Error(`cleanup failed at ${parent}`);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 500);
  assert.equal(error.code, "restore-rollback-failed");
  assert.match(error.message, /previous data could not be restored.*manual recovery/i);
  assert.equal(error.message.includes(parent), false);
  assert.equal(renameCalls, 3);
  assert.equal(existsSync(dataRoot), false);
  assert.equal(existsSync(backupRoot), true);
  assert.equal(existsSync(stagingRoot), true);
  assert.equal(existsSync(source.rootDir), true);
  assert.equal(manager.isRestoring(), false);
});

test("restore keeps its lock active through injected staging cleanup", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-cleanup-lock-token`);
  let manager;
  let selectedId;
  let removeCalls = 0;
  let tokenCalls = 0;
  let restoringDuringRemove;
  let stagingExistsAfterDispose;
  let nestedError;
  manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory() {
      tokenCalls += 1;
      if (tokenCalls === 1) {
        return "cleanup-lock-token";
      }
      throw new Error(`nested restore reached token creation at ${parent}`);
    },
    copy(sourceRoot, targetRoot, options) {
      cpSync(sourceRoot, targetRoot, options);
      throw new Error(`copy failed at ${parent}`);
    },
    remove(target, options) {
      removeCalls += 1;
      if (removeCalls === 1) {
        restoringDuringRemove = manager.isRestoring();
        manager.dispose();
        stagingExistsAfterDispose = existsSync(target);
        nestedError = captureError(() => manager.restore(selectedId));
      }
      if (existsSync(target)) {
        rmSync(target, options);
      }
    }
  });
  selectedId = snapshotId(source.basename);

  const error = captureError(() => manager.restore(selectedId));

  assert.equal(error.code, "restore-copy-failed");
  assert.equal(error.message.includes(parent), false);
  assert.equal(restoringDuringRemove, true);
  assert.equal(stagingExistsAfterDispose, true);
  assert.equal(nestedError.statusCode, 423);
  assert.equal(nestedError.code, "restore-locked");
  assert.equal(nestedError.message.includes(parent), false);
  assert.equal(removeCalls, 1);
  assert.equal(tokenCalls, 1);
  assert.equal(existsSync(stagingRoot), false);
  assert.equal(manager.isRestoring(), false);
});

test("restore rejects unsafe tokens and never claims an existing staging directory", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const initialEntries = readdirSync(parent).sort();
  const unsafeManager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "../escape"
  });

  const unsafeError = captureError(() => unsafeManager.restore(snapshotId(source.basename)));

  assert.equal(unsafeError.code, "invalid-restore-token");
  assert.equal(unsafeError.message.includes(parent), false);
  assert.deepEqual(readdirSync(parent).sort(), initialEntries);
  assert.equal(unsafeManager.isRestoring(), false);

  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-existing-token`);
  mkdirSync(stagingRoot);
  writeFileSync(path.join(stagingRoot, "sentinel.txt"), "not manager owned");
  const removeCalls = [];
  const existingManager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "existing-token",
    remove(target, options) {
      removeCalls.push(target);
      rmSync(target, options);
    }
  });

  const existingError = captureError(
    () => existingManager.restore(snapshotId(source.basename))
  );
  assert.equal(existingError.code, "restore-staging-exists");
  assert.equal(existingError.message.includes(parent), false);
  existingManager.dispose();
  assert.equal(readFileSync(path.join(stagingRoot, "sentinel.txt"), "utf8"), "not manager owned");
  assert.deepEqual(removeCalls, []);
  assert.equal(existsSync(dataRoot), true);
  assert.equal(existsSync(source.rootDir), true);
});

test("discovers both snapshot types with newest-first timestamps and registry metadata", (t) => {
  const { dataRoot } = makeDataRoot(t);
  const older = writeSnapshot(dataRoot, "pre-import-20260709-080910");
  const collision = writeSnapshot(dataRoot, "pre-import-20260709-080910-2");
  const newer = writeSnapshot(dataRoot, "pre-restore-20260711-101112");

  const snapshots = listDataSnapshots({ dataRoot });

  assert.deepEqual(snapshots.map(({ type }) => type), [
    "pre-restore",
    "pre-import",
    "pre-import"
  ]);
  assert.deepEqual(snapshots.map(({ createdAt }) => createdAt), [
    "2026-07-11T10:11:12.000Z",
    "2026-07-09T08:09:10.000Z",
    "2026-07-09T08:09:10.000Z"
  ]);
  assert.equal(snapshots[0].id, snapshotId(newer.basename));
  assert.equal(snapshots[1].id, snapshotId(older.basename));
  assert.equal(snapshots[2].id, snapshotId(collision.basename));
  assert.match(snapshots[0].id, /^[a-f0-9]{64}$/);
  assert.deepEqual({
    valid: snapshots[0].valid,
    resumeCount: snapshots[0].resumeCount,
    activeResumeId: snapshots[0].activeResumeId,
    activeResumeName: snapshots[0].activeResumeName,
    resumes: snapshots[0].resumes
  }, {
    valid: true,
    resumeCount: 2,
    activeResumeId: "cpp",
    activeResumeName: "C++ 示例",
    resumes: [
      { id: "cpp", name: "C++ 示例" },
      { id: "second", name: "第二份简历" }
    ]
  });
});

test("ignores unrelated siblings, other basenames, malformed timestamps, and impossible UTC dates", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const basename = path.basename(dataRoot);
  const expected = writeSnapshot(dataRoot, "pre-import-20260710-120000");
  const ignoredBasenames = [
    `${basename}.pre-export-20260710-120000`,
    `other.pre-import-20260710-120000`,
    `${basename}-copy.pre-import-20260710-120000`,
    `${basename}.pre-import-2026071-120000`,
    `${basename}.pre-import-20260230-120000`,
    `${basename}.pre-import-20261301-120000`,
    `${basename}.pre-import-20260710-240000`,
    `${basename}.pre-import-20260710-126000`,
    `${basename}.pre-import-20260710-120060`,
    `${basename}.pre-import-20260710-120000-two`
  ];
  for (const ignoredBasename of ignoredBasenames) {
    mkdirSync(path.join(parent, ignoredBasename));
  }

  const snapshots = listDataSnapshots({ dataRoot });

  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].id, snapshotId(expected.basename));
});

test("lists a matching root symlink as unsafe without traversing its valid target", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const outsideRoot = path.join(parent, "valid-outside-root");
  writeDataFixture(outsideRoot);
  const candidateBasename = `${path.basename(dataRoot)}.pre-restore-20260711-120000`;
  symlinkSync(
    outsideRoot,
    path.join(parent, candidateBasename),
    process.platform === "win32" ? "junction" : "dir"
  );

  const snapshots = listDataSnapshots({ dataRoot });

  assert.equal(snapshots.length, 1);
  assert.deepEqual(snapshots[0], {
    id: snapshotId(candidateBasename),
    type: "pre-restore",
    createdAt: "2026-07-11T12:00:00.000Z",
    valid: false,
    code: "unsafe-tree",
    reason: "Snapshot contains an unsafe filesystem entry."
  });
});

test("marks a snapshot with a nested symlink as unsafe", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const { rootDir } = writeSnapshot(dataRoot, "pre-import-20260711-120100");
  const outsideFile = path.join(parent, "outside.txt");
  writeFileSync(outsideFile, "outside");
  symlinkSync(outsideFile, path.join(rootDir, "unused-link"));

  const [snapshot] = listDataSnapshots({ dataRoot });

  assert.equal(snapshot.valid, false);
  assert.equal(snapshot.code, "unsafe-tree");
  assert.equal(snapshot.reason, "Snapshot contains an unsafe filesystem entry.");
});

test("marks a snapshot with a special filesystem entry as unsafe", {
  skip: process.platform === "win32"
}, (t) => {
  const parent = mkdtempSync("/tmp/resume-recovery-");
  const dataRoot = path.join(parent, "data");
  writeDataFixture(dataRoot);
  t.after(() => rmSync(parent, { force: true, recursive: true }));
  const { rootDir } = writeSnapshot(dataRoot, "pre-restore-20260711-120200");
  const fifoPath = path.join(rootDir, "entry.fifo");
  execFileSync("mkfifo", [fifoPath]);

  const [snapshot] = listDataSnapshots({ dataRoot });

  assert.equal(snapshot.valid, false);
  assert.equal(snapshot.code, "unsafe-tree");
  assert.equal(snapshot.reason, "Snapshot contains an unsafe filesystem entry.");
});

test("returns stable path-free invalid states for registry, YAML, and photo failures", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeSnapshot(dataRoot, "pre-import-20260711-120300", { invalidRegistry: true });
  writeSnapshot(dataRoot, "pre-import-20260711-120400", { invalidYaml: true });
  writeSnapshot(dataRoot, "pre-import-20260711-120500", { missingPhoto: true });

  const snapshots = listDataSnapshots({ dataRoot });

  assert.equal(snapshots.length, 3);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.valid, false);
    assert.equal(snapshot.code, "invalid-data");
    assert.equal(snapshot.reason, "Snapshot data is invalid.");
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "code",
      "createdAt",
      "id",
      "reason",
      "type",
      "valid"
    ]);
  }
  assert.equal(JSON.stringify(snapshots).includes(parent), false);
});

test("hashes allowlisted basenames and returns stable ordering without absolute paths", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const candidates = [
    writeSnapshot(dataRoot, "pre-import-20260711-120600"),
    writeSnapshot(dataRoot, "pre-restore-20260711-120600")
  ];
  const orderedBasenames = candidates
    .map(({ basename }) => basename)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

  const first = listDataSnapshots({ dataRoot });
  const second = listDataSnapshots({ dataRoot });

  assert.deepEqual(second, first);
  assert.deepEqual(first.map(({ id }) => id), orderedBasenames.map(snapshotId));
  assert.equal(first.every(({ id }) => /^[a-f0-9]{64}$/.test(id)), true);
  assert.equal(JSON.stringify(first).includes(parent), false);
  for (const snapshot of first) {
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "activeResumeId",
      "activeResumeName",
      "createdAt",
      "id",
      "resumeCount",
      "resumes",
      "type",
      "valid"
    ]);
  }
});
