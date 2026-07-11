import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { validateDataRoot } from "./data-root.mjs";

const INVALID_DATA_REASON = "Snapshot data is invalid.";
const UNSAFE_TREE_REASON = "Snapshot contains an unsafe filesystem entry.";
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const LOCK_RELEASE_WARNING = {
  code: "restore-lock-release-pending",
  message: "Recovery completed, but its lock still needs cleanup."
};

export function listDataSnapshots(options) {
  return discoverDataSnapshots(options.dataRoot).map(({ summary }) => summary);
}

export function createDataRecoveryManager(options) {
  const dataRoot = path.resolve(options.dataRoot);
  const parentDir = path.dirname(dataRoot);
  const dataBasename = path.basename(dataRoot);
  const lockPath = path.join(parentDir, `.${dataBasename}.recovery-lock`);
  const now = options.now || (() => new Date());
  const tokenFactory = options.tokenFactory || randomUUID;
  const lockTokenFactory = options.lockTokenFactory || randomUUID;
  const copy = options.copy || cpSync;
  const link = options.link || linkSync;
  const mkdir = options.mkdir || mkdirSync;
  const rename = options.rename || renameSync;
  const unlink = options.unlink || unlinkSync;
  const verifyClaimedLock = options.verifyClaimedLock || readLockOwner;
  const validate = options.validate || validateDataRoot;
  const isProcessAlive = options.isProcessAlive || processIsAlive;
  let restoring = false;
  let ownedStaging = null;
  let ownedLock = null;

  function list() {
    return discoverDataSnapshots(dataRoot).map(({ summary }) => summary);
  }

  function restore(snapshotId) {
    if (restoring) {
      throw createStatusError("A data restore is already in progress.", 423, "restore-locked");
    }
    if (ownedLock) {
      try {
        releaseOwnedLock();
      } catch {
        throw createStatusError(
          "A previous recovery transaction lock still needs cleanup.",
          423,
          "restore-lock-release-pending"
        );
      }
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

    restoring = true;

    let primaryError = null;
    let token;
    let stagingRoot;
    let backupRoot;
    let committedResult = null;
    try {
      acquireRecoveryLock();
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
      stagingRoot = findAvailablePath(
        path.join(parentDir, `.${dataBasename}.restore-${token}`)
      );

      try {
        mkdir(stagingRoot, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error.code === "EEXIST") {
          throw createStatusError(
            "Restore staging is already in use.",
            409,
            "restore-staging-exists"
          );
        }
        throw createStatusError(
          "Restore staging could not be created.",
          500,
          "restore-staging-create-failed"
        );
      }
      try {
        ownedStaging = {
          root: stagingRoot,
          identity: readDirectoryIdentity(stagingRoot)
        };
      } catch {
        throw createStatusError(
          "Restore staging ownership could not be verified.",
          409,
          "restore-staging-identity-lost"
        );
      }

      let sourceFingerprint;
      try {
        sourceFingerprint = fingerprintRegularTree(candidate.candidateRoot);
      } catch {
        throw createStatusError(
          "The selected snapshot changed before it could be copied.",
          409,
          "restore-source-changed"
        );
      }

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

      let sourceAfterCopy;
      try {
        sourceAfterCopy = fingerprintRegularTree(candidate.candidateRoot);
      } catch {
        throw createStatusError(
          "The selected snapshot changed while it was being copied.",
          409,
          "restore-source-changed"
        );
      }
      if (sourceAfterCopy !== sourceFingerprint) {
        throw createStatusError(
          "The selected snapshot changed while it was being copied.",
          409,
          "restore-source-changed"
        );
      }

      let stagingFingerprint;
      try {
        stagingFingerprint = fingerprintRegularTree(stagingRoot);
      } catch {
        throw createStatusError(
          "The staged snapshot is not a safe regular-tree copy.",
          409,
          "restore-staging-copy-mismatch"
        );
      }
      if (stagingFingerprint !== sourceFingerprint) {
        throw createStatusError(
          "The staged snapshot does not exactly match the selected snapshot.",
          409,
          "restore-staging-copy-mismatch"
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
        if (!verifyOwnedStaging()) {
          throw new Error("Restore staging ownership changed");
        }
      } catch {
        throw createStatusError(
          "Restore staging ownership changed before publication.",
          409,
          "restore-staging-identity-lost"
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
        if (!verifyOwnedStaging()) {
          throw new Error("Restore staging ownership changed");
        }
      } catch {
        try {
          rename(backupRoot, dataRoot);
        } catch {
          throw createStatusError(
            "Restore staging ownership changed and the previous data could not be restored. Manual recovery is required.",
            500,
            "restore-rollback-failed"
          );
        }
        throw createStatusError(
          "Restore staging ownership changed before publication. The previous data was restored.",
          409,
          "restore-staging-identity-lost"
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

      try {
        if (!verifyOwnedStaging(dataRoot)) {
          throw new Error("Published restore ownership changed");
        }
      } catch {
        const quarantineRoot = findAvailablePath(`${dataRoot}.failed-restore-${token}`);
        try {
          rename(dataRoot, quarantineRoot);
        } catch {
          throw createStatusError(
            "Published restore ownership changed and could not be quarantined. Manual recovery is required.",
            500,
            "restore-quarantine-failed"
          );
        }
        try {
          rename(backupRoot, dataRoot);
        } catch {
          throw createStatusError(
            "Published restore ownership changed and the previous data could not be restored. Manual recovery is required.",
            500,
            "restore-rollback-failed"
          );
        }
        throw createStatusError(
          "Published restore ownership changed. The previous data was restored and the replacement was quarantined.",
          409,
          "restore-staging-identity-lost"
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

      committedResult = {
        registry,
        preRestoreBackup: path.basename(backupRoot)
      };
      return committedResult;
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        if (ownedStaging) {
          ownedStaging = null;
        }
        if (ownedLock) {
          try {
            releaseOwnedLock();
          } catch {
            if (!primaryError && committedResult) {
              committedResult.warnings = [{ ...LOCK_RELEASE_WARNING }];
            }
          }
        }
      } finally {
        restoring = false;
      }
    }
  }

  function dispose() {
    if (restoring) {
      return;
    }
    if (ownedStaging) {
      ownedStaging = null;
    }
    if (ownedLock) {
      try {
        releaseOwnedLock();
      } catch {
        throw createStatusError(
          "The recovery transaction lock could not be released.",
          500,
          "restore-lock-release-failed"
        );
      }
    }
  }

  function acquireRecoveryLock() {
    let lockToken;
    try {
      lockToken = validateToken(lockTokenFactory());
    } catch {
      throw createStatusError(
        "A recovery transaction lock token could not be created.",
        500,
        "restore-lock-token-failed"
      );
    }

    const temporaryLockPath = path.join(
      parentDir,
      `.${dataBasename}.recovery-lock-${lockToken}-${process.pid}-1.tmp`
    );
    let temporaryOwner = null;
    try {
      writeFileSync(
        temporaryLockPath,
        `${JSON.stringify({ pid: process.pid, token: lockToken })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      temporaryOwner = readLockOwner(temporaryLockPath);
      if (temporaryOwner.pid !== process.pid || temporaryOwner.token !== lockToken) {
        throw new Error("Temporary recovery lock metadata changed");
      }

      try {
        link(temporaryLockPath, lockPath);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw classifyExistingRecoveryLock();
        }
        throw createStatusError(
          "The recovery transaction lock could not be acquired.",
          500,
          "restore-lock-acquire-failed"
        );
      }

      ownedLock = {
        path: lockPath,
        identity: temporaryOwner.identity,
        pid: process.pid,
        token: lockToken
      };
      const claimedOwner = verifyClaimedLock(lockPath);
      assertSameLockOwner(temporaryOwner, claimedOwner);
    } catch (error) {
      if (error.statusCode) {
        throw error;
      }
      throw createStatusError(
        "The recovery transaction lock could not be initialized.",
        500,
        "restore-lock-acquire-failed"
      );
    } finally {
      if (temporaryOwner) {
        try {
          const currentOwner = readLockOwner(temporaryLockPath);
          assertSameLockOwner(temporaryOwner, currentOwner);
          unlink(temporaryLockPath);
        } catch {
          // Never unlink a temporary path after its identity is lost.
        }
      }
    }
  }

  function classifyExistingRecoveryLock() {
    let owner;
    try {
      owner = readLockOwner(lockPath);
    } catch {
      return createStatusError(
        "The recovery transaction lock is invalid and requires manual cleanup.",
        423,
        "restore-lock-invalid"
      );
    }

    let alive = true;
    try {
      alive = isProcessAlive(owner.pid);
    } catch {
      // An uncertain owner must remain locked.
    }
    if (!alive) {
      return createStatusError(
        "A stale recovery transaction lock requires manual cleanup.",
        423,
        "restore-lock-stale"
      );
    }
    return createStatusError(
      "Another recovery transaction is in progress.",
      423,
      "restore-locked"
    );
  }

  function releaseOwnedLock() {
    const owner = readLockOwner(ownedLock.path);
    if (owner.pid !== ownedLock.pid || owner.token !== ownedLock.token) {
      throw new Error("Recovery lock ownership metadata changed");
    }
    if (
      owner.identity.dev !== ownedLock.identity.dev
      || owner.identity.ino !== ownedLock.identity.ino
    ) {
      throw new Error("Recovery lock identity changed");
    }
    const currentOwner = readLockOwner(ownedLock.path);
    assertSameLockOwner(owner, currentOwner);
    unlink(ownedLock.path);
    ownedLock = null;
  }

  function verifyOwnedStaging(rootDir = ownedStaging.root) {
    if (!matchesOwnedDirectory(ownedStaging, rootDir)) {
      ownedStaging = null;
      return false;
    }
    return true;
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

function readDirectoryIdentity(rootDir) {
  const stats = lstatSync(rootDir);
  if (!stats.isDirectory()) {
    throw new Error("Filesystem entry is not a real directory");
  }
  return { dev: stats.dev, ino: stats.ino };
}

function assertOwnedDirectory(ownedDirectory, rootDir = ownedDirectory.root) {
  const identity = readDirectoryIdentity(rootDir);
  if (
    identity.dev !== ownedDirectory.identity.dev
    || identity.ino !== ownedDirectory.identity.ino
  ) {
    throw new Error("Filesystem directory identity changed");
  }
}

function matchesOwnedDirectory(ownedDirectory, rootDir = ownedDirectory.root) {
  let stats;
  try {
    stats = lstatSync(rootDir);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
  return (
    stats.isDirectory()
    && stats.dev === ownedDirectory.identity.dev
    && stats.ino === ownedDirectory.identity.ino
  );
}

function readLockOwner(ownerPath) {
  const pathStats = lstatSync(ownerPath);
  if (!pathStats.isFile()) {
    throw new Error("Recovery lock owner is not a regular file");
  }
  const descriptor = openSync(
    ownerPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
  );
  try {
    const openedStats = fstatSync(descriptor);
    if (
      !openedStats.isFile()
      || openedStats.dev !== pathStats.dev
      || openedStats.ino !== pathStats.ino
    ) {
      throw new Error("Recovery lock owner identity changed");
    }
    const metadata = JSON.parse(readFileSync(descriptor, "utf8"));
    const finalStats = fstatSync(descriptor);
    if (
      finalStats.dev !== openedStats.dev
      || finalStats.ino !== openedStats.ino
      || finalStats.size !== openedStats.size
    ) {
      throw new Error("Recovery lock owner changed while being read");
    }
    if (
      !Number.isInteger(metadata.pid)
      || metadata.pid <= 0
      || typeof metadata.token !== "string"
      || !TOKEN_PATTERN.test(metadata.token)
    ) {
      throw new Error("Recovery lock owner metadata is invalid");
    }
    return {
      pid: metadata.pid,
      token: metadata.token,
      identity: { dev: openedStats.dev, ino: openedStats.ino }
    };
  } finally {
    closeSync(descriptor);
  }
}

function assertSameLockOwner(expected, actual) {
  if (
    expected.pid !== actual.pid
    || expected.token !== actual.token
    || expected.identity.dev !== actual.identity.dev
    || expected.identity.ino !== actual.identity.ino
  ) {
    throw new Error("Recovery lock owner changed");
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function fingerprintRegularTree(rootDir) {
  const hash = createHash("sha256");
  fingerprintDirectory(rootDir, "", hash, readDirectoryIdentity(rootDir));
  return hash.digest("hex");
}

function fingerprintDirectory(directory, relativeDirectory, hash, identity) {
  assertDirectoryIdentity(directory, identity);
  updateFingerprint(hash, "directory", relativeDirectory);
  const entries = readdirSync(directory).sort(compareStrings);
  assertDirectoryIdentity(directory, identity);

  for (const entry of entries) {
    const entryPath = path.join(directory, entry);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry;
    const stats = lstatSync(entryPath);
    if (stats.isDirectory()) {
      fingerprintDirectory(
        entryPath,
        relativePath,
        hash,
        { dev: stats.dev, ino: stats.ino }
      );
      continue;
    }
    if (!stats.isFile()) {
      throw new Error("Filesystem tree contains a non-regular entry");
    }

    const descriptor = openSync(
      entryPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
    );
    try {
      const openedStats = fstatSync(descriptor);
      if (
        !openedStats.isFile()
        || openedStats.dev !== stats.dev
        || openedStats.ino !== stats.ino
      ) {
        throw new Error("Filesystem file identity changed");
      }
      const bytes = readFileSync(descriptor);
      const finalStats = fstatSync(descriptor);
      if (
        finalStats.dev !== openedStats.dev
        || finalStats.ino !== openedStats.ino
        || finalStats.size !== openedStats.size
      ) {
        throw new Error("Filesystem file changed while being read");
      }
      updateFingerprint(hash, "file", relativePath, bytes);
    } finally {
      closeSync(descriptor);
    }
  }

  assertDirectoryIdentity(directory, identity);
}

function assertDirectoryIdentity(directory, expectedIdentity) {
  const identity = readDirectoryIdentity(directory);
  if (
    identity.dev !== expectedIdentity.dev
    || identity.ino !== expectedIdentity.ino
  ) {
    throw new Error("Filesystem directory identity changed");
  }
}

function updateFingerprint(hash, type, relativePath, bytes = Buffer.alloc(0)) {
  const metadata = Buffer.from(`${type}\0${relativePath}\0${bytes.byteLength}\0`, "utf8");
  hash.update(metadata);
  hash.update(bytes);
}
