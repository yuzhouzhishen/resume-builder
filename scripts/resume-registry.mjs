import { randomUUID } from "node:crypto";
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { resolvePathInside } from "./path-safety.mjs";

const REGISTRY_FILE = "resumes.json";
const RESUME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_ID_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_RESUME_ID_LENGTH = 80;

export function loadResumeRegistry(dataRoot) {
  const filePath = resolvePathInside(dataRoot, REGISTRY_FILE, "Resume registry path");
  let raw;

  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read resume registry: ${filePath}\n${error.message}`);
  }

  let registry;
  try {
    registry = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid resume registry JSON in ${filePath}: ${error.message}`);
  }

  return validateResumeRegistry(registry);
}

export function saveResumeRegistry(dataRoot, registry) {
  validateResumeRegistry(registry);

  const filePath = resolvePathInside(dataRoot, REGISTRY_FILE, "Resume registry path");
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const raw = `${JSON.stringify(registry, null, 2)}\n`;

  try {
    writeFileSync(temporaryPath, raw, { flag: "wx" });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw new Error(`Cannot save resume registry: ${filePath}\n${error.message}`);
  }
}

export function validateResumeRegistry(registry) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    throw new Error("Resume registry must be a JSON object");
  }

  if (!Array.isArray(registry.items) || registry.items.length === 0) {
    throw new Error("Resume registry items must be a non-empty array");
  }

  const ids = new Set();
  const names = new Set();

  for (const item of registry.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Each resume registry item must be an object");
    }

    if (!isPortableResumeId(item.id)) {
      throw new Error(`Invalid resume id: ${String(item.id)}`);
    }

    if (ids.has(item.id)) {
      throw new Error(`Duplicate resume id: ${item.id}`);
    }
    ids.add(item.id);

    if (typeof item.name !== "string" || item.name.trim() === "") {
      throw new Error(`Resume name is required for id: ${item.id}`);
    }

    const normalizedName = normalizeResumeName(item.name);
    if (names.has(normalizedName)) {
      throw new Error(`Duplicate resume name: ${item.name.trim()}`);
    }
    names.add(normalizedName);

    const expectedFile = `resumes/${item.id}.yaml`;
    if (item.file !== expectedFile) {
      throw new Error(`Resume file for ${item.id} must equal ${expectedFile}`);
    }
  }

  if (typeof registry.activeId !== "string" || !ids.has(registry.activeId)) {
    throw new Error("Resume registry activeId must reference an existing resume");
  }

  return registry;
}

export function resolveResumeEntry(registry, resumeId) {
  validateResumeRegistry(registry);

  if (typeof resumeId !== "string" || !RESUME_ID_PATTERN.test(resumeId)) {
    throw new Error(`Unknown resume id: ${String(resumeId)}`);
  }

  const entry = registry.items.find((item) => item.id === resumeId);
  if (!entry) {
    throw new Error(`Unknown resume id: ${resumeId}`);
  }

  return entry;
}

export function resolveResumePaths(dataRoot, registry, resumeId) {
  const entry = resolveResumeEntry(registry, resumeId);
  const outputDir = resolvePathInside(dataRoot, path.join("output", entry.id), "Resume output path");

  return {
    yaml: resolvePathInside(dataRoot, path.join("resumes", `${entry.id}.yaml`), "Resume YAML path"),
    backupDir: resolvePathInside(dataRoot, path.join("backups", entry.id), "Resume backup path"),
    outputDir,
    previewHtml: resolvePathInside(dataRoot, path.join("output", entry.id, "preview.html"), "Resume output path"),
    pdf: resolvePathInside(dataRoot, path.join("output", entry.id, "resume.pdf"), "Resume output path"),
    png: resolvePathInside(dataRoot, path.join("output", entry.id, "resume.png"), "Resume output path")
  };
}

export function createResumeId(registry, displayName) {
  validateResumeRegistry(registry);

  const slug = truncateResumeId(slugify(displayName)) || "resume";
  const baseId = WINDOWS_RESERVED_ID_PATTERN.test(slug) ? `resume-${slug}` : slug;
  const existingIds = new Set(registry.items.map((item) => item.id));

  if (!existingIds.has(baseId)) {
    return baseId;
  }

  let suffix = 2;
  let candidate = appendIdSuffix(baseId, suffix);
  while (existingIds.has(candidate)) {
    suffix += 1;
    candidate = appendIdSuffix(baseId, suffix);
  }

  return candidate;
}

function isPortableResumeId(value) {
  return typeof value === "string"
    && value.length <= MAX_RESUME_ID_LENGTH
    && RESUME_ID_PATTERN.test(value)
    && !WINDOWS_RESERVED_ID_PATTERN.test(value);
}

function normalizeResumeName(value) {
  return value.trim().normalize("NFKC").toLowerCase();
}

function truncateResumeId(value, maxLength = MAX_RESUME_ID_LENGTH) {
  return value.slice(0, maxLength).replace(/-+$/g, "");
}

function appendIdSuffix(baseId, suffix) {
  const suffixText = `-${suffix}`;
  return `${truncateResumeId(baseId, MAX_RESUME_ID_LENGTH - suffixText.length)}${suffixText}`;
}

function slugify(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
