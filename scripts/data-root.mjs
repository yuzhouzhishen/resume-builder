import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { resolvePathInside } from "./path-safety.mjs";
import { loadResumeYaml, saveResumeYaml, validateResume } from "./resume-data.mjs";
import {
  loadResumeRegistry,
  resolveResumePaths,
  saveResumeRegistry
} from "./resume-registry.mjs";

const MIGRATION_VERSION = 1;
const INITIAL_EXAMPLE_ID = "cpp";
const INITIAL_EXAMPLE_NAME = "C++ 示例";
const MIGRATION_MARKER = ".migration-in-progress";
const DEFAULT_READY_TIMEOUT_MS = 2_000;
const READY_POLL_INTERVAL_MS = 25;
const READY_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const LEGACY_DATA_ENTRIES = [
  "resumes.json",
  "resume.backup.yaml",
  "resumes",
  "assets",
  "backups",
  "output"
];

export function validateDataRoot(dataRoot, options = {}) {
  const resolvedRoot = path.resolve(dataRoot);
  const access = options.access || accessSync;
  try {
    const registry = loadResumeRegistry(resolvedRoot);
    const writablePaths = new Set([
      resolvedRoot,
      path.join(resolvedRoot, "resumes.json"),
      resolvePathInside(resolvedRoot, "resumes", "Resume directory path")
    ]);
    for (const entry of registry.items) {
      const paths = resolveResumePaths(resolvedRoot, registry, entry.id);
      validateResume(loadResumeYaml(paths.yaml), resolvedRoot);
      writablePaths.add(paths.yaml);
    }
    for (const [directory, label] of [
      ["assets", "Resume assets path"],
      ["backups", "Resume backup path"],
      ["output", "Resume output path"]
    ]) {
      const directoryPath = resolvePathInside(resolvedRoot, directory, label);
      if (existsSync(directoryPath)) {
        writablePaths.add(directoryPath);
      }
    }
    for (const writablePath of writablePaths) {
      try {
        access(writablePath, constants.R_OK | constants.W_OK);
      } catch (error) {
        throw new Error(`Resume data root is not writable: ${writablePath}. ${error.message}`);
      }
    }
    return registry;
  } catch (error) {
    throw new Error(`Invalid resume data root: ${resolvedRoot}\n${error.message}`);
  }
}

