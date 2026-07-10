import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PRIVATE_PATHS = new Set([
  ".env.local",
  "resume.yaml",
  "resume.backup.yaml",
  "resumes.json"
]);

const PRIVATE_PREFIXES = ["resumes/", "backups/"];
const PRIVATE_RESEARCH_PREFIXES = ["docs/ui-audit/", "docs/reference-sites/"];
const BINARY_ARTIFACT_PATTERN = /\.(?:pdf|docx?|png|jpe?g|webp|gif|heic)$/i;
const ARCHIVE_ARTIFACT_PATTERN = /\.(?:zip|7z|rar|tar|tgz|gz)$/i;
const ALLOWED_EMAIL_DOMAINS = new Set([
  "example.com",
  "users.noreply.github.com"
]);
const MAX_TEXT_BLOB_BYTES = 2 * 1024 * 1024;

function isAllowedEmail(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.has(domain);
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options
  });
}

function pathViolation(rule, path) {
  return {
    rule,
    path,
    message: `${path}: forbidden path (${rule})`
  };
}

export function findPathViolations(paths) {
  const violations = [];

  for (const inputPath of paths) {
    const filePath = inputPath.replaceAll("\\", "/").replace(/^\.\//, "");

    if (
      PRIVATE_PATHS.has(filePath)
      || filePath === ".env"
      || (filePath.startsWith(".env.") && filePath !== ".env.example")
      || PRIVATE_PREFIXES.some((prefix) => filePath.startsWith(prefix))
    ) {
      violations.push(pathViolation("private-path", filePath));
    }

    if (filePath.startsWith("output/") && !filePath.endsWith("/.gitkeep") && filePath !== "output/.gitkeep") {
      violations.push(pathViolation("generated-output", filePath));
    }

    if (PRIVATE_RESEARCH_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      violations.push(pathViolation("private-research-artifact", filePath));
    }

    if (BINARY_ARTIFACT_PATTERN.test(filePath)) {
      violations.push(pathViolation("binary-artifact", filePath));
    }

    if (ARCHIVE_ARTIFACT_PATTERN.test(filePath)) {
      violations.push(pathViolation("archive-artifact", filePath));
    }
  }

  return violations;
}

function textViolation(rule, source, line) {
  return {
    rule,
    source,
    line,
    message: `${source}:${line}: sensitive content (${rule})`
  };
}

export function findTextViolations(text, { source = "<text>" } = {}) {
  const violations = [];
  const lines = text.split(/\r?\n/);

  for (const [index, lineText] of lines.entries()) {
    const line = index + 1;
    const emails = lineText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    for (const email of emails) {
      if (!isAllowedEmail(email)) {
        violations.push(textViolation("personal-email", source, line));
      }
    }

    if (/(?:^|\D)1[3-9]\d{9}(?!\d)/.test(lineText)) {
      violations.push(textViolation("mobile-phone", source, line));
    }

    const homeMatches = lineText.matchAll(/\/(?:Users|home)\/([A-Z0-9._-]+)/gi);
    for (const match of homeMatches) {
      if (match[1].toLowerCase() !== "tester") {
        violations.push(textViolation("absolute-home-path", source, line));
      }
    }

    const windowsHomeMatches = lineText.matchAll(/[A-Z]:\\Users\\([A-Z0-9._-]+)/gi);
    for (const match of windowsHomeMatches) {
      if (match[1].toLowerCase() !== "tester") {
        violations.push(textViolation("absolute-home-path", source, line));
      }
    }

    if (
      /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(lineText)
      || /github_pat_[A-Z0-9_]{20,}/i.test(lineText)
      || /gh[pousr]_[A-Z0-9_]{20,}/i.test(lineText)
      || /AKIA[0-9A-Z]{16}/.test(lineText)
      || /AIza[0-9A-Z_-]{30,}/i.test(lineText)
    ) {
      violations.push(textViolation("secret-token", source, line));
    }
  }

  return violations;
}

function withScope(violations, scope, extra = {}) {
  return violations.map((violation) => ({ ...violation, scope, ...extra }));
}

function readTrackedPaths(root) {
  const output = git(root, ["ls-files", "-z"]);
  return output.split("\0").filter(Boolean);
}

function readHistoryObjects(root) {
  const output = git(root, ["rev-list", "--objects", "--all"]).trim();
  if (!output) return [];

  return output.split("\n").flatMap((line) => {
    const separator = line.indexOf(" ");
    if (separator === -1) return [];
    return [{ objectId: line.slice(0, separator), filePath: line.slice(separator + 1) }];
  });
}

function readCommitViolations(root) {
  const output = git(root, ["log", "--all", "--format=%H%x00%ae%x00%ce"]);
  const violations = [];

  for (const line of output.split("\n").filter(Boolean)) {
    const [commit, authorEmail, committerEmail] = line.split("\0");
    for (const [role, email] of [["author", authorEmail], ["committer", committerEmail]]) {
      if (email && !isAllowedEmail(email)) {
        violations.push({
          rule: "commit-email",
          scope: "history",
          commit,
          message: `${commit}: sensitive commit metadata (${role} email)`
        });
      }
    }
  }

  return violations;
}

function readBlobText(root, objectId) {
  if (git(root, ["cat-file", "-t", objectId]).trim() !== "blob") return null;

  const size = Number(git(root, ["cat-file", "-s", objectId]).trim());
  if (!Number.isSafeInteger(size) || size > MAX_TEXT_BLOB_BYTES) return null;

  const buffer = git(root, ["cat-file", "blob", objectId], { encoding: null });
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

function deduplicateViolations(violations) {
  const seen = new Set();
  return violations.filter((violation) => {
    const key = [
      violation.scope,
      violation.rule,
      violation.path,
      violation.source,
      violation.line,
      violation.commit
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scanRepository(root = process.cwd()) {
  const repositoryRoot = path.resolve(root);
  const trackedPaths = readTrackedPaths(repositoryRoot);
  const historyObjects = readHistoryObjects(repositoryRoot);
  const violations = [
    ...withScope(findPathViolations(trackedPaths), "current"),
    ...withScope(
      findPathViolations(historyObjects.map(({ filePath }) => filePath)),
      "history"
    ),
    ...readCommitViolations(repositoryRoot)
  ];

  for (const filePath of trackedPaths) {
    const text = readFileSync(path.join(repositoryRoot, filePath), "utf8");
    violations.push(...withScope(
      findTextViolations(text, { source: filePath }),
      "current"
    ));
  }

  const uniqueHistoryObjects = new Map();
  for (const entry of historyObjects) {
    if (!uniqueHistoryObjects.has(entry.objectId)) {
      uniqueHistoryObjects.set(entry.objectId, entry.filePath);
    }
  }

  for (const [objectId, filePath] of uniqueHistoryObjects) {
    const text = readBlobText(repositoryRoot, objectId);
    if (text === null) continue;
    violations.push(...withScope(
      findTextViolations(text, { source: filePath }),
      "history",
      { objectId }
    ));
  }

  return {
    violations: deduplicateViolations(violations),
    stats: {
      trackedPathCount: trackedPaths.length,
      historyBlobCount: uniqueHistoryObjects.size,
      commitCount: Number(git(repositoryRoot, ["rev-list", "--count", "--all"]).trim())
    }
  };
}

function runCli() {
  const result = scanRepository();
  if (result.violations.length > 0) {
    console.error(`Privacy check failed with ${result.violations.length} violation(s):`);
    for (const violation of result.violations) {
      console.error(`- [${violation.scope}] ${violation.message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Privacy check passed: ${result.stats.trackedPathCount} tracked paths, `
    + `${result.stats.commitCount} commits, ${result.stats.historyBlobCount} history objects.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli();
}
