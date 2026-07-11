import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
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

function createPathError(code, target) {
  const error = new Error(`${code}: path allocation failed at ${target}`);
  error.code = code;
  return error;
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

test("treats a dangling pre-restore backup path as occupied", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const reservedBackup = `${dataRoot}.pre-restore-20260711-080910`;
  const missingTarget = path.join(parent, "missing-backup-target");
  symlinkSync(missingTarget, reservedBackup, process.platform === "win32" ? "junction" : "dir");
  const reservedIdentity = lstatSync(reservedBackup);
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "dangling-backup-token"
  });

  const result = manager.restore(snapshotId(source.basename));

  assert.equal(result.preRestoreBackup, `${path.basename(reservedBackup)}-2`);
  assert.equal(lstatSync(reservedBackup).isSymbolicLink(), true);
  assert.equal(lstatSync(reservedBackup).dev, reservedIdentity.dev);
  assert.equal(lstatSync(reservedBackup).ino, reservedIdentity.ino);
  assert.equal(readlinkSync(reservedBackup), missingTarget);
  assert.equal(existsSync(missingTarget), false);
  assert.equal(existsSync(`${reservedBackup}-2`), true);
});

test("sanitizes non-ENOENT pre-restore backup allocation failures", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-backup-eacces-token`);
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  const inspectedPaths = [];
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "backup-eacces-token",
    pathLstat(target) {
      inspectedPaths.push(target);
      if (target === backupRoot) {
        throw createPathError("EACCES", target);
      }
      return lstatSync(target);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 500);
  assert.equal(error.code, "restore-backup-reservation-failed");
  assert.equal(error.message, "A pre-restore backup location could not be reserved.");
  assert.equal(error.message.includes(parent), false);
  assert.deepEqual(inspectedPaths, [stagingRoot, backupRoot]);
  assert.equal(existsSync(stagingRoot), true);
  assert.equal(existsSync(backupRoot), false);
  assert.equal(existsSync(dataRoot), true);
  assert.equal(existsSync(source.rootDir), true);
});

test("recovery lock blocks another manager before restore path selection", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const selectedId = snapshotId(source.basename);
  const lockRoot = path.join(parent, `.${path.basename(dataRoot)}.recovery-lock`);
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  let firstManager;
  let secondManager;
  let lockPresentDuringCopy = false;
  let secondSucceeded = false;
  let secondError;
  let secondDuringReleaseError;
  let secondTokenCalls = 0;
  let secondNowCalls = 0;
  let releaseCalls = 0;
  let restoringDuringRelease;
  secondManager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "second-lock-token",
    tokenFactory() {
      secondTokenCalls += 1;
      return "second-restore-token";
    },
    now() {
      secondNowCalls += 1;
      return new Date("2026-07-11T08:09:10.000Z");
    }
  });
  firstManager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "first-lock-token",
    tokenFactory: () => "first-restore-token",
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    copy(sourceRoot, targetRoot, options) {
      cpSync(sourceRoot, targetRoot, options);
      lockPresentDuringCopy = existsSync(lockRoot);
      try {
        secondManager.restore(selectedId);
        secondSucceeded = true;
      } catch (error) {
        secondError = error;
      }
    },
    releaseRename(sourceRoot, targetRoot) {
      releaseCalls += 1;
      assert.equal(sourceRoot, lockRoot);
      restoringDuringRelease = firstManager.isRestoring();
      firstManager.dispose();
      secondDuringReleaseError = captureError(() => secondManager.restore(selectedId));
      renameSync(sourceRoot, targetRoot);
    }
  });

  const result = firstManager.restore(selectedId);

  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.equal(lockPresentDuringCopy, true);
  assert.equal(secondSucceeded, false);
  assert.equal(secondError.statusCode, 423);
  assert.equal(secondError.code, "restore-locked");
  assert.equal(secondError.message.includes(parent), false);
  assert.equal(secondDuringReleaseError.statusCode, 423);
  assert.equal(secondDuringReleaseError.code, "restore-locked");
  assert.equal(secondDuringReleaseError.message.includes(parent), false);
  assert.equal(secondTokenCalls, 0);
  assert.equal(secondNowCalls, 0);
  assert.equal(releaseCalls, 1);
  assert.equal(restoringDuringRelease, true);
  assert.equal(existsSync(lockRoot), false);
  assert.equal(existsSync(backupRoot), true);
  assert.equal(existsSync(`${backupRoot}-2`), false);
  assert.equal(firstManager.isRestoring(), false);
  assert.equal(secondManager.isRestoring(), false);
});

test("recovery releases its canonical lock by leaving an exact tombstone", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const selectedId = snapshotId(source.basename);
  const basename = path.basename(dataRoot);
  const lockRoot = path.join(parent, `.${basename}.recovery-lock`);
  const releaseRoot = path.join(parent, `.${basename}.recovery-lock-released-normal-release`);
  const tombstoneRoot = path.join(releaseRoot, "lock");
  let canonicalBytes;
  let canonicalIdentity;
  const manager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "normal-owner",
    releaseTokenFactory: () => "normal-release",
    tokenFactory: () => "normal-restore",
    copy(sourceRoot, stagingRoot, options) {
      cpSync(sourceRoot, stagingRoot, options);
      canonicalBytes = readFileSync(lockRoot);
      canonicalIdentity = lstatSync(lockRoot);
    }
  });

  const result = manager.restore(selectedId);

  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.equal(existsSync(lockRoot), false);
  assert.deepEqual(readFileSync(tombstoneRoot), canonicalBytes);
  assert.equal(lstatSync(tombstoneRoot).dev, canonicalIdentity.dev);
  assert.equal(lstatSync(tombstoneRoot).ino, canonicalIdentity.ino);
  const laterManager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "later-owner",
    releaseTokenFactory: () => "later-release",
    tokenFactory: () => "later-restore"
  });
  const laterResult = laterManager.restore(selectedId);
  assert.deepEqual(laterResult.registry, validateDataRoot(dataRoot));
  assert.equal(existsSync(lockRoot), false);
  assert.equal(existsSync(tombstoneRoot), true);
  assert.equal(
    existsSync(path.join(parent, `.${basename}.recovery-lock-released-later-release`, "lock")),
    true
  );
});

test("recovery lock release chooses a unique tombstone without overwriting a collision", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const basename = path.basename(dataRoot);
  const releaseRoot = path.join(parent, `.${basename}.recovery-lock-released-collision`);
  const existingTombstone = path.join(releaseRoot, "lock");
  const nextTombstone = path.join(`${releaseRoot}-2`, "lock");
  mkdirSync(releaseRoot, { mode: 0o700 });
  writeFileSync(existingTombstone, "existing tombstone");
  const existingIdentity = lstatSync(existingTombstone);
  const manager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "collision-owner",
    releaseTokenFactory: () => "collision",
    tokenFactory: () => "collision-restore"
  });

  const result = manager.restore(snapshotId(source.basename));

  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.equal(readFileSync(existingTombstone, "utf8"), "existing tombstone");
  assert.equal(lstatSync(existingTombstone).dev, existingIdentity.dev);
  assert.equal(lstatSync(existingTombstone).ino, existingIdentity.ino);
  assert.deepEqual(JSON.parse(readFileSync(nextTombstone, "utf8")), {
    pid: process.pid,
    token: "collision-owner"
  });
});

test("recovery lock leaves a demonstrably stale owner unchanged for every manager", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const lockRoot = path.join(parent, `.${path.basename(dataRoot)}.recovery-lock`);
  writeFileSync(
    lockRoot,
    `${JSON.stringify({ pid: 999999, token: "dead-lock-token" })}\n`,
    { flag: "wx", mode: 0o600 }
  );
  const lockBytes = readFileSync(lockRoot);
  const lockIdentity = lstatSync(lockRoot);
  let livenessChecks = 0;
  const managers = ["first", "second"].map((name) => createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => `${name}-replacement-lock-token`,
    tokenFactory: () => `${name}-stale-lock-restore-token`,
    isProcessAlive(pid) {
      livenessChecks += 1;
      assert.equal(pid, 999999);
      return false;
    }
  }));

  for (const manager of managers) {
    const error = captureError(() => manager.restore(snapshotId(source.basename)));
    assert.equal(error.statusCode, 423);
    assert.equal(error.code, "restore-lock-stale");
    assert.equal(error.message.includes(parent), false);
    assert.deepEqual(readFileSync(lockRoot), lockBytes);
    assert.equal(lstatSync(lockRoot).dev, lockIdentity.dev);
    assert.equal(lstatSync(lockRoot).ino, lockIdentity.ino);
  }

  assert.equal(livenessChecks, 2);
  assert.equal(existsSync(lockRoot), true);
  assert.equal(existsSync(source.rootDir), true);
  assert.equal(
    readdirSync(parent).some((entry) => entry.endsWith(".tmp")),
    false
  );
});

test("recovery lock leaves invalid files unchanged regardless of age", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const selectedId = snapshotId(source.basename);
  const lockRoot = path.join(parent, `.${path.basename(dataRoot)}.recovery-lock`);
  writeFileSync(lockRoot, "", { flag: "wx", mode: 0o600 });
  const manager = createDataRecoveryManager({ dataRoot });
  const lockIdentity = lstatSync(lockRoot);

  const freshError = captureError(() => manager.restore(selectedId));

  assert.equal(freshError.statusCode, 423);
  assert.equal(freshError.code, "restore-lock-invalid");
  assert.equal(freshError.message.includes(parent), false);
  assert.equal(existsSync(lockRoot), true);
  const oldTime = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(lockRoot, oldTime, oldTime);

  const staleError = captureError(() => manager.restore(selectedId));

  assert.equal(staleError.statusCode, 423);
  assert.equal(staleError.code, "restore-lock-invalid");
  assert.equal(staleError.message.includes(parent), false);
  assert.equal(existsSync(lockRoot), true);
  assert.deepEqual(readFileSync(lockRoot), Buffer.alloc(0));
  assert.equal(lstatSync(lockRoot).dev, lockIdentity.dev);
  assert.equal(lstatSync(lockRoot).ino, lockIdentity.ino);
  assert.equal(existsSync(source.rootDir), true);
});

test("committed recovery reports lock release warning and retries before another restore", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const selectedId = snapshotId(source.basename);
  const lockRoot = path.join(parent, `.${path.basename(dataRoot)}.recovery-lock`);
  let lockReleaseCalls = 0;
  let restoreTokenCalls = 0;
  const firstManager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "release-retry-lock",
    releaseTokenFactory: () => "release-retry-move",
    tokenFactory() {
      restoreTokenCalls += 1;
      return "release-retry-restore";
    },
    releaseRename(sourceRoot, targetRoot) {
      assert.equal(sourceRoot, lockRoot);
      lockReleaseCalls += 1;
      if (lockReleaseCalls <= 2) {
        throw new Error(`release failed at ${parent}`);
      }
      renameSync(sourceRoot, targetRoot);
    }
  });

  const result = firstManager.restore(selectedId);

  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.equal(path.isAbsolute(result.preRestoreBackup), false);
  assert.deepEqual(result.warnings, [{
    code: "restore-lock-release-pending",
    message: "Recovery completed, but its lock still needs cleanup."
  }]);
  assert.equal(lstatSync(lockRoot).isFile(), true);
  const retryError = captureError(() => firstManager.restore(selectedId));
  assert.equal(retryError.statusCode, 423);
  assert.equal(retryError.code, "restore-lock-release-pending");
  assert.equal(retryError.message.includes(parent), false);
  assert.equal(restoreTokenCalls, 1);
  assert.equal(existsSync(lockRoot), true);
  firstManager.dispose();
  assert.equal(lockReleaseCalls, 3);
  assert.equal(existsSync(lockRoot), false);

  const secondManager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "later-manager-lock",
    tokenFactory: () => "later-manager-restore"
  });
  const laterResult = secondManager.restore(selectedId);
  assert.deepEqual(laterResult.registry, validateDataRoot(dataRoot));
  assert.equal(existsSync(lockRoot), false);
});

test("recovery release preserves a replacement moved by the atomic rename seam", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const selectedId = snapshotId(source.basename);
  const lockRoot = path.join(parent, `.${path.basename(dataRoot)}.recovery-lock`);
  const tombstoneRoot = path.join(
    parent,
    `.${path.basename(dataRoot)}.recovery-lock-released-replacement-release`,
    "lock"
  );
  let restoreTokenCalls = 0;
  let replacementBytes;
  let replacementIdentity;
  let canonicalUnlinkCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "lost-release-lock",
    releaseTokenFactory: () => "replacement-release",
    tokenFactory() {
      restoreTokenCalls += 1;
      return "lost-release-restore";
    },
    releaseRename(sourceRoot, targetRoot) {
      assert.equal(sourceRoot, lockRoot);
      unlinkSync(sourceRoot);
      writeFileSync(
        sourceRoot,
        `${JSON.stringify({ pid: process.pid, token: "replacement-lock" })}\n`,
        { flag: "wx", mode: 0o600 }
      );
      replacementBytes = readFileSync(sourceRoot);
      replacementIdentity = lstatSync(sourceRoot);
      renameSync(sourceRoot, targetRoot);
    },
    unlink(target) {
      if (target === lockRoot || target === tombstoneRoot) {
        canonicalUnlinkCalls += 1;
      }
      unlinkSync(target);
    }
  });

  const result = manager.restore(selectedId);

  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.deepEqual(result.warnings, [{
    code: "restore-lock-release-identity-lost",
    message: "Recovery completed, but its lock ownership changed during cleanup."
  }]);
  assert.equal(canonicalUnlinkCalls, 0);
  assert.deepEqual(readFileSync(lockRoot), replacementBytes);
  assert.equal(lstatSync(lockRoot).dev, replacementIdentity.dev);
  assert.equal(lstatSync(lockRoot).ino, replacementIdentity.ino);
  assert.deepEqual(readFileSync(tombstoneRoot), replacementBytes);
  assert.equal(lstatSync(tombstoneRoot).dev, replacementIdentity.dev);
  assert.equal(lstatSync(tombstoneRoot).ino, replacementIdentity.ino);
  const retryError = captureError(() => manager.restore(selectedId));
  assert.equal(retryError.statusCode, 423);
  assert.equal(retryError.code, "restore-locked");
  assert.equal(restoreTokenCalls, 1);
  assert.deepEqual(readFileSync(lockRoot), replacementBytes);
  assert.equal(lstatSync(lockRoot).dev, replacementIdentity.dev);
  assert.equal(lstatSync(lockRoot).ino, replacementIdentity.ino);
  manager.dispose();
  assert.deepEqual(readFileSync(lockRoot), replacementBytes);
  assert.equal(lstatSync(lockRoot).dev, replacementIdentity.dev);
  assert.equal(lstatSync(lockRoot).ino, replacementIdentity.ino);
  assert.equal(canonicalUnlinkCalls, 0);
});

test("recovery releases a partially acquired lock after claimed-owner verification fails", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const selectedId = snapshotId(source.basename);
  const lockPath = path.join(parent, `.${path.basename(dataRoot)}.recovery-lock`);
  let verificationCalls = 0;
  const firstManager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "partial-claim-lock",
    tokenFactory: () => "partial-claim-restore",
    verifyClaimedLock() {
      verificationCalls += 1;
      throw new Error(`claimed owner read failed at ${parent}`);
    }
  });

  const error = captureError(() => firstManager.restore(selectedId));

  assert.equal(error.statusCode, 500);
  assert.equal(error.code, "restore-lock-acquire-failed");
  assert.equal(error.message.includes(parent), false);
  assert.equal(verificationCalls, 1);
  assert.equal(existsSync(lockPath), false);
  assert.equal(
    readdirSync(parent).some((entry) => entry.endsWith(".tmp")),
    false
  );
  firstManager.dispose();

  const secondManager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "second-partial-claim-lock",
    tokenFactory: () => "second-partial-claim-restore"
  });
  const result = secondManager.restore(selectedId);
  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.equal(existsSync(lockPath), false);
});

test("recovery never releases a replacement after partial lock acquisition", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const selectedId = snapshotId(source.basename);
  const lockPath = path.join(parent, `.${path.basename(dataRoot)}.recovery-lock`);
  const manager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "replaced-partial-lock",
    tokenFactory: () => "replaced-partial-restore",
    verifyClaimedLock(claimedPath) {
      unlinkSync(claimedPath);
      writeFileSync(
        claimedPath,
        `${JSON.stringify({ pid: process.pid, token: "foreign-owner" })}\n`,
        { flag: "wx", mode: 0o600 }
      );
      throw new Error(`claimed lock replaced at ${parent}`);
    }
  });

  const error = captureError(() => manager.restore(selectedId));

  assert.equal(error.code, "restore-lock-acquire-failed");
  assert.equal(error.message.includes(parent), false);
  assert.equal(lstatSync(lockPath).isFile(), true);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), {
    pid: process.pid,
    token: "foreign-owner"
  });
  const blockedManager = createDataRecoveryManager({
    dataRoot,
    lockTokenFactory: () => "blocked-after-replacement",
    tokenFactory: () => "unused-after-replacement"
  });
  const blocked = captureError(() => blockedManager.restore(selectedId));
  assert.equal(blocked.statusCode, 423);
  assert.equal(blocked.code, "restore-locked");
  assert.equal(existsSync(source.rootDir), true);
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

test("restore preserves owned staging when copy or staging validation fails", (t) => {
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
      releaseTokenFactory: () => `${failure}-release`,
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
    assert.deepEqual(
      readdirSync(parent).sort(),
      [
        ...entriesBefore,
        `.${path.basename(dataRoot)}.recovery-lock-released-${failure}-release`,
        path.basename(stagingRoot)
      ].sort()
    );
    assert.deepEqual(readFileSync(path.join(dataRoot, "assets/photo.svg")), officialBefore);
    assert.deepEqual(readFileSync(path.join(source.rootDir, "assets/photo.svg")), sourceBefore);
    assert.deepEqual(readFileSync(path.join(otherSnapshot.rootDir, "resumes.json")), otherBefore);
    assert.equal(validateDataRoot(stagingRoot).activeId, fixtureRegistry.activeId);
    assert.deepEqual(removeCalls, []);
    manager.dispose();
    assert.equal(existsSync(stagingRoot), true);
    assert.deepEqual(removeCalls, []);
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
  assert.equal(existsSync(stagingRoot), true);
  assert.deepEqual(removeCalls, []);
  assert.equal(manager.isRestoring(), false);
});

test("restore leaves current data and snapshots intact when the initial backup rename fails", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const otherSnapshot = writeSnapshot(dataRoot, "pre-restore-20260710-080910");
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "backup-failure-token",
    rename() {
      throw new Error(`backup rename failed at ${parent}`);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.code, "restore-backup-failed");
  assert.equal(error.message.includes(parent), false);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(existsSync(backupRoot), false);
  assert.equal(existsSync(source.rootDir), true);
  assert.equal(existsSync(otherSnapshot.rootDir), true);
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

test("restore quarantines beside a dangling path without changing the symlink", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const quarantineRoot = `${dataRoot}.failed-restore-dangling-quarantine-token`;
  const nextQuarantineRoot = `${quarantineRoot}-2`;
  const missingTarget = path.join(parent, "missing-quarantine-target");
  symlinkSync(missingTarget, quarantineRoot, process.platform === "win32" ? "junction" : "dir");
  const quarantineIdentity = lstatSync(quarantineRoot);
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "dangling-quarantine-token",
    validate(rootDir) {
      if (rootDir === dataRoot) {
        throw new Error(`final validation failed at ${parent}`);
      }
      return validateDataRoot(rootDir);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.code, "restore-final-validation-failed");
  assert.equal(error.message.includes(parent), false);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(
    readFileSync(path.join(nextQuarantineRoot, "assets/photo.svg"), "utf8"),
    "<svg>selected-source</svg>"
  );
  assert.equal(lstatSync(quarantineRoot).isSymbolicLink(), true);
  assert.equal(lstatSync(quarantineRoot).dev, quarantineIdentity.dev);
  assert.equal(lstatSync(quarantineRoot).ino, quarantineIdentity.ino);
  assert.equal(readlinkSync(quarantineRoot), missingTarget);
  assert.equal(existsSync(missingTarget), false);
  assert.equal(existsSync(source.rootDir), true);
});

test("restore preserves final-validation context when quarantine allocation fails", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  const quarantineRoot = `${dataRoot}.failed-restore-quarantine-eio-token`;
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "quarantine-eio-token",
    pathLstat(target) {
      if (target === quarantineRoot) {
        throw createPathError("EIO", target);
      }
      return lstatSync(target);
    },
    validate(rootDir) {
      if (rootDir === dataRoot) {
        throw new Error(`final validation failed at ${parent}`);
      }
      return validateDataRoot(rootDir);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 500);
  assert.equal(error.code, "restore-quarantine-failed");
  assert.match(error.message, /final validation.*could not be quarantined.*manual recovery/i);
  assert.equal(error.message.includes(parent), false);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>selected-source</svg>"
  );
  assert.equal(
    readFileSync(path.join(backupRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(existsSync(quarantineRoot), false);
  assert.equal(existsSync(source.rootDir), true);
});

test("restore preserves current and backup copies when quarantine rename fails", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  let renameCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "quarantine-failure-token",
    validate(rootDir) {
      if (rootDir === dataRoot) {
        throw new Error(`final validation failed at ${parent}`);
      }
      return validateDataRoot(rootDir);
    },
    rename(sourceRoot, targetRoot) {
      renameCalls += 1;
      if (renameCalls === 3) {
        throw new Error(`quarantine rename failed at ${parent}`);
      }
      renameSync(sourceRoot, targetRoot);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.code, "restore-quarantine-failed");
  assert.match(error.message, /final validation.*could not be quarantined.*manual recovery/i);
  assert.equal(error.message.includes(parent), false);
  assert.equal(renameCalls, 3);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>selected-source</svg>"
  );
  assert.equal(
    readFileSync(path.join(backupRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(existsSync(source.rootDir), true);
  assert.equal(manager.isRestoring(), false);
});

test("restore preserves backup and quarantine when rollback after quarantine fails", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  const quarantineRoot = `${dataRoot}.failed-restore-quarantine-rollback-token`;
  let renameCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "quarantine-rollback-token",
    validate(rootDir) {
      if (rootDir === dataRoot) {
        throw new Error(`final validation failed at ${parent}`);
      }
      return validateDataRoot(rootDir);
    },
    rename(sourceRoot, targetRoot) {
      renameCalls += 1;
      if (renameCalls === 4) {
        throw new Error(`rollback failed at ${parent}`);
      }
      renameSync(sourceRoot, targetRoot);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.code, "restore-rollback-failed");
  assert.match(error.message, /previous data could not be restored.*manual recovery/i);
  assert.equal(error.message.includes(parent), false);
  assert.equal(renameCalls, 4);
  assert.equal(existsSync(dataRoot), false);
  assert.equal(
    readFileSync(path.join(backupRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(
    readFileSync(path.join(quarantineRoot, "assets/photo.svg"), "utf8"),
    "<svg>selected-source</svg>"
  );
  assert.equal(existsSync(source.rootDir), true);
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
  assert.equal(existsSync(stagingRoot), true);
  assert.deepEqual(removeCalls, []);
  assert.equal(manager.isRestoring(), false);
});

test("restore preserves rollback failure when lock release also fails", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-priority-token`);
  const lockRoot = path.join(parent, `.${path.basename(dataRoot)}.recovery-lock`);
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
    releaseRename(sourceRoot) {
      assert.equal(sourceRoot, lockRoot);
      throw new Error(`lock release failed at ${parent}`);
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
  assert.equal(existsSync(lockRoot), true);
  assert.equal(existsSync(source.rootDir), true);
  assert.equal(manager.isRestoring(), false);
});

