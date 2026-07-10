import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { unzipSync, zipSync } from "fflate";

import {
  createDataImportManager,
  createDataPackage,
  inspectDataPackage
} from "./data-package.mjs";
import { validateDataRoot } from "./data-root.mjs";
import { saveResumeYaml } from "./resume-data.mjs";

const decoder = new TextDecoder();

const baseResume = {
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
    sectionOrder: ["internships", "skills", "projects"]
  },
  skills: [{ title: "编程", items: ["掌握基础编程能力。"] }],
  internships: [],
  projects: []
};

function makeDataRoot() {
  const parent = mkdtempSync(path.join(tmpdir(), "resume-data-package-test-"));
  const dataRoot = path.join(parent, "data");
  mkdirSync(dataRoot);
  mkdirSync(path.join(dataRoot, "resumes"));
  mkdirSync(path.join(dataRoot, "assets"));
  mkdirSync(path.join(dataRoot, "backups/cpp"), { recursive: true });
  mkdirSync(path.join(dataRoot, "output/cpp"), { recursive: true });

  const secondResume = structuredClone(baseResume);
  secondResume.profile.name = "第二位候选人";
  saveResumeYaml(path.join(dataRoot, "resumes/cpp.yaml"), baseResume);
  saveResumeYaml(path.join(dataRoot, "resumes/second.yaml"), secondResume);
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>photo</svg>");
  writeFileSync(path.join(dataRoot, "backups/cpp/resume-20260710-153000.yaml"), "backup");
  writeFileSync(path.join(dataRoot, "output/cpp/preview.html"), "generated");
  writeFileSync(path.join(dataRoot, "resumes.json"), `${JSON.stringify({
    activeId: "second",
    items: [
      { id: "cpp", name: "C++ 简历", file: "resumes/cpp.yaml" },
      { id: "second", name: "第二份简历", file: "resumes/second.yaml" }
    ]
  }, null, 2)}\n`);
  writeFileSync(path.join(dataRoot, ".env.local"), "PRIVATE=1\n");
  writeFileSync(path.join(dataRoot, ".migration.json"), "{}\n");
  writeFileSync(path.join(dataRoot, ".migration-in-progress"), "{}\n");
  writeFileSync(path.join(dataRoot, "resume.backup.yaml"), "legacy backup\n");
  return dataRoot;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeJson(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function repack(archive, mutate) {
  const files = unzipSync(archive);
  mutate(files);
  return zipSync(files, { level: 6 });
}

function updateManifestEntry(files, filePath) {
  const manifest = JSON.parse(decoder.decode(files["manifest.json"]));
  const entry = manifest.files.find((file) => file.path === filePath);
  entry.size = files[filePath].byteLength;
  entry.sha256 = sha256(files[filePath]);
  files["manifest.json"] = encodeJson(manifest);
}

test("createDataPackage exports portable resume content with a verified manifest", () => {
  const dataRoot = makeDataRoot();

  const archive = createDataPackage({
    dataRoot,
    appVersion: "0.1.0",
    now: () => new Date("2026-07-10T15:30:00.000Z")
  });
  const files = unzipSync(archive);
  const paths = Object.keys(files).sort();

  assert.deepEqual(paths, [
    "assets/photo.svg",
    "backups/cpp/resume-20260710-153000.yaml",
    "manifest.json",
    "resumes.json",
    "resumes/cpp.yaml",
    "resumes/second.yaml"
  ]);

  const manifest = JSON.parse(decoder.decode(files["manifest.json"]));
  assert.deepEqual({
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    appVersion: manifest.appVersion,
    activeResumeId: manifest.activeResumeId,
    resumeCount: manifest.resumeCount,
    resumes: manifest.resumes
  }, {
    format: "resume-builder-backup",
    formatVersion: 1,
    createdAt: "2026-07-10T15:30:00.000Z",
    appVersion: "0.1.0",
    activeResumeId: "second",
    resumeCount: 2,
    resumes: [
      { id: "cpp", name: "C++ 简历" },
      { id: "second", name: "第二份简历" }
    ]
  });
  assert.deepEqual(manifest.files.map((file) => file.path), paths.filter((entry) => entry !== "manifest.json"));
  for (const entry of manifest.files) {
    assert.equal(entry.size, files[entry.path].byteLength);
    assert.equal(entry.sha256, sha256(files[entry.path]));
  }
});

test("createDataPackage rejects symlinks in exported data", () => {
  const dataRoot = makeDataRoot();
  symlinkSync(path.join(dataRoot, "assets/photo.svg"), path.join(dataRoot, "assets/photo-link.svg"));

  assert.throws(
    () => createDataPackage({ dataRoot, appVersion: "0.1.0" }),
    /symbolic link.*assets\/photo-link\.svg/i
  );
});

test("inspectDataPackage validates and stages a portable package without changing the target", () => {
  const sourceRoot = makeDataRoot();
  const targetRoot = makeDataRoot();
  const targetRegistryBefore = readFileSync(path.join(targetRoot, "resumes.json"));
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });

  const inspected = inspectDataPackage(archive, {
    dataRoot: targetRoot,
    token: "test-token",
    now: () => new Date("2026-07-10T15:31:00.000Z")
  });

  assert.equal(inspected.token, "test-token");
  assert.equal(inspected.stagingRoot, path.join(path.dirname(targetRoot), ".resume-import-test-token"));
  assert.deepEqual(inspected.summary, {
    formatVersion: 1,
    createdAt: inspected.summary.createdAt,
    appVersion: "0.1.0",
    activeResumeId: "second",
    resumeCount: 2,
    resumes: [
      { id: "cpp", name: "C++ 简历" },
      { id: "second", name: "第二份简历" }
    ]
  });
  assert.equal(validateDataRoot(inspected.stagingRoot).activeId, "second");
  assert.equal(existsSync(path.join(inspected.stagingRoot, "output")), false);
  assert.deepEqual(readFileSync(path.join(targetRoot, "resumes.json")), targetRegistryBefore);
});

