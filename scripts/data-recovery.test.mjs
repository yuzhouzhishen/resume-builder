import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listDataSnapshots } from "./data-recovery.mjs";
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