test("restore preserves failed staging and uses a unique path on deterministic retry", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const pendingStaging = path.join(
    parent,
    `.${path.basename(dataRoot)}.restore-pending-cleanup-token`
  );
  const retryStaging = `${pendingStaging}-2`;
  let copyCalls = 0;
  let tokenCalls = 0;
  const copyTargets = [];
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory() {
      tokenCalls += 1;
      return "pending-cleanup-token";
    },
    copy(sourceRoot, targetRoot, options) {
      copyCalls += 1;
      copyTargets.push(targetRoot);
      cpSync(sourceRoot, targetRoot, options);
      if (copyCalls === 1) {
        throw new Error(`copy failed at ${parent}`);
      }
    }
  });
  const selectedId = snapshotId(source.basename);

  const firstError = captureError(() => manager.restore(selectedId));

  assert.equal(firstError.code, "restore-copy-failed");
  assert.equal(firstError.message.includes(parent), false);
  assert.equal(validateDataRoot(pendingStaging).activeId, fixtureRegistry.activeId);
  const pendingIdentity = lstatSync(pendingStaging);

  manager.dispose();
  assert.equal(existsSync(pendingStaging), true);
  assert.equal(lstatSync(pendingStaging).dev, pendingIdentity.dev);
  assert.equal(lstatSync(pendingStaging).ino, pendingIdentity.ino);

  const result = manager.restore(selectedId);
  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.equal(tokenCalls, 2);
  assert.deepEqual(copyTargets, [pendingStaging, retryStaging]);
  assert.equal(existsSync(pendingStaging), true);
  assert.equal(lstatSync(pendingStaging).dev, pendingIdentity.dev);
  assert.equal(lstatSync(pendingStaging).ino, pendingIdentity.ino);
  assert.equal(existsSync(retryStaging), false);
  assert.equal(manager.isRestoring(), false);
});

