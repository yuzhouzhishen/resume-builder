import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findPathViolations,
  findTextViolations,
  scanRepository
} from "./privacy-check.mjs";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function makeRepository({ email = "tester@users.noreply.github.com" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "resume-privacy-test-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Privacy Test");
  git(root, "config", "user.email", email);
  return root;
}

function commitAll(root, message) {
  git(root, "add", ".");
  git(root, "commit", "-m", message);
}

test("public source and fictional example paths are allowed", () => {
  const violations = findPathViolations([
    ".env.example",
    "examples/cpp.yaml",
    "assets/photo.svg",
    "output/.gitkeep",
    "editor/app.js"
  ]);

  assert.deepEqual(violations, []);
});

test("private runtime generated and binary artifact paths are rejected", () => {
  const violations = findPathViolations([
    ".env.local",
    ".env.production",
    "resume.yaml",
    "resumes.json",
    "resumes/private.yaml",
    "backups/private/backup.yaml",
    "output/private/resume.pdf",
    "assets/photo.png",
    "docs/ui-audit/private.png",
    "private-data.zip"
  ]);

  assert.deepEqual(
    new Set(violations.map(({ rule }) => rule)),
    new Set([
      "private-path",
      "generated-output",
      "binary-artifact",
      "private-research-artifact",
      "archive-artifact"
    ])
  );
  assert.equal(
    violations.some(({ rule, path }) => rule === "private-path" && path === ".env.production"),
    true
  );
});

test("fictional contact data and test home paths are allowed", () => {
  const text = [
    "candidate@example.com",
    "yuzhouzhishen@users.noreply.github.com",
    "/Users/tester/Documents/Resume Builder",
    "000-0000-0000"
  ].join("\n");

  assert.deepEqual(findTextViolations(text, { source: "fixture.txt" }), []);
});

test("personal contact paths and credentials are rejected without echoing values", () => {
  const personalEmail = ["person", "mail.example"].join("@");
  const mobile = ["138", "1234", "5678"].join("");
  const homePath = ["/Users", "private-user", "resume"].join("/");
  const token = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz"].join("");
  const text = [personalEmail, mobile, homePath, token].join("\n");

  const violations = findTextViolations(text, { source: "fixture.txt" });

  assert.deepEqual(
    new Set(violations.map(({ rule }) => rule)),
    new Set([
      "personal-email",
      "mobile-phone",
      "absolute-home-path",
      "secret-token"
    ])
  );
  assert.equal(violations.some(({ message }) => message.includes(personalEmail)), false);
  assert.equal(violations.some(({ message }) => message.includes(mobile)), false);
  assert.equal(violations.some(({ message }) => message.includes(token)), false);
});

test("Windows user home paths are rejected", () => {
  const homePath = ["C:", "Users", "private-user", "resume"].join("\\");
  const violations = findTextViolations(homePath, { source: "fixture.txt" });

  assert.equal(violations.some(({ rule }) => rule === "absolute-home-path"), true);
});

test("formatted mainland mobile numbers are rejected", () => {
  const variants = [
    ["138", "1234", "5678"].join("-"),
    ["138", "1234", "5678"].join(" "),
    ["+86", "138", "1234", "5678"].join(" ")
  ];

  for (const value of variants) {
    const violations = findTextViolations(value, { source: "fixture.txt" });
    assert.equal(
      violations.some(({ rule }) => rule === "mobile-phone"),
      true,
      `expected formatted mobile variant ${variants.indexOf(value) + 1} to be rejected`
    );
  }
});

test("a clean repository and its safe history pass", () => {
  const root = makeRepository();
  writeFileSync(path.join(root, "README.md"), "candidate@example.com\n");
  commitAll(root, "Initial public fixture");

  const result = scanRepository(root);

  assert.deepEqual(result.violations, []);
  assert.equal(result.stats.commitCount, 1);
  assert.equal(result.stats.trackedPathCount, 1);
});

test("a private path remains rejected after deletion from the current tree", () => {
  const root = makeRepository();
  mkdirSync(path.join(root, "resumes"));
  writeFileSync(path.join(root, "resumes", "private.yaml"), "private fixture\n");
  commitAll(root, "Add forbidden fixture");
  rmSync(path.join(root, "resumes"), { recursive: true });
  commitAll(root, "Remove forbidden fixture");

  const result = scanRepository(root);

  assert.equal(result.violations.some(({ rule }) => rule === "private-path"), true);
  assert.equal(result.violations.some(({ scope }) => scope === "history"), true);
});

