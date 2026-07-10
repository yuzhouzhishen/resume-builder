import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";

import { validateDataRoot } from "./data-root.mjs";
import { resolvePathInside } from "./path-safety.mjs";

const PACKAGE_FORMAT = "resume-builder-backup";
const PACKAGE_FORMAT_VERSION = 1;
const EXPORTED_DIRECTORIES = ["resumes", "assets", "backups"];
const DEFAULT_IMPORT_LIMITS = {
  maxArchiveBytes: 50 * 1024 * 1024,
  maxFiles: 2_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 100 * 1024 * 1024
};
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000;

export function createDataPackage(options) {
  const dataRoot = path.resolve(options.dataRoot);
  const registry = validateDataRoot(dataRoot);
  const archiveFiles = new Map();

  addRegularFile(archiveFiles, dataRoot, "resumes.json");
  for (const directory of EXPORTED_DIRECTORIES) {
    const directoryPath = path.join(dataRoot, directory);
    if (existsSync(directoryPath)) {
      collectDirectoryFiles(archiveFiles, dataRoot, directory);
    }
  }

  const files = [...archiveFiles.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, bytes]) => ({
      path: filePath,
      size: bytes.byteLength,
      sha256: sha256(bytes)
    }));
  const manifest = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    createdAt: (options.now?.() || new Date()).toISOString(),
    appVersion: options.appVersion || "unknown",
    activeResumeId: registry.activeId,
    resumeCount: registry.items.length,
    resumes: registry.items.map(({ id, name }) => ({ id, name })),
    files
  };

  const entries = Object.fromEntries(archiveFiles);
  entries["manifest.json"] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return zipSync(entries, { level: 6 });
}

export function inspectDataPackage(archiveBytes, options) {
  const dataRoot = path.resolve(options.dataRoot);
  const token = validateToken(options.token);
  const limits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits };
  const archive = archiveBytes instanceof Uint8Array
    ? archiveBytes
    : new Uint8Array(archiveBytes);
  if (archive.byteLength > limits.maxArchiveBytes) {
    throw new Error(`Archive is too large: ${archive.byteLength} bytes`);
  }

  const seenPaths = new Set();
  let totalUncompressedBytes = 0;
  let fileCount = 0;
  let extracted;
  try {
    extracted = unzipSync(archive, {
      filter(entry) {
        const archivePath = validateArchivePath(entry.name);
        if (seenPaths.has(archivePath)) {
          throw new Error(`Duplicate archive path: ${archivePath}`);
        }
        seenPaths.add(archivePath);
        fileCount += 1;
        if (fileCount > limits.maxFiles) {
          throw new Error(`Archive contains too many files: ${fileCount}`);
        }
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
          throw new Error(`Archive file size is invalid: ${archivePath}`);
        }
        if (entry.originalSize > limits.maxFileBytes) {
          throw new Error(`Archive file is too large: ${archivePath}`);
        }
        totalUncompressedBytes += entry.originalSize;
        if (totalUncompressedBytes > limits.maxUncompressedBytes) {
          throw new Error(`Archive uncompressed size is too large: ${totalUncompressedBytes} bytes`);
        }
        return true;
      }
    });
  } catch (error) {
    throw new Error(`Cannot inspect ZIP archive: ${error.message}`);
  }

  const manifestBytes = extracted["manifest.json"];
  if (!manifestBytes) {
    throw new Error("Archive manifest.json is missing");
  }
  const manifest = parseManifest(manifestBytes);
  verifyArchiveFiles(extracted, manifest);

  const stagingRoot = path.join(path.dirname(dataRoot), `.resume-import-${token}`);
  if (existsSync(stagingRoot)) {
    throw new Error(`Import staging directory already exists: ${stagingRoot}`);
  }

  let stagingCreated = false;
  try {
    mkdirSync(stagingRoot);
    stagingCreated = true;
    for (const entry of manifest.files) {
      const targetPath = resolvePathInside(stagingRoot, entry.path, "Imported file path");
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, extracted[entry.path], { flag: "wx" });
    }

    const registry = validateDataRoot(stagingRoot);
    verifyManifestSummary(manifest, registry);
    return {
      token,
      stagingRoot,
      createdAt: options.now?.() || new Date(),
      summary: {
        formatVersion: manifest.formatVersion,
        createdAt: manifest.createdAt,
        appVersion: manifest.appVersion,
        activeResumeId: manifest.activeResumeId,
        resumeCount: manifest.resumeCount,
        resumes: manifest.resumes
      }
    };
  } catch (error) {
    if (stagingCreated) {
      rmSync(stagingRoot, { force: true, recursive: true });
    }
    throw error;
  }
}

