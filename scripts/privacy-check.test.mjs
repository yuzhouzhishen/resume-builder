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
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
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

test("personal commit metadata email is rejected", () => {
  const email = ["person", "mail.example"].join("@");
  const root = makeRepository({ email });
  writeFileSync(path.join(root, "README.md"), "public fixture\n");
  commitAll(root, "Unsafe author fixture");

  const result = scanRepository(root);

  assert.equal(result.violations.some(({ rule }) => rule === "commit-email"), true);
  assert.equal(result.violations.some(({ message }) => message.includes(email)), false);
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