test("restore keeps its lock active while failed staging ownership is abandoned", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-cleanup-lock-token`);
  let manager;
  let selectedId;
  let tokenCalls = 0;
  let restoringDuringRelease;
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
    releaseRename(sourceRoot, targetRoot) {
      restoringDuringRelease = manager.isRestoring();
      manager.dispose();
      stagingExistsAfterDispose = existsSync(stagingRoot);
      nestedError = captureError(() => manager.restore(selectedId));
      renameSync(sourceRoot, targetRoot);
    }
  });
  selectedId = snapshotId(source.basename);

  const error = captureError(() => manager.restore(selectedId));

  assert.equal(error.code, "restore-copy-failed");
  assert.equal(error.message.includes(parent), false);
  assert.equal(restoringDuringRelease, true);
  assert.equal(stagingExistsAfterDispose, true);
  assert.equal(nestedError.statusCode, 423);
  assert.equal(nestedError.code, "restore-locked");
  assert.equal(nestedError.message.includes(parent), false);
  assert.equal(tokenCalls, 1);
  assert.equal(existsSync(stagingRoot), true);
  assert.equal(manager.isRestoring(), false);
});

test("restore rejects unsafe tokens and allocates beside an existing staging directory", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const initialEntries = readdirSync(parent).sort();
  const unsafeManager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "../escape",
    releaseTokenFactory: () => "unsafe-token-release"
  });

  const unsafeError = captureError(() => unsafeManager.restore(snapshotId(source.basename)));

  assert.equal(unsafeError.code, "invalid-restore-token");
  assert.equal(unsafeError.message.includes(parent), false);
  assert.deepEqual(readdirSync(parent).sort(), [
    ...initialEntries,
    `.${path.basename(dataRoot)}.recovery-lock-released-unsafe-token-release`
  ].sort());
  assert.equal(unsafeManager.isRestoring(), false);

  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-existing-token`);
  mkdirSync(stagingRoot);
  writeFileSync(path.join(stagingRoot, "sentinel.txt"), "not manager owned");
  const nextStagingRoot = `${stagingRoot}-2`;
  const removeCalls = [];
  const copyTargets = [];
  const existingManager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "existing-token",
    copy(sourceRoot, targetRoot, options) {
      copyTargets.push(targetRoot);
      cpSync(sourceRoot, targetRoot, options);
    },
    remove(target, options) {
      removeCalls.push(target);
      rmSync(target, options);
    }
  });

  const result = existingManager.restore(snapshotId(source.basename));

  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.deepEqual(copyTargets, [nextStagingRoot]);
  existingManager.dispose();
  assert.equal(readFileSync(path.join(stagingRoot, "sentinel.txt"), "utf8"), "not manager owned");
  assert.deepEqual(removeCalls, []);
  assert.equal(existsSync(nextStagingRoot), false);
  assert.equal(existsSync(dataRoot), true);
  assert.equal(existsSync(source.rootDir), true);
});