export function ensureDataRoot(options) {
  const projectRoot = path.resolve(options.projectRoot);
  const dataRoot = path.resolve(options.dataRoot);
  const now = options.now || (() => new Date());
  const uniqueId = options.uniqueId || randomUUID;
  const publish = options.publish || renameSync;
  const validationOptions = options.access ? { access: options.access } : {};
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const isProcessAlive = options.isProcessAlive || processIsAlive;

  if (waitForDataRootReady(dataRoot, readyTimeoutMs, { validationOptions, isProcessAlive })) {
    return {
      dataRoot,
      status: "existing",
      registry: validateDataRoot(dataRoot, validationOptions)
    };
  }

  const parentDir = path.dirname(dataRoot);
  mkdirSync(parentDir, { recursive: true });
  const migrationId = uniqueId();
  const temporaryRoot = path.join(
    parentDir,
    `.${path.basename(dataRoot)}.migrating-${migrationId}`
  );
  if (existsSync(temporaryRoot)) {
    throw new Error(`Migration workspace already exists: ${temporaryRoot}`);
  }

  const isLegacyMigration = existsSync(path.join(projectRoot, "resumes.json"));
  let expectedLegacyFingerprint;
  let publishedByThisProcess = false;
  try {
    if (isLegacyMigration) {
      const beforeCopy = fingerprintLegacyData(projectRoot);
      copyLegacyData(projectRoot, temporaryRoot);
      options.afterLegacyCopy?.();
      const afterCopy = fingerprintLegacyData(projectRoot);
      const copiedData = fingerprintLegacyData(temporaryRoot);
      if (beforeCopy !== afterCopy || afterCopy !== copiedData) {
        throw new Error(
          "Legacy resume data changed during migration. Close the old editor and retry."
        );
      }
      expectedLegacyFingerprint = afterCopy;
    } else {
      initializeFromExample(projectRoot, temporaryRoot);
    }

    const registry = validateDataRoot(temporaryRoot, validationOptions);
    writeMigrationMetadata(temporaryRoot, {
      version: MIGRATION_VERSION,
      type: isLegacyMigration ? "legacy-copy" : "example-init",
      createdAt: now().toISOString(),
      sourceRoot: projectRoot
    });
    writeMigrationMarker(temporaryRoot, {
      version: MIGRATION_VERSION,
      migrationId,
      pid: process.pid,
      createdAt: now().toISOString(),
      type: isLegacyMigration ? "legacy-copy" : "example-init",
      sourceRoot: projectRoot
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        publish(temporaryRoot, dataRoot);
        publishedByThisProcess = true;
        break;
      } catch (error) {
        if (!isExistingTargetError(error) || !existsSync(dataRoot)) {
          throw error;
        }
        if (waitForDataRootReady(dataRoot, readyTimeoutMs, { validationOptions, isProcessAlive })) {
          const publishedRegistry = validateDataRoot(dataRoot, validationOptions);
          rmSync(temporaryRoot, { force: true, recursive: true });
          return { dataRoot, status: "existing", registry: publishedRegistry };
        }
      }
    }
    if (!publishedByThisProcess) {
      throw new Error(`Could not publish resume data root after concurrent migration: ${dataRoot}`);
    }

    let publishedRegistry;
    try {
      publishedRegistry = validateDataRoot(dataRoot, validationOptions);
      if (isLegacyMigration) {
        const sourceBeforeFinalCheck = fingerprintLegacyData(projectRoot);
        const publishedData = fingerprintLegacyData(dataRoot);
        const sourceAfterFinalCheck = fingerprintLegacyData(projectRoot);
        if (
          sourceBeforeFinalCheck !== expectedLegacyFingerprint
          || sourceAfterFinalCheck !== expectedLegacyFingerprint
          || publishedData !== expectedLegacyFingerprint
        ) {
          throw new Error(
            "Legacy resume data changed during migration. Close the old editor and retry."
          );
        }
      }
      unlinkSync(path.join(dataRoot, MIGRATION_MARKER));
    } catch (error) {
      quarantinePublishedRoot(dataRoot, temporaryRoot, error);
    }

    return {
      dataRoot,
      status: isLegacyMigration ? "migrated" : "initialized",
      registry: publishedRegistry || registry
    };
  } catch (error) {
    if (!publishedByThisProcess) {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
    throw error;
  }
}

function waitForDataRootReady(dataRoot, timeoutMs, options) {
  const markerPath = path.join(dataRoot, MIGRATION_MARKER);
  const deadline = Date.now() + timeoutMs;

  while (existsSync(dataRoot) && existsSync(markerPath)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (recoverStalePublishedRoot(dataRoot, markerPath, options)) {
        return true;
      }
      throw new Error(`Resume data migration is still in progress: ${dataRoot}`);
    }
    Atomics.wait(
      READY_WAIT_BUFFER,
      0,
      0,
      Math.min(READY_POLL_INTERVAL_MS, remaining)
    );
  }

  return existsSync(dataRoot);
}

