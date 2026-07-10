import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync
} from "node:fs";
import path from "node:path";

import { validateDataRoot } from "./data-root.mjs";

const INVALID_DATA_REASON = "Snapshot data is invalid.";
const UNSAFE_TREE_REASON = "Snapshot contains an unsafe filesystem entry.";
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export function listDataSnapshots(options) {
  return discoverDataSnapshots(options.dataRoot).map(({ summary }) => summary);
}

export function createDataRecoveryManager(options) {
  const dataRoot = path.resolve(options.dataRoot);
  const now = options.now || (() => new Date());
  const tokenFactory = options.tokenFactory || randomUUID;
  const copy = options.copy || cpSync;
  const rename = options.rename || renameSync;
  const validate = options.validate || validateDataRoot;
  const remove = options.remove || rmSync;
  let restoring = false;
  let ownedStaging = null;

  function list() {
    return discoverDataSnapshots(dataRoot).map(({ summary }) => summary);
  }

  function restore(snapshotId) {
    if (restoring) {
      throw createStatusError("A data restore is already in progress.", 423, "restore-locked");
    }
    if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
      throw createStatusError("Snapshot ID is invalid.", 400, "invalid-snapshot-id");
    }
    let candidate;
    try {
      candidate = discoverDataSnapshots(dataRoot)
        .find(({ summary }) => summary.id === snapshotId);
    } catch {
      throw createStatusError(
        "Snapshots could not be scanned.",
        500,
        "snapshot-scan-failed"
      );
    }
    if (!candidate) {
      throw createStatusError("Snapshot is no longer available.", 404, "snapshot-not-found");
    }
    if (!candidate.summary.valid) {
      throw createStatusError("Snapshot is not valid for restore.", 409, "snapshot-invalid");
    }

    let token;
    try {
      token = validateToken(tokenFactory());
    } catch (error) {
      if (error.code === "invalid-restore-token") {
        throw error;
      }
      throw createStatusError(
        "A restore token could not be created.",
        500,
        "restore-token-failed"
      );
    }
    const stagingRoot = path.join(
      path.dirname(dataRoot),
      `.${path.basename(dataRoot)}.restore-${token}`
    );
    if (existsSync(stagingRoot)) {
      throw createStatusError(
        "Restore staging is already in use.",
        409,
        "restore-staging-exists"
      );
    }
    restoring = true;
    ownedStaging = stagingRoot;

    let primaryError = null;
    let backupRoot;
    try {
      try {
        copy(candidate.candidateRoot, stagingRoot, {
          errorOnExist: true,
          force: false,
          recursive: true
        });
      } catch {
        throw createStatusError(
          "The selected snapshot could not be staged.",
          500,
          "restore-copy-failed"
        );
      }

      try {
        assertRegularTree(stagingRoot);
        validate(stagingRoot);
      } catch {
        throw createStatusError(
          "The staged snapshot is not valid for restore.",
          409,
          "restore-staging-invalid"
        );
      }

      try {
        backupRoot = findAvailablePath(
          `${dataRoot}.pre-restore-${formatTimestamp(now())}`
        );
      } catch {
        throw createStatusError(
          "A pre-restore backup location could not be reserved.",
          500,
          "restore-backup-reservation-failed"
        );
      }

      try {
        rename(dataRoot, backupRoot);
      } catch {
        throw createStatusError(
          "Current data could not be reserved for restore.",
          500,
          "restore-backup-failed"
        );
      }

      try {
        rename(stagingRoot, dataRoot);
      } catch {
        try {
          rename(backupRoot, dataRoot);
        } catch {
          throw createStatusError(
            "Restore publication failed and the previous data could not be restored. Manual recovery is required.",
            500,
            "restore-rollback-failed"
          );
        }
        throw createStatusError(
          "Restore publication failed. The previous data was restored.",
          500,
          "restore-publish-failed"
        );
      }

      ownedStaging = null;
      let registry;
      try {
        registry = validate(dataRoot);
      } catch {
        const quarantineRoot = findAvailablePath(`${dataRoot}.failed-restore-${token}`);
        try {
          rename(dataRoot, quarantineRoot);
        } catch {
          throw createStatusError(
            "Restored data failed final validation and could not be quarantined. Manual recovery is required.",
            500,
            "restore-quarantine-failed"
          );
        }
        try {
          rename(backupRoot, dataRoot);
        } catch {
          throw createStatusError(
            "Restored data failed final validation and the previous data could not be restored. Manual recovery is required.",
            500,
            "restore-rollback-failed"
          );
        }
        throw createStatusError(
          "Restored data failed final validation. The previous data was restored and the failed publication was quarantined.",
          500,
          "restore-final-validation-failed"
        );
      }

      return {
        registry,
        preRestoreBackup: path.basename(backupRoot)
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        if (ownedStaging) {
          try {
            removeOwnedStaging();
          } catch {
            if (!primaryError) {
              throw createStatusError(
                "Temporary restore staging could not be cleaned up.",
                500,
                "restore-cleanup-failed"
              );
            }
          }
        }
      } finally {
        restoring = false;
      }
    }
  }

  function dispose() {
    if (!restoring && ownedStaging) {
      try {
        removeOwnedStaging();
      } catch {
        throw createStatusError(
          "Temporary restore staging could not be cleaned up.",
          500,
          "restore-cleanup-failed"
        );
      }
    }
  }

  function removeOwnedStaging() {
    remove(ownedStaging, { force: true, recursive: true });
    ownedStaging = null;
  }

  function isRestoring() {
    return restoring;
  }

  return { list, restore, dispose, isRestoring };
}