test("restore allocates beside a dangling staging symlink without changing it", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-dangling-token`);
  const nextStagingRoot = `${stagingRoot}-2`;
  const missingTarget = path.join(parent, "missing-staging-target");
  symlinkSync(missingTarget, stagingRoot, process.platform === "win32" ? "junction" : "dir");
  const stagingIdentity = lstatSync(stagingRoot);
  const copyTargets = [];
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "dangling-token",
    copy(sourceRoot, targetRoot, options) {
      copyTargets.push(targetRoot);
      cpSync(sourceRoot, targetRoot, options);
    }
  });

  const result = manager.restore(snapshotId(source.basename));

  assert.deepEqual(result.registry, validateDataRoot(dataRoot));
  assert.deepEqual(copyTargets, [nextStagingRoot]);
  assert.equal(lstatSync(stagingRoot).isSymbolicLink(), true);
  assert.equal(lstatSync(stagingRoot).dev, stagingIdentity.dev);
  assert.equal(lstatSync(stagingRoot).ino, stagingIdentity.ino);
  assert.equal(readlinkSync(stagingRoot), missingTarget);
  assert.equal(existsSync(missingTarget), false);
  assert.equal(existsSync(nextStagingRoot), false);
  assert.equal(existsSync(source.rootDir), true);
});

test("restore sanitizes non-ENOENT staging allocation failures", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-staging-eacces-token`);
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "staging-eacces-token",
    pathLstat(target) {
      throw createPathError("EACCES", target);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 500);
  assert.equal(error.code, "restore-staging-reservation-failed");
  assert.equal(error.message, "A restore staging location could not be reserved.");
  assert.equal(error.message.includes(parent), false);
  assert.equal(existsSync(stagingRoot), false);
  assert.equal(existsSync(dataRoot), true);
  assert.equal(existsSync(source.rootDir), true);
});

