import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

import { validateDataRoot } from "./data-root.mjs";

const INVALID_DATA_REASON = "Snapshot data is invalid.";
const UNSAFE_TREE_REASON = "Snapshot contains an unsafe filesystem entry.";

export function listDataSnapshots(options) {
  const dataRoot = path.resolve(options.dataRoot);
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
    })
    .map(({ summary }) => summary);
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