function discoverDataSnapshots(dataRootOption) {
  const dataRoot = path.resolve(dataRootOption);
  const parentDir = path.dirname(dataRoot);
  const dataBasename = path.basename(dataRoot);
  const snapshotPattern = new RegExp(
    `^${escapeRegExp(dataBasename)}\\.pre-(import|restore)-`
      + "(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})(?:-(\\d+))?$"
  );
  const candidates = [];

  for (const candidateBasename of readdirSync(parentDir)) {
    const parsed = parseSnapshotBasename(candidateBasename, snapshotPattern);
    if (!parsed) {
      continue;
    }

    const summary = {
      id: createHash("sha256").update(candidateBasename).digest("hex"),
      type: parsed.type,
      createdAt: parsed.createdAt
    };
    const candidateRoot = path.join(parentDir, candidateBasename);

    try {
      assertRegularTree(candidateRoot);
    } catch {
      candidates.push({
        basename: candidateBasename,
        candidateRoot,
        timestamp: parsed.timestamp,
        summary: {
          ...summary,
          valid: false,
          code: "unsafe-tree",
          reason: UNSAFE_TREE_REASON
        }
      });
      continue;
    }

    try {
      const registry = validateDataRoot(candidateRoot);
      const activeResume = registry.items.find(({ id }) => id === registry.activeId);
      candidates.push({
        basename: candidateBasename,
        candidateRoot,
        timestamp: parsed.timestamp,
        summary: {
          ...summary,
          valid: true,
          resumeCount: registry.items.length,
          activeResumeId: registry.activeId,
          activeResumeName: activeResume.name,
          resumes: registry.items.map(({ id, name }) => ({ id, name }))
        }
      });
    } catch {
      candidates.push({
        basename: candidateBasename,
        candidateRoot,
        timestamp: parsed.timestamp,
        summary: {
          ...summary,
          valid: false,
          code: "invalid-data",
          reason: INVALID_DATA_REASON
        }
      });
    }
  }

  return candidates
    .sort((left, right) => {
      const timestampOrder = right.timestamp - left.timestamp;
      if (timestampOrder !== 0) {
        return timestampOrder;
      }
      return compareStrings(left.basename, right.basename);
    });
}

function parseSnapshotBasename(basename, pattern) {
  const match = pattern.exec(basename);
  if (!match) {
    return null;
  }

  const [, rawType, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText
  ].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) {
    return null;
  }

  return {
    type: `pre-${rawType}`,
    createdAt: date.toISOString(),
    timestamp: date.getTime()
  };
}

function assertRegularTree(rootDir) {
  const rootStats = lstatSync(rootDir);
  if (!rootStats.isDirectory()) {
    throw new Error("Snapshot root is not a directory");
  }
  inspectDirectory(rootDir);
}

function inspectDirectory(directory) {
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    const stats = lstatSync(entryPath);
    if (stats.isDirectory()) {
      inspectDirectory(entryPath);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error("Snapshot contains an unsafe filesystem entry");
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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

function validateToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw createStatusError("Restore token is invalid.", 500, "invalid-restore-token");
  }
  return token;
}

function createStatusError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