test("restore atomically claims staging without deleting an EEXIST foreign entry", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-atomic-token`);
  const removeCalls = [];
  let stagingClaimCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "atomic-token",
    mkdir(target, options) {
      if (target !== stagingRoot) {
        return mkdirSync(target, options);
      }
      stagingClaimCalls += 1;
      assert.deepEqual(options, { recursive: false, mode: 0o700 });
      mkdirSync(target, options);
      writeFileSync(path.join(target, "sentinel.txt"), "foreign staging");
      const error = new Error(`staging already exists at ${parent}`);
      error.code = "EEXIST";
      throw error;
    },
    remove(target, options) {
      removeCalls.push(target);
      rmSync(target, options);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "restore-staging-exists");
  assert.equal(error.message.includes(parent), false);
  assert.equal(stagingClaimCalls, 1);
  assert.equal(readFileSync(path.join(stagingRoot, "sentinel.txt"), "utf8"), "foreign staging");
  assert.deepEqual(removeCalls, []);
  assert.equal(existsSync(dataRoot), true);
  assert.equal(existsSync(source.rootDir), true);
  assert.equal(manager.isRestoring(), false);
});

test("restore requires staging to be an exact regular-tree copy", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-exact-copy-token`);
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "exact-copy-token",
    copy(sourceRoot, targetRoot, options) {
      cpSync(sourceRoot, targetRoot, options);
      writeFileSync(path.join(targetRoot, "foreign.txt"), "foreign regular file");
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "restore-staging-copy-mismatch");
  assert.equal(error.message.includes(parent), false);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(
    readFileSync(path.join(source.rootDir, "assets/photo.svg"), "utf8"),
    "<svg>selected-source</svg>"
  );
  assert.equal(existsSync(stagingRoot), true);
  assert.equal(manager.isRestoring(), false);
});