test("history rejects a private path that reused an existing public blob", () => {
  const root = makeRepository();
  const sharedContent = "public fixture\n";
  writeFileSync(path.join(root, "README.md"), sharedContent);
  commitAll(root, "Add public blob");
  mkdirSync(path.join(root, "resumes"));
  writeFileSync(path.join(root, "resumes", "private.yaml"), sharedContent);
  commitAll(root, "Reuse blob at forbidden path");
  rmSync(path.join(root, "resumes"), { recursive: true });
  commitAll(root, "Remove reused path");

  const result = scanRepository(root);

  assert.equal(
    result.violations.some(({ rule, scope }) => rule === "private-path" && scope === "history"),
    true
  );
});

test("history rejects a private path introduced and removed only by merge commits", () => {
  const root = makeRepository();
  writeFileSync(path.join(root, "README.md"), "public fixture\n");
  commitAll(root, "Base fixture");

  git(root, "checkout", "-b", "right");
  writeFileSync(path.join(root, "right.txt"), "right\n");
  commitAll(root, "Right parent");
  git(root, "checkout", "main");
  writeFileSync(path.join(root, "left.txt"), "left\n");
  commitAll(root, "Left parent");
  git(root, "merge", "--no-ff", "--no-commit", "right");
  mkdirSync(path.join(root, "resumes"));
  writeFileSync(path.join(root, "resumes", "private.yaml"), "merge-only fixture\n");
  commitAll(root, "Merge with forbidden path");

  git(root, "checkout", "-b", "cleanup-side");
  writeFileSync(path.join(root, "side.txt"), "side\n");
  commitAll(root, "Cleanup side parent");
  git(root, "checkout", "main");
  writeFileSync(path.join(root, "main.txt"), "main\n");
  commitAll(root, "Cleanup main parent");
  git(root, "merge", "--no-ff", "--no-commit", "cleanup-side");
  rmSync(path.join(root, "resumes"), { recursive: true });
  commitAll(root, "Merge removing forbidden path");

  const result = scanRepository(root);

  assert.equal(
    result.violations.some(({ rule, scope }) => rule === "private-path" && scope === "history"),
    true
  );
});

test("current scan reads staged content instead of an unstaged worktree replacement", () => {
  const root = makeRepository();
  const filePath = path.join(root, "README.md");
  writeFileSync(filePath, "candidate@example.com\n");
  commitAll(root, "Add safe fixture");
  const personalEmail = ["person", "mail.example"].join("@");
  writeFileSync(filePath, `${personalEmail}\n`);
  git(root, "add", "README.md");
  writeFileSync(filePath, "candidate@example.com\n");

  const result = scanRepository(root);

  assert.equal(
    result.violations.some(({ rule, scope }) => rule === "personal-email" && scope === "current"),
    true
  );
});

test("personal commit metadata email is rejected", () => {
  const email = ["person", "mail.example"].join("@");
  const root = makeRepository({ email });
  writeFileSync(path.join(root, "README.md"), "public fixture\n");
  commitAll(root, "Unsafe author fixture");

  const result = scanRepository(root);

  assert.equal(result.violations.some(({ rule }) => rule === "commit-email"), true);
  assert.equal(result.violations.some(({ message }) => message.includes(email)), false);
});

test("GitHub generated noreply commit metadata is allowed", () => {
  const root = makeRepository({ email: "noreply@github.com" });
  writeFileSync(path.join(root, "README.md"), "public fixture\n");
  commitAll(root, "GitHub merge fixture");

  const result = scanRepository(root);

  assert.equal(result.violations.some(({ rule }) => rule === "commit-email"), false);
});

test("extensionless binary and oversized text blobs are rejected", () => {
  const root = makeRepository();
  const binary = Buffer.from([1, 2, 3, 4]);
  assert.equal(binary.includes(0), false);
  writeFileSync(path.join(root, "payload"), binary);
  writeFileSync(path.join(root, "large.txt"), "x".repeat(2 * 1024 * 1024 + 1));
  commitAll(root, "Add opaque fixtures");

  const result = scanRepository(root);

  assert.equal(result.violations.some(({ rule }) => rule === "binary-content"), true);
  assert.equal(result.violations.some(({ rule }) => rule === "oversized-content"), true);
});

test("package scripts run privacy checks locally and in CI", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );

  assert.equal(packageJson.scripts["privacy:check"], "node scripts/privacy-check.mjs");
  assert.equal(packageJson.scripts.ci, "npm test");
  assert.match(packageJson.scripts.test, /^npm run privacy:check && /);
  assert.match(packageJson.scripts.test, /scripts\/ci-workflow\.test\.mjs/);
  assert.match(packageJson.scripts.test, /scripts\/privacy-check\.test\.mjs/);
});