test("inspectDataPackage rejects unsafe and unknown archive paths before writing", () => {
  const sourceRoot = makeDataRoot();
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });

  for (const unsafePath of ["../outside.txt", "/absolute.txt", "resumes\\evil.yaml", "unknown.txt"]) {
    const targetRoot = makeDataRoot();
    const invalidArchive = repack(archive, (files) => {
      files[unsafePath] = new TextEncoder().encode("unsafe");
    });

    assert.throws(
      () => inspectDataPackage(invalidArchive, { dataRoot: targetRoot, token: "unsafe-token" }),
      /archive path|unexpected archive path/i
    );
    assert.equal(existsSync(path.join(path.dirname(targetRoot), ".resume-import-unsafe-token")), false);
  }
});

test("inspectDataPackage rejects missing extra and hash-mismatched files", () => {
  const sourceRoot = makeDataRoot();
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  const cases = [
    {
      label: "missing",
      mutate(files) {
        delete files["assets/photo.svg"];
      },
      error: /missing.*assets\/photo\.svg/i
    },
    {
      label: "extra",
      mutate(files) {
        files["assets/extra.svg"] = new TextEncoder().encode("extra");
      },
      error: /extra.*assets\/extra\.svg/i
    },
    {
      label: "hash",
      mutate(files) {
        files["assets/photo.svg"] = new TextEncoder().encode("<svg>other</svg>");
      },
      error: /hash.*assets\/photo\.svg/i
    }
  ];

  for (const testCase of cases) {
    const targetRoot = makeDataRoot();
    const invalidArchive = repack(archive, testCase.mutate);
    assert.throws(
      () => inspectDataPackage(invalidArchive, { dataRoot: targetRoot, token: `${testCase.label}-token` }),
      testCase.error
    );
  }
});

test("inspectDataPackage rejects invalid manifest versions and summaries", () => {
  const sourceRoot = makeDataRoot();
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  const targetRoot = makeDataRoot();
  const invalidVersion = repack(archive, (files) => {
    const manifest = JSON.parse(decoder.decode(files["manifest.json"]));
    manifest.formatVersion = 99;
    files["manifest.json"] = encodeJson(manifest);
  });
  const invalidSummary = repack(archive, (files) => {
    const manifest = JSON.parse(decoder.decode(files["manifest.json"]));
    manifest.resumeCount = 7;
    files["manifest.json"] = encodeJson(manifest);
  });

  assert.throws(
    () => inspectDataPackage(invalidVersion, { dataRoot: targetRoot, token: "version-token" }),
    /unsupported.*version/i
  );
  assert.throws(
    () => inspectDataPackage(invalidSummary, { dataRoot: targetRoot, token: "summary-token" }),
    /summary.*registry/i
  );
});

test("inspectDataPackage validates staged yaml and referenced photos", () => {
  const sourceRoot = makeDataRoot();
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  const invalidYaml = repack(archive, (files) => {
    files["resumes/cpp.yaml"] = new TextEncoder().encode("profile: [broken\n");
    updateManifestEntry(files, "resumes/cpp.yaml");
  });

  assert.throws(
    () => inspectDataPackage(invalidYaml, { dataRoot: makeDataRoot(), token: "yaml-token" }),
    /invalid yaml/i
  );
});

test("inspectDataPackage enforces archive file and uncompressed size limits", () => {
  const sourceRoot = makeDataRoot();
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  const targetRoot = makeDataRoot();
  const cases = [
    [{ maxArchiveBytes: 1 }, /archive.*too large/i],
    [{ maxFiles: 1 }, /too many files/i],
    [{ maxFileBytes: 1 }, /file.*too large/i],
    [{ maxUncompressedBytes: 1 }, /uncompressed.*too large/i]
  ];

  for (const [limits, error] of cases) {
    assert.throws(
      () => inspectDataPackage(archive, {
        dataRoot: targetRoot,
        token: `limit-${Object.keys(limits)[0]}`,
        limits
      }),
      error
    );
  }
});