test("restore rejects source mutation during the staged copy", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>source-before-copy</svg>");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-source-change-token`);
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "source-change-token",
    copy(sourceRoot, targetRoot, options) {
      cpSync(sourceRoot, targetRoot, options);
      writeFileSync(path.join(sourceRoot, "assets/photo.svg"), "<svg>source-mutated</svg>");
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "restore-source-changed");
  assert.equal(error.message.includes(parent), false);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(
    readFileSync(path.join(source.rootDir, "assets/photo.svg"), "utf8"),
    "<svg>source-mutated</svg>"
  );
  assert.equal(existsSync(stagingRoot), true);
  assert.equal(manager.isRestoring(), false);
});

test("restore rejects a replaced staging inode before publication and restores current data", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  writeFileSync(path.join(source.rootDir, "assets/photo.svg"), "<svg>selected-source</svg>");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-identity-token`);
  const backupRoot = `${dataRoot}.pre-restore-20260711-080910`;
  const removeCalls = [];
  let renameCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    now: () => new Date("2026-07-11T08:09:10.000Z"),
    tokenFactory: () => "identity-token",
    rename(sourceRoot, targetRoot) {
      renameCalls += 1;
      if (renameCalls === 1) {
        rmSync(stagingRoot, { force: true, recursive: true });
        symlinkSync(
          source.rootDir,
          stagingRoot,
          process.platform === "win32" ? "junction" : "dir"
        );
      }
      renameSync(sourceRoot, targetRoot);
    },
    remove(target, options) {
      removeCalls.push(target);
      rmSync(target, options);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "restore-staging-identity-lost");
  assert.equal(error.message.includes(parent), false);
  assert.equal(renameCalls, 2);
  assert.equal(lstatSync(dataRoot).isDirectory(), true);
  assert.equal(lstatSync(dataRoot).isSymbolicLink(), false);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(existsSync(backupRoot), false);
  assert.equal(lstatSync(stagingRoot).isSymbolicLink(), true);
  assert.equal(existsSync(source.rootDir), true);
  assert.deepEqual(removeCalls, []);
  assert.equal(manager.isRestoring(), false);
  const retryError = captureError(() => manager.restore("bad-id"));
  assert.equal(retryError.statusCode, 400);
  assert.equal(retryError.code, "invalid-snapshot-id");
  manager.dispose();
  assert.equal(lstatSync(stagingRoot).isSymbolicLink(), true);
  assert.deepEqual(removeCalls, []);
});

test("restore abandons disproven staging ownership after publication identity loss", (t) => {
  const { parent, dataRoot } = makeDataRoot(t);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>official-before</svg>");
  const source = writeSnapshot(dataRoot, "pre-import-20260710-070809");
  const stagingRoot = path.join(parent, `.${path.basename(dataRoot)}.restore-post-identity-token`);
  const quarantineRoot = `${dataRoot}.failed-restore-post-identity-token`;
  const removeCalls = [];
  let renameCalls = 0;
  const manager = createDataRecoveryManager({
    dataRoot,
    tokenFactory: () => "post-identity-token",
    rename(sourceRoot, targetRoot) {
      renameCalls += 1;
      renameSync(sourceRoot, targetRoot);
      if (renameCalls === 2) {
        rmSync(dataRoot, { force: true, recursive: true });
        mkdirSync(dataRoot);
        writeFileSync(path.join(dataRoot, "foreign.txt"), "foreign replacement");
      }
    },
    remove(target, options) {
      removeCalls.push(target);
      rmSync(target, options);
    }
  });

  const error = captureError(() => manager.restore(snapshotId(source.basename)));

  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "restore-staging-identity-lost");
  assert.equal(error.message.includes(parent), false);
  assert.equal(renameCalls, 4);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>official-before</svg>"
  );
  assert.equal(
    readFileSync(path.join(quarantineRoot, "foreign.txt"), "utf8"),
    "foreign replacement"
  );
  assert.equal(existsSync(stagingRoot), false);
  assert.deepEqual(removeCalls, []);
  const retryError = captureError(() => manager.restore("bad-id"));
  assert.equal(retryError.statusCode, 400);
  assert.equal(retryError.code, "invalid-snapshot-id");
  manager.dispose();
  assert.equal(existsSync(quarantineRoot), true);
  assert.deepEqual(removeCalls, []);
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