function recoverStalePublishedRoot(dataRoot, markerPath, options) {
  let marker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot inspect resume data migration marker: ${markerPath}. ${error.message}`);
  }

  if (!Number.isInteger(marker.pid) || marker.pid <= 0) {
    throw new Error(`Invalid resume data migration marker: ${markerPath}`);
  }
  if (options.isProcessAlive(marker.pid)) {
    return false;
  }

  validateDataRoot(dataRoot, options.validationOptions);
  if (marker.type === "legacy-copy") {
    if (typeof marker.sourceRoot !== "string" || !existsSync(marker.sourceRoot)) {
      throw new Error(`Stale resume data migration needs manual recovery: ${dataRoot}`);
    }
    const sourceBeforeRecovery = fingerprintLegacyData(marker.sourceRoot);
    const publishedData = fingerprintLegacyData(dataRoot);
    const sourceAfterRecovery = fingerprintLegacyData(marker.sourceRoot);
    if (
      sourceBeforeRecovery !== publishedData
      || sourceAfterRecovery !== publishedData
    ) {
      throw new Error(`Stale resume data migration preserved for manual recovery: ${dataRoot}`);
    }
  } else if (marker.type !== "example-init") {
    throw new Error(`Invalid resume data migration marker type: ${String(marker.type)}`);
  }

  try {
    unlinkSync(markerPath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return true;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function quarantinePublishedRoot(dataRoot, temporaryRoot, cause) {
  try {
    renameSync(dataRoot, temporaryRoot);
  } catch (error) {
    throw new Error(
      `${cause.message}\nMigration remains locked at ${dataRoot}; could not quarantine it: ${error.message}`
    );
  }

  throw new Error(
    `${cause.message}\nUnpublished migration preserved for inspection: ${temporaryRoot}`
  );
}

function copyLegacyData(projectRoot, temporaryRoot) {
  mkdirSync(temporaryRoot, { recursive: true });
  cpSync(path.join(projectRoot, "resumes.json"), path.join(temporaryRoot, "resumes.json"));
  const rootBackup = path.join(projectRoot, "resume.backup.yaml");
  if (existsSync(rootBackup)) {
    cpSync(rootBackup, path.join(temporaryRoot, "resume.backup.yaml"));
  }
  for (const directory of ["resumes", "assets", "backups", "output"]) {
    const source = path.join(projectRoot, directory);
    if (existsSync(source)) {
      cpSync(source, path.join(temporaryRoot, directory), { recursive: true });
    }
  }
}

function fingerprintLegacyData(rootDir) {
  const hash = createHash("sha256");
  for (const relativePath of LEGACY_DATA_ENTRIES) {
    fingerprintPath(hash, rootDir, relativePath);
  }
  return hash.digest("hex");
}

function fingerprintPath(hash, rootDir, relativePath) {
  const filePath = path.join(rootDir, relativePath);
  if (!existsSync(filePath)) {
    hash.update(`missing\0${relativePath}\0`);
    return;
  }

  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${readlinkSync(filePath)}\0`);
    return;
  }
  if (stats.isDirectory()) {
    hash.update(`directory\0${relativePath}\0`);
    for (const entry of readdirSync(filePath).sort()) {
      fingerprintPath(hash, rootDir, path.join(relativePath, entry));
    }
    return;
  }
  if (stats.isFile()) {
    hash.update(`file\0${relativePath}\0`);
    hash.update(readFileSync(filePath));
    hash.update("\0");
    return;
  }

  hash.update(`other\0${relativePath}\0${stats.mode}\0${stats.size}\0`);
}

function initializeFromExample(projectRoot, temporaryRoot) {
  const examplePath = path.join(projectRoot, "examples", `${INITIAL_EXAMPLE_ID}.yaml`);
  const resume = validateResume(loadResumeYaml(examplePath), projectRoot);
  const sourcePhoto = path.resolve(projectRoot, resume.profile.photo);
  const targetPhoto = path.resolve(temporaryRoot, resume.profile.photo);

  mkdirSync(path.join(temporaryRoot, "resumes"), { recursive: true });
  mkdirSync(path.dirname(targetPhoto), { recursive: true });
  cpSync(sourcePhoto, targetPhoto);
  saveResumeYaml(path.join(temporaryRoot, "resumes", `${INITIAL_EXAMPLE_ID}.yaml`), resume);
  saveResumeRegistry(temporaryRoot, {
    activeId: INITIAL_EXAMPLE_ID,
    items: [{
      id: INITIAL_EXAMPLE_ID,
      name: INITIAL_EXAMPLE_NAME,
      file: `resumes/${INITIAL_EXAMPLE_ID}.yaml`
    }]
  });
}

function writeMigrationMetadata(temporaryRoot, metadata) {
  writeFileSync(
    path.join(temporaryRoot, ".migration.json"),
    `${JSON.stringify(metadata, null, 2)}\n`
  );
}

function writeMigrationMarker(temporaryRoot, marker) {
  writeFileSync(
    path.join(temporaryRoot, MIGRATION_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    { flag: "wx" }
  );
}

function isExistingTargetError(error) {
  return error?.code === "EEXIST" || error?.code === "ENOTEMPTY";
}
