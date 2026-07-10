import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createResumeId,
  loadResumeRegistry,
  resolveResumeEntry,
  resolveResumePaths,
  saveResumeRegistry,
  validateResumeRegistry
} from "./resume-registry.mjs";

const validRegistry = {
  activeId: "cpp",
  items: [
    { id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" },
    { id: "ai-agent", name: "AI Agent", file: "resumes/ai-agent.yaml" }
  ]
};

function makeFixture(registry = validRegistry) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "resume-registry-test-"));
  mkdirSync(path.join(rootDir, "resumes"));
  writeFileSync(path.join(rootDir, "resumes.json"), `${JSON.stringify(registry, null, 2)}\n`);
  return rootDir;
}

test("loadResumeRegistry loads a valid manifest", () => {
  const rootDir = makeFixture();

  const registry = loadResumeRegistry(rootDir);

  assert.deepEqual(registry, validRegistry);
});

test("loadResumeRegistry reports invalid JSON clearly", () => {
  const rootDir = makeFixture();
  writeFileSync(path.join(rootDir, "resumes.json"), "{broken");

  assert.throws(() => loadResumeRegistry(rootDir), /Invalid resume registry JSON/);
});

test("validateResumeRegistry rejects duplicate ids and names", () => {
  const duplicateId = structuredClone(validRegistry);
  duplicateId.items[1].id = "cpp";
  duplicateId.items[1].file = "resumes/cpp.yaml";
  assert.throws(() => validateResumeRegistry(duplicateId), /Duplicate resume id: cpp/);

  const duplicateName = structuredClone(validRegistry);
  duplicateName.items[1].name = " c++ 应届生 ";
  assert.throws(() => validateResumeRegistry(duplicateName), /Duplicate resume name: c\+\+ 应届生/i);
});

test("validateResumeRegistry requires an existing active resume", () => {
  const registry = structuredClone(validRegistry);
  registry.activeId = "missing";

  assert.throws(() => validateResumeRegistry(registry), /activeId must reference an existing resume/);
});

test("validateResumeRegistry only accepts canonical ids and file paths", () => {
  const pathId = structuredClone(validRegistry);
  pathId.items[0].id = "../cpp";
  assert.throws(() => validateResumeRegistry(pathId), /Invalid resume id/);

  const unsafeFile = structuredClone(validRegistry);
  unsafeFile.items[0].file = "../cpp.yaml";
  assert.throws(() => validateResumeRegistry(unsafeFile), /must equal resumes\/cpp\.yaml/);
});

test("validateResumeRegistry rejects non-portable ids", () => {
  for (const id of ["con", "NUL", "com1", "lpt9", "a".repeat(81)]) {
    const registry = {
      activeId: id,
      items: [{ id, name: `Resume ${id}`, file: `resumes/${id}.yaml` }]
    };
    assert.throws(() => validateResumeRegistry(registry), /Invalid resume id/);
  }
});

test("validateResumeRegistry normalizes Unicode names before duplicate checks", () => {
  const registry = {
    activeId: "cafe-a",
    items: [
      { id: "cafe-a", name: "Café", file: "resumes/cafe-a.yaml" },
      { id: "cafe-b", name: "Cafe\u0301", file: "resumes/cafe-b.yaml" }
    ]
  };

  assert.throws(() => validateResumeRegistry(registry), /Duplicate resume name/);
});

test("resolveResumeEntry rejects unknown and path-like ids", () => {
  assert.equal(resolveResumeEntry(validRegistry, "cpp").name, "C++ 应届生");
  assert.throws(() => resolveResumeEntry(validRegistry, "missing"), /Unknown resume id: missing/);
  assert.throws(() => resolveResumeEntry(validRegistry, "../../x"), /Unknown resume id/);
});

test("resolveResumePaths returns isolated allowlisted paths", () => {
  const rootDir = makeFixture();

  const paths = resolveResumePaths(rootDir, validRegistry, "cpp");

  assert.equal(paths.yaml, path.join(rootDir, "resumes", "cpp.yaml"));
  assert.equal(paths.backupDir, path.join(rootDir, "backups", "cpp"));
  assert.equal(paths.outputDir, path.join(rootDir, "output", "cpp"));
  assert.equal(paths.previewHtml, path.join(rootDir, "output", "cpp", "preview.html"));
  assert.equal(paths.pdf, path.join(rootDir, "output", "cpp", "resume.pdf"));
  assert.equal(paths.png, path.join(rootDir, "output", "cpp", "resume.png"));
});

test("createResumeId generates stable unique ids", () => {
  assert.equal(createResumeId(validRegistry, "Backend Engineer"), "backend-engineer");
  assert.equal(createResumeId(validRegistry, "AI Agent"), "ai-agent-2");
  assert.equal(createResumeId(validRegistry, "中文简历"), "resume");

  const withFallback = structuredClone(validRegistry);
  withFallback.items.push({ id: "resume", name: "默认简历", file: "resumes/resume.yaml" });
  assert.equal(createResumeId(withFallback, "中文简历"), "resume-2");
  assert.equal(createResumeId(validRegistry, "CON"), "resume-con");
  assert.ok(createResumeId(validRegistry, "a".repeat(200)).length <= 80);
});

test("saveResumeRegistry validates and atomically replaces the manifest", () => {
  const rootDir = makeFixture();
  const registry = structuredClone(validRegistry);
  registry.activeId = "ai-agent";

  saveResumeRegistry(rootDir, registry);

  assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, "resumes.json"), "utf8")), registry);
});
