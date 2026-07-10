import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { canonicalizePath, isSameOrNestedPath } from "./path-safety.mjs";

const DATA_DIR_KEY = "RESUME_BUILDER_DATA_DIR";

export function readLocalEnv(projectRoot) {
  const envPath = path.join(path.resolve(projectRoot), ".env.local");
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw new Error(`Cannot read ${envPath}: ${error.message}`);
  }

  try {
    return { ...parseEnv(raw) };
  } catch (error) {
    throw new Error(`Cannot parse ${envPath}: ${error.message}`);
  }
}

export function resolveAppPaths(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || ".");
  const homeDir = path.resolve(options.homeDir || homedir());
  const env = options.env || process.env;
  const localEnv = options.localEnv || readLocalEnv(projectRoot);

  let configured;
  let source;
  if (Object.hasOwn(env, DATA_DIR_KEY)) {
    configured = env[DATA_DIR_KEY];
    source = "environment";
  } else if (Object.hasOwn(localEnv, DATA_DIR_KEY)) {
    configured = localEnv[DATA_DIR_KEY];
    source = ".env.local";
  } else {
    configured = path.join(homeDir, "Documents", "Resume Builder");
    source = "default";
  }

  const dataRoot = resolveConfiguredDataRoot(configured, homeDir);
  const canonicalProjectRoot = canonicalizePath(projectRoot);
  const canonicalDataRoot = canonicalizePath(dataRoot);
  if (isSameOrNestedPath(canonicalProjectRoot, canonicalDataRoot)) {
    throw new Error("RESUME_BUILDER_DATA_DIR must be outside the project root");
  }

  return { projectRoot, dataRoot, source };
}

function resolveConfiguredDataRoot(value, homeDir) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("RESUME_BUILDER_DATA_DIR must not be blank");
  }

  const configured = value.trim();
  const expanded = configured === "~"
    ? homeDir
    : configured.startsWith(`~${path.sep}`)
      ? path.join(homeDir, configured.slice(2))
      : configured;

  if (!path.isAbsolute(expanded)) {
    throw new Error("RESUME_BUILDER_DATA_DIR must be absolute or start with ~/");
  }

  return path.resolve(expanded);
}
