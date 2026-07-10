import { execFileSync } from "node:child_process";
import path from "node:path";
import { TextDecoder } from "node:util";
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
const ALLOWED_EMAILS = new Set(["noreply@github.com"]);
const MAX_TEXT_BLOB_BYTES = 2 * 1024 * 1024;
const BLOB_BATCH_SIZE = 32;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isAllowedEmail(email) {
  if (ALLOWED_EMAILS.has(email.toLowerCase())) return true;
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

function isBinaryBuffer(buffer) {
  if (buffer.includes(0)) return true;

  try {
    UTF8_DECODER.decode(buffer);
  } catch {
    return true;
  }

  return buffer.some((byte) => (
    (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)
    || byte === 127
  ));
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

    if (/(?:^|\D)(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?!\d)/.test(lineText)) {
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

function objectContentViolation(rule, { filePath, scope }, objectId) {
  return {
    rule,
    source: filePath,
    scope,
    objectId,
    message: `${filePath}: forbidden tracked content (${rule})`
  };
}

function readTrackedEntries(root) {
  const output = git(root, ["ls-files", "--stage", "-z"]);
  return output.split("\0").filter(Boolean).flatMap((record) => {
    const separator = record.indexOf("\t");
    if (separator === -1) return [];
    const [mode, objectId, stage] = record.slice(0, separator).split(" ");
    if (stage !== "0" || /^0+$/.test(objectId)) return [];
    return [{ mode, objectId, filePath: record.slice(separator + 1) }];
  });
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

function readHistoryPaths(root) {
  const output = git(root, [
    "log",
    "--all",
    "-m",
    "--name-only",
    "--format=",
    "--no-renames",
    "-z"
  ]);
  return output.split("\0").filter(Boolean);
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

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function readObjectMetadata(root, objectIds) {
  if (objectIds.length === 0) return new Map();
  const output = git(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: `${objectIds.join("\n")}\n` }
  );
  const metadata = new Map();

  for (const line of output.trim().split("\n")) {
    const [objectId, type, sizeText] = line.split(" ");
    const size = Number(sizeText);
    metadata.set(objectId, { type, size });
  }

  return metadata;
}

function parseBlobBatch(output) {
  const blobs = new Map();
  let offset = 0;

  while (offset < output.length) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd === -1) break;
    const [objectId, type, sizeText] = output.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number(sizeText);
    if (type !== "blob" || !Number.isSafeInteger(size)) break;
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    blobs.set(objectId, Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }

  return blobs;
}

function readBlobContents(root, objectIds) {
  const blobs = new Map();

  for (const objectIdChunk of chunk(objectIds, BLOB_BATCH_SIZE)) {
    const output = git(root, ["cat-file", "--batch"], {
      encoding: null,
      input: `${objectIdChunk.join("\n")}\n`,
      maxBuffer: objectIdChunk.length * (MAX_TEXT_BLOB_BYTES + 256)
    });
    for (const [objectId, buffer] of parseBlobBatch(output)) {
      blobs.set(objectId, buffer);
    }
  }

  return blobs;
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
  const trackedEntries = readTrackedEntries(repositoryRoot);
  const trackedPaths = trackedEntries.map(({ filePath }) => filePath);
  const historyObjects = readHistoryObjects(repositoryRoot);
  const historyPaths = readHistoryPaths(repositoryRoot);
  const violations = [
    ...withScope(findPathViolations(trackedPaths), "current"),
    ...withScope(findPathViolations(historyPaths), "history"),
    ...readCommitViolations(repositoryRoot)
  ];

  const objectSources = new Map();
  for (const { objectId, filePath } of trackedEntries) {
    if (!objectSources.has(objectId)) {
      objectSources.set(objectId, { filePath, scope: "current" });
    }
  }
  for (const { objectId, filePath } of historyObjects) {
    if (!objectSources.has(objectId)) {
      objectSources.set(objectId, { filePath, scope: "history" });
    }
  }

  const objectIds = [...objectSources.keys()];
  const metadata = readObjectMetadata(repositoryRoot, objectIds);
  for (const [objectId, source] of objectSources) {
    const object = metadata.get(objectId);
    if (object?.type === "blob" && object.size > MAX_TEXT_BLOB_BYTES) {
      violations.push(objectContentViolation("oversized-content", source, objectId));
    }
  }
  const textBlobIds = objectIds.filter((objectId) => {
    const object = metadata.get(objectId);
    return object?.type === "blob" && object.size <= MAX_TEXT_BLOB_BYTES;
  });
  const blobs = readBlobContents(repositoryRoot, textBlobIds);

  for (const [objectId, buffer] of blobs) {
    const { filePath, scope } = objectSources.get(objectId);
    if (isBinaryBuffer(buffer)) {
      violations.push(objectContentViolation(
        "binary-content",
        { filePath, scope },
        objectId
      ));
      continue;
    }
    violations.push(...withScope(
      findTextViolations(buffer.toString("utf8"), { source: filePath }),
      scope,
      { objectId }
    ));
  }

  const historyObjectIds = new Set(historyObjects.map(({ objectId }) => objectId));
  const historyBlobCount = [...historyObjectIds].filter(
    (objectId) => metadata.get(objectId)?.type === "blob"
  ).length;

  return {
    violations: deduplicateViolations(violations),
    stats: {
      trackedPathCount: trackedPaths.length,
      historyBlobCount,
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