export function createDataImportManager(options) {
  const dataRoot = path.resolve(options.dataRoot);
  const now = options.now || (() => new Date());
  const tokenFactory = options.tokenFactory || randomUUID;
  const rename = options.rename || renameSync;
  const pendingTtlMs = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const limits = options.limits;
  let pending = null;
  let committing = false;

  function inspect(archiveBytes) {
    if (committing) {
      throw createStatusError("A data import is already being committed", 423);
    }
    removePendingStaging();
    const token = validateToken(tokenFactory());
    pending = inspectDataPackage(archiveBytes, {
      dataRoot,
      token,
      now,
      limits
    });
    return publicPending(pending);
  }

  function commit(token) {
    const current = requirePending(token);
    committing = true;
    const backupRoot = findAvailablePath(
      `${dataRoot}.pre-import-${formatTimestamp(now())}`
    );

    try {
      rename(dataRoot, backupRoot);
      try {
        rename(current.stagingRoot, dataRoot);
      } catch (error) {
        try {
          rename(backupRoot, dataRoot);
        } catch (restoreError) {
          throw new Error(
            `Import publish failed: ${error.message}. Old data could not be restored: ${restoreError.message}`
          );
        }
        throw new Error(`Import publish failed: ${error.message}. Old data restored.`);
      }

      let registry;
      try {
        registry = validateDataRoot(dataRoot);
      } catch (error) {
        const quarantineRoot = findAvailablePath(`${dataRoot}.failed-import-${current.token}`);
        try {
          rename(dataRoot, quarantineRoot);
          rename(backupRoot, dataRoot);
        } catch (restoreError) {
          throw new Error(
            `Published data is invalid: ${error.message}. Old data could not be restored: ${restoreError.message}`
          );
        }
        pending = null;
        throw new Error(
          `Published data is invalid: ${error.message}. Old data restored. Failed import preserved at ${quarantineRoot}`
        );
      }

      pending = null;
      return {
        token: current.token,
        summary: current.summary,
        registry,
        preImportBackup: backupRoot
      };
    } finally {
      committing = false;
    }
  }

  function cancel(token) {
    if (!pending || pending.token !== token) {
      return false;
    }
    removePendingStaging();
    return true;
  }

  function dispose() {
    if (!committing) {
      removePendingStaging();
    }
  }

  function isCommitting() {
    return committing;
  }

  function requirePending(token) {
    if (!pending || pending.token !== token) {
      throw createStatusError("Unknown import token", 400);
    }
    if (now().getTime() - pending.createdAt.getTime() > pendingTtlMs) {
      removePendingStaging();
      throw createStatusError("Import token has expired", 410);
    }
    return pending;
  }

  function removePendingStaging() {
    if (!pending) {
      return;
    }
    rmSync(pending.stagingRoot, { force: true, recursive: true });
    pending = null;
  }

  return { inspect, commit, cancel, dispose, isCommitting };
}

function collectDirectoryFiles(archiveFiles, dataRoot, relativeDirectory) {
  const directoryPath = path.join(dataRoot, relativeDirectory);
  const stats = lstatSync(directoryPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Cannot export symbolic link: ${toArchivePath(relativeDirectory)}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Export path is not a directory: ${toArchivePath(relativeDirectory)}`);
  }

  for (const entry of readdirSync(directoryPath).sort()) {
    const relativePath = path.join(relativeDirectory, entry);
    const entryStats = lstatSync(path.join(dataRoot, relativePath));
    if (entryStats.isSymbolicLink()) {
      throw new Error(`Cannot export symbolic link: ${toArchivePath(relativePath)}`);
    }
    if (entryStats.isDirectory()) {
      collectDirectoryFiles(archiveFiles, dataRoot, relativePath);
      continue;
    }
    if (!entryStats.isFile()) {
      throw new Error(`Cannot export special file: ${toArchivePath(relativePath)}`);
    }
    addRegularFile(archiveFiles, dataRoot, relativePath);
  }
}

function addRegularFile(archiveFiles, dataRoot, relativePath) {
  const filePath = path.join(dataRoot, relativePath);
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Cannot export symbolic link: ${toArchivePath(relativePath)}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Cannot export non-file: ${toArchivePath(relativePath)}`);
  }
  archiveFiles.set(toArchivePath(relativePath), new Uint8Array(readFileSync(filePath)));
}

function toArchivePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateToken(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,120}$/.test(value)) {
    throw new Error("Import token is invalid");
  }
  return value;
}

function validateArchivePath(value) {
  if (
    typeof value !== "string"
    || value === ""
    || value.includes("\\")
    || value.includes("\0")
    || value.startsWith("/")
    || /^[a-zA-Z]:/.test(value)
  ) {
    throw new Error(`Invalid archive path: ${String(value)}`);
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid archive path: ${value}`);
  }

  const isAllowed = value === "manifest.json"
    || value === "resumes.json"
    || EXPORTED_DIRECTORIES.some((directory) => value.startsWith(`${directory}/`));
  if (!isAllowed) {
    throw new Error(`Unexpected archive path: ${value}`);
  }
  return value;
}

function parseManifest(bytes) {
  let manifest;
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Archive manifest is invalid: ${error.message}`);
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Archive manifest must be an object");
  }
  if (manifest.format !== PACKAGE_FORMAT) {
    throw new Error(`Unsupported archive format: ${String(manifest.format)}`);
  }
  if (manifest.formatVersion !== PACKAGE_FORMAT_VERSION) {
    throw new Error(`Unsupported archive format version: ${String(manifest.formatVersion)}`);
  }
  if (
    typeof manifest.createdAt !== "string"
    || Number.isNaN(Date.parse(manifest.createdAt))
    || typeof manifest.appVersion !== "string"
    || typeof manifest.activeResumeId !== "string"
    || !Number.isSafeInteger(manifest.resumeCount)
    || manifest.resumeCount < 1
    || !Array.isArray(manifest.resumes)
    || !Array.isArray(manifest.files)
  ) {
    throw new Error("Archive manifest fields are invalid");
  }

  const manifestPaths = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Archive manifest file entry is invalid");
    }
    const archivePath = validateArchivePath(entry.path);
    if (archivePath === "manifest.json") {
      throw new Error("Archive manifest cannot list itself");
    }
    if (manifestPaths.has(archivePath)) {
      throw new Error(`Archive manifest contains duplicate path: ${archivePath}`);
    }
    manifestPaths.add(archivePath);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256_PATTERN.test(entry.sha256)) {
      throw new Error(`Archive manifest metadata is invalid: ${archivePath}`);
    }
  }

  for (const resume of manifest.resumes) {
    if (
      !resume
      || typeof resume !== "object"
      || Array.isArray(resume)
      || typeof resume.id !== "string"
      || typeof resume.name !== "string"
    ) {
      throw new Error("Archive manifest resume summary is invalid");
    }
  }
  return manifest;
}

function verifyArchiveFiles(extracted, manifest) {
  const archivePaths = Object.keys(extracted)
    .filter((archivePath) => archivePath !== "manifest.json")
    .sort();
  const manifestPaths = manifest.files.map((entry) => entry.path).sort();
  for (const archivePath of manifestPaths) {
    if (!Object.hasOwn(extracted, archivePath)) {
      throw new Error(`Archive is missing file: ${archivePath}`);
    }
  }
  for (const archivePath of archivePaths) {
    if (!manifestPaths.includes(archivePath)) {
      throw new Error(`Archive contains extra file: ${archivePath}`);
    }
  }

  for (const entry of manifest.files) {
    const bytes = extracted[entry.path];
    if (bytes.byteLength !== entry.size) {
      throw new Error(`Archive file size mismatch: ${entry.path}`);
    }
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`Archive file hash mismatch: ${entry.path}`);
    }
  }
}

function verifyManifestSummary(manifest, registry) {
  const registrySummary = registry.items.map(({ id, name }) => ({ id, name }));
  if (
    manifest.activeResumeId !== registry.activeId
    || manifest.resumeCount !== registry.items.length
    || JSON.stringify(manifest.resumes) !== JSON.stringify(registrySummary)
  ) {
    throw new Error("Archive manifest summary does not match the resume registry");
  }
}

function publicPending(pending) {
  return {
    token: pending.token,
    stagingRoot: pending.stagingRoot,
    createdAt: pending.createdAt,
    summary: pending.summary
  };
}

function formatTimestamp(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

function findAvailablePath(basePath) {
  if (!existsSync(basePath)) {
    return basePath;
  }
  let suffix = 2;
  while (existsSync(`${basePath}-${suffix}`)) {
    suffix += 1;
  }
  return `${basePath}-${suffix}`;
}

function createStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
