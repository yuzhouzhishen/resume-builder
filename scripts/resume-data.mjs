import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import {
  LAYOUT_SETTING_KEYS,
  resolveLayoutSettings,
  validateLayoutSettings
} from "./layout-settings.mjs";
import { isSameOrNestedPath, resolvePathInside } from "./path-safety.mjs";

const REQUIRED_TOP_LEVEL = ["profile", "skills", "internships", "projects"];
const OPTIONAL_TOP_LEVEL = ["layout"];
const ALLOWED_TOP_LEVEL = [...REQUIRED_TOP_LEVEL, ...OPTIONAL_TOP_LEVEL];
const REQUIRED_PROFILE_FIELDS = ["name", "target", "school", "major", "phone", "email", "photo"];

export const DEFAULT_SECTION_ORDER = ["skills", "internships", "projects"];
export const SECTION_TITLES = {
  skills: "专业技能",
  internships: "实习经历",
  projects: "项目经历"
};

export function loadResumeYaml(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read resume YAML: ${filePath}\n${error.message}`);
  }

  try {
    return normalizeResumeData(yaml.load(raw));
  } catch (error) {
    throw new Error(`Invalid YAML in ${filePath}: ${error.message}`);
  }
}

function normalizeResumeData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  for (const section of ["skills", "internships", "projects"]) {
    if (!Array.isArray(data[section])) {
      continue;
    }

    for (const entry of data[section]) {
      if (entry && typeof entry === "object" && Array.isArray(entry.items)) {
        entry.items = entry.items.map(normalizeBulletText);
      }
    }
  }

  return data;
}

function normalizeBulletText(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [key, nestedValue] = entries[0];
      return `${key}: ${normalizeBulletText(nestedValue)}`;
    }
  }

  return String(value);
}

export function saveResumeYaml(filePath, data) {
  const raw = yaml.dump(data, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false
  });

  writeFileSync(filePath, raw.endsWith("\n") ? raw : `${raw}\n`);
}

export function validateResume(data, rootDir) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("resume.yaml must contain a YAML object");
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_TOP_LEVEL.includes(key)) {
      throw new Error(`Unsupported top-level section: ${key}`);
    }
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in data)) {
      throw new Error(`${key} is required`);
    }
  }

  if (!data.profile || typeof data.profile !== "object" || Array.isArray(data.profile)) {
    throw new Error("profile must be an object");
  }

  for (const field of REQUIRED_PROFILE_FIELDS) {
    if (!data.profile[field]) {
      throw new Error(`profile.${field} is required`);
    }
  }

  const photoPath = resolveResumeAssetPath(rootDir, data.profile.photo);
  if (!existsSync(photoPath)) {
    throw new Error(`Photo file not found: ${data.profile.photo}`);
  }
  if (!statSync(photoPath).isFile()) {
    throw new Error(`Photo file is not a regular file: ${data.profile.photo}`);
  }

  const realRoot = realpathSync(path.resolve(rootDir));
  const realPhoto = realpathSync(photoPath);
  if (!isSameOrNestedPath(realRoot, realPhoto)) {
    throw new Error(`Photo path must stay inside the resume data root: ${data.profile.photo}`);
  }

  for (const arrayKey of ["skills", "internships", "projects"]) {
    if (!Array.isArray(data[arrayKey])) {
      throw new Error(`${arrayKey} must be an array`);
    }
  }

  validateLayout(data.layout);

  return data;
}

export function resolveResumeAssetPath(rootDir, assetPath) {
  const resolvedRoot = path.resolve(rootDir);
  if (typeof assetPath !== "string" || path.isAbsolute(assetPath)) {
    throw new Error(`Photo path must stay inside the resume data root: ${String(assetPath)}`);
  }

  return resolvePathInside(resolvedRoot, assetPath, "Photo path");
}

function layoutPreferences(layout = {}) {
  return Object.fromEntries(
    LAYOUT_SETTING_KEYS
      .filter((key) => key in layout)
      .map((key) => [key, layout[key]])
  );
}

export function resolveResumeLayout(data) {
  return resolveLayoutSettings(layoutPreferences(data?.layout || {}));
}

function validateLayout(layout) {
  if (layout == null) {
    return;
  }

  if (typeof layout !== "object" || Array.isArray(layout)) {
    throw new Error("layout must be an object");
  }

  const allowedKeys = new Set(["sectionOrder", ...LAYOUT_SETTING_KEYS]);
  for (const key of Object.keys(layout)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown layout field: ${key}`);
    }
  }

  if (layout.sectionOrder != null) {
    if (!Array.isArray(layout.sectionOrder)) {
      throw new Error("layout.sectionOrder must be an array");
    }

    const seen = new Set();
    for (const section of layout.sectionOrder) {
      if (!DEFAULT_SECTION_ORDER.includes(section)) {
        throw new Error(`Unknown layout.sectionOrder section: ${section}`);
      }

      if (seen.has(section)) {
        throw new Error(`Duplicate layout.sectionOrder section: ${section}`);
      }
      seen.add(section);
    }

    for (const section of DEFAULT_SECTION_ORDER) {
      if (!seen.has(section)) {
        throw new Error(`layout.sectionOrder must include section: ${section}`);
      }
    }
  }

  validateLayoutSettings(layoutPreferences(layout));
}