test("data import manager keeps one pending package and supports cancel and dispose", () => {
  const sourceRoot = makeDataRoot();
  const targetRoot = makeDataRoot();
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  const tokens = ["first-token", "second-token", "third-token"];
  const manager = createDataImportManager({
    dataRoot: targetRoot,
    tokenFactory: () => tokens.shift(),
    now: () => new Date("2026-07-10T15:31:00.000Z")
  });

  const first = manager.inspect(archive);
  const second = manager.inspect(archive);
  assert.equal(existsSync(first.stagingRoot), false);
  assert.equal(existsSync(second.stagingRoot), true);

  assert.equal(manager.cancel(second.token), true);
  assert.equal(existsSync(second.stagingRoot), false);
  assert.equal(manager.cancel(second.token), false);

  const third = manager.inspect(archive);
  manager.dispose();
  assert.equal(existsSync(third.stagingRoot), false);
});

test("data import manager expires pending packages without changing official data", () => {
  const sourceRoot = makeDataRoot();
  const targetRoot = makeDataRoot();
  const originalRegistry = readFileSync(path.join(targetRoot, "resumes.json"));
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  let now = new Date("2026-07-10T15:31:00.000Z");
  const manager = createDataImportManager({
    dataRoot: targetRoot,
    tokenFactory: () => "expired-token",
    now: () => now,
    pendingTtlMs: 15 * 60 * 1000
  });
  const pending = manager.inspect(archive);
  now = new Date("2026-07-10T15:47:00.000Z");

  assert.throws(() => manager.commit(pending.token), /expired/i);
  assert.equal(existsSync(pending.stagingRoot), false);
  assert.deepEqual(readFileSync(path.join(targetRoot, "resumes.json")), originalRegistry);
});

test("data import manager atomically replaces data and preserves a unique pre-import backup", () => {
  const sourceRoot = makeDataRoot();
  const targetRoot = makeDataRoot();
  writeFileSync(path.join(targetRoot, "assets/photo.svg"), "<svg>old-photo</svg>");
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  const expectedBaseBackup = `${targetRoot}.pre-import-20260710-153100`;
  mkdirSync(expectedBaseBackup);
  const manager = createDataImportManager({
    dataRoot: targetRoot,
    tokenFactory: () => "commit-token",
    now: () => new Date("2026-07-10T15:31:00.000Z")
  });
  const pending = manager.inspect(archive);

  const result = manager.commit(pending.token);

  assert.equal(result.preImportBackup, `${expectedBaseBackup}-2`);
  assert.equal(readFileSync(path.join(targetRoot, "assets/photo.svg"), "utf8"), "<svg>photo</svg>");
  assert.equal(readFileSync(path.join(result.preImportBackup, "assets/photo.svg"), "utf8"), "<svg>old-photo</svg>");
  assert.equal(existsSync(path.join(result.preImportBackup, "output/cpp/preview.html")), true);
  assert.equal(existsSync(path.join(targetRoot, "output")), false);
  assert.equal(validateDataRoot(targetRoot).activeId, "second");
  assert.equal(manager.isCommitting(), false);
  assert.throws(() => manager.commit(pending.token), /unknown.*token/i);
});

test("data import manager restores the old root when publishing staging fails", () => {
  const sourceRoot = makeDataRoot();
  const targetRoot = makeDataRoot();
  writeFileSync(path.join(targetRoot, "assets/photo.svg"), "<svg>old-photo</svg>");
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  let renameCalls = 0;
  let manager;
  manager = createDataImportManager({
    dataRoot: targetRoot,
    tokenFactory: () => "rollback-token",
    now: () => new Date("2026-07-10T15:31:00.000Z"),
    rename(source, destination) {
      renameCalls += 1;
      assert.equal(manager.isCommitting(), true);
      if (renameCalls === 2) {
        const error = new Error("publish failed");
        error.code = "EIO";
        throw error;
      }
      renameSync(source, destination);
    }
  });
  const pending = manager.inspect(archive);

  assert.throws(() => manager.commit(pending.token), /publish failed.*old data restored/is);
  assert.equal(readFileSync(path.join(targetRoot, "assets/photo.svg"), "utf8"), "<svg>old-photo</svg>");
  assert.equal(existsSync(pending.stagingRoot), true);
  assert.equal(manager.isCommitting(), false);
});

test("data import manager quarantines invalid published data and restores the old root", () => {
  const sourceRoot = makeDataRoot();
  const targetRoot = makeDataRoot();
  writeFileSync(path.join(targetRoot, "assets/photo.svg"), "<svg>old-photo</svg>");
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  const manager = createDataImportManager({
    dataRoot: targetRoot,
    tokenFactory: () => "invalid-publish-token",
    now: () => new Date("2026-07-10T15:31:00.000Z")
  });
  const pending = manager.inspect(archive);
  rmSync(path.join(pending.stagingRoot, "assets/photo.svg"));

  assert.throws(() => manager.commit(pending.token), /published data is invalid.*old data restored/is);
  assert.equal(readFileSync(path.join(targetRoot, "assets/photo.svg"), "utf8"), "<svg>old-photo</svg>");
  assert.equal(
    existsSync(`${targetRoot}.failed-import-invalid-publish-token`),
    true
  );
  assert.equal(manager.isCommitting(), false);
});
