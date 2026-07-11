#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateResume as defaultGenerateResume, renderResumeHtml } from "./generate.mjs";
import { resolveAppPaths } from "./app-paths.mjs";
import { createDataImportManager, createDataPackage } from "./data-package.mjs";
import { createDataRecoveryManager } from "./data-recovery.mjs";
import { ensureDataRoot } from "./data-root.mjs";
import { resolvePathInside } from "./path-safety.mjs";
import {
  loadResumeYaml,
  resolveResumeAssetPath,
  saveResumeYaml,
  validateResume
} from "./resume-data.mjs";
import {
  createResumeId,
  loadResumeRegistry,
  resolveResumeEntry,
  resolveResumePaths,
  saveResumeRegistry,
  validateResumeRegistry
} from "./resume-registry.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4321;
const DEFAULT_MAX_PORT = 4330;
const DEFAULT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_PHOTO_LIMIT_BYTES = 5 * 1024 * 1024;
const DEFAULT_DATA_ARCHIVE_LIMIT_BYTES = 50 * 1024 * 1024;
const BACKUP_DIR = "backups";
const BACKUP_FILE_PATTERN = /^resume-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.yaml$/;
const SNAPSHOT_ID_PATTERN = /^[a-f0-9]{64}$/;
const DATA_RECOVERY_PUBLIC_ERRORS = new Map([
  ["invalid-snapshot-id", [400, "Snapshot ID is invalid."]],
  ["snapshot-not-found", [404, "Snapshot is no longer available."]],
  ["snapshot-invalid", [409, "Snapshot is not valid for restore."]],
  ["restore-staging-exists", [409, "Restore staging is already in use."]],
  ["restore-staging-reservation-failed", [500, "A restore staging location could not be reserved."]],
  ["restore-staging-identity-lost", [409, "Restore staging ownership changed during restore."]],
  ["restore-source-changed", [409, "The selected snapshot changed during restore."]],
  ["restore-staging-copy-mismatch", [409, "The staged snapshot does not match the selected snapshot."]],
  ["restore-staging-invalid", [409, "The staged snapshot is not valid for restore."]],
  ["restore-locked", [423, "Another data restore is in progress."]],
  ["snapshot-scan-failed", [500, "Snapshots could not be scanned."]],
  ["invalid-restore-token", [500, "Restore token is invalid."]],
  ["restore-token-failed", [500, "A restore token could not be created."]],
  ["restore-staging-create-failed", [500, "Restore staging could not be created."]],
  ["restore-copy-failed", [500, "The selected snapshot could not be staged."]],
  ["restore-backup-reservation-failed", [500, "A pre-restore backup location could not be reserved."]],
  ["restore-backup-failed", [500, "Current data could not be reserved for restore."]],
  ["restore-rollback-failed", [500, "The previous data could not be restored. Manual recovery is required."]],
  ["restore-publish-failed", [500, "Restore publication failed. The previous data was restored."]],
  ["restore-quarantine-failed", [500, "Failed restore data could not be quarantined. Manual recovery is required."]],
  ["restore-final-validation-failed", [500, "Restored data failed final validation. The previous data was restored."]]
]);
const EXAMPLES = [
  { id: "cpp", label: "C++", path: "examples/cpp.yaml" },
  { id: "ai-agent", label: "AI Agent", path: "examples/ai-agent.yaml" }
];
const PHOTO_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

function sendText(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(body);
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf"
  };

  return types[ext] || "application/octet-stream";
}

function safeResolve(baseDir, requestPath) {
  try {
    return resolvePathInside(baseDir, requestPath.replace(/^\/+/, ""), "Static file path");
  } catch {
    return null;
  }
}

function sendFile(response, filePath) {
  if (!filePath || !existsSync(filePath)) {
    sendText(response, 404, "Not found");
    return true;
  }

  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store"
  });
  response.end(readFileSync(filePath));
  return true;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendBinary(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "content-type": "application/octet-stream",
    "content-length": body.byteLength,
    "cache-control": "no-store",
    ...headers
  });
  response.end(Buffer.from(body));
}

function backupTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

function labelForBackupFile(filename) {
  const match = filename.match(BACKUP_FILE_PATTERN);
  if (!match) {
    return filename;
  }

  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function loadResumeContext(dataRoot, resumeId) {
  if (typeof resumeId !== "string" || resumeId.trim() === "") {
    throw new Error("resumeId is required.");
  }

  const registry = loadResumeRegistry(dataRoot);
  const id = resumeId;
  const entry = resolveResumeEntry(registry, id);
  return {
    registry,
    entry,
    paths: resolveResumePaths(dataRoot, registry, id)
  };
}

function backupPublicPath(resumeId, filename) {
  return `${BACKUP_DIR}/${resumeId}/${filename}`;
}

function createVersionedBackup(context) {
  mkdirSync(context.paths.backupDir, { recursive: true });

  const timestamp = backupTimestamp();
  let filename = `resume-${timestamp}.yaml`;
  let backupPath = path.join(context.paths.backupDir, filename);
  let suffix = 2;
  while (existsSync(backupPath)) {
    filename = `resume-${timestamp}-${suffix}.yaml`;
    backupPath = path.join(context.paths.backupDir, filename);
    suffix += 1;
  }

  copyFileSync(context.paths.yaml, backupPath);
  return backupPublicPath(context.entry.id, filename);
}

function backupResumeYaml(context) {
  const filename = "resume.backup.yaml";
  const backupPath = path.join(context.paths.backupDir, filename);
  const result = {
    backup: backupPublicPath(context.entry.id, filename),
    versionedBackup: null
  };
  if (existsSync(context.paths.yaml)) {
    mkdirSync(context.paths.backupDir, { recursive: true });
    copyFileSync(context.paths.yaml, backupPath);
    result.versionedBackup = createVersionedBackup(context);
  }
  return result;
}

function backupResponseFields(backupResult) {
  return {
    backup: backupResult.backup,
    versionedBackup: backupResult.versionedBackup
  };
}

function listResumeBackups(context, limit = 10) {
  if (!existsSync(context.paths.backupDir)) {
    return [];
  }

  return readdirSync(context.paths.backupDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_FILE_PATTERN.test(entry.name))
    .map((entry) => ({
      file: backupPublicPath(context.entry.id, entry.name),
      label: labelForBackupFile(entry.name)
    }))
    .sort((left, right) => right.file.localeCompare(left.file))
    .slice(0, limit);
}

function resolveBackup(context, file) {
  const normalized = typeof file === "string" ? file.replaceAll("\\", "/") : "";
  const prefix = `${BACKUP_DIR}/${context.entry.id}/`;
  const filename = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : "";
  if (!BACKUP_FILE_PATTERN.test(filename)) {
    throw new Error(`Unknown backup: ${normalized}`);
  }

  const backupPath = path.join(context.paths.backupDir, filename);
  if (!existsSync(backupPath)) {
    throw new Error(`Unknown backup: ${normalized}`);
  }

  return {
    file: normalized,
    path: backupPath
  };
}

async function readJsonBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }

  if (tooLarge) {
    const error = new Error("File too large. Maximum JSON request body is 5MB.");
    error.statusCode = 413;
    throw error;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    throw new Error("Request body must be valid JSON.");
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Request body must be valid JSON: ${error.message}`);
  }
}

async function readBinaryBody(request, limitBytes) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > limitBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }

  if (tooLarge) {
    const error = new Error(`Archive is too large. Maximum upload is ${limitBytes} bytes.`);
    error.statusCode = 413;
    throw error;
  }
  if (size === 0) {
    throw new Error("Archive request body is empty.");
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function handleDataExportApi(request, response, dataRoot, appVersion) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    const archive = createDataPackage({ dataRoot, appVersion });
    sendBinary(response, 200, archive, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="resume-builder-backup-${backupTimestamp()}.zip"`
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
  }
}

async function handleDataImportInspectApi(
  request,
  response,
  dataImportManager,
  dataArchiveLimitBytes
) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    if (!String(request.headers["content-type"] || "").startsWith("application/zip")) {
      const error = new Error("Import request must use application/zip.");
      error.statusCode = 415;
      throw error;
    }
    const archive = await readBinaryBody(request, dataArchiveLimitBytes);
    const pending = dataImportManager.inspect(archive);
    sendJson(response, 200, {
      ok: true,
      token: pending.token,
      summary: pending.summary
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
  }
}

async function readDataImportCommitToken(request, bodyLimitBytes) {
  const body = await readJsonBody(request, bodyLimitBytes);
  if (
    body === null
    || typeof body !== "object"
    || Array.isArray(body)
    || typeof body.token !== "string"
    || body.token.trim() === ""
  ) {
    const error = new Error("Unknown import token");
    error.statusCode = 400;
    throw error;
  }
  return body.token;
}

async function commitDataImport(response, dataImportManager, token) {
  try {
    const result = await dataImportManager.commit(token);
    sendJson(response, 200, resumeRegistryResponse(result.registry, {
      preImportBackup: path.basename(result.preImportBackup),
      generation: "needs generate"
    }));
  } catch (error) {
    sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
  }
}

function handleDataImportCancelApi(request, response, dataImportManager, token) {
  if (request.method !== "DELETE") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  if (!dataImportManager.cancel(token)) {
    sendJson(response, 404, { ok: false, error: "Unknown import token." });
    return;
  }
  sendJson(response, 200, { ok: true });
}

function sendDataRecoveryError(response, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 0;
  const publicError = DATA_RECOVERY_PUBLIC_ERRORS.get(error?.code);
  if (publicError?.[0] === statusCode) {
    sendJson(response, statusCode, {
      ok: false,
      error: publicError[1],
      code: error.code
    });
    return;
  }
  sendJson(response, 500, {
    ok: false,
    error: "Data recovery failed.",
    code: "recovery-failed"
  });
}

async function handleDataRecoverySnapshotsApi(request, response, dataRecoveryManager) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    const snapshots = await dataRecoveryManager.list();
    sendJson(response, 200, { ok: true, snapshots });
  } catch (error) {
    sendDataRecoveryError(response, error);
  }
}

async function readDataRecoverySnapshotId(request, bodyLimitBytes) {
  const body = await readJsonBody(request, bodyLimitBytes);
  if (
    body === null
    || typeof body !== "object"
    || Array.isArray(body)
    || typeof body.snapshotId !== "string"
    || !SNAPSHOT_ID_PATTERN.test(body.snapshotId)
  ) {
    const error = new Error("Snapshot ID is invalid.");
    error.statusCode = 400;
    error.code = "invalid-snapshot-id";
    throw error;
  }
  return body.snapshotId;
}

async function restoreDataRecovery(response, dataRecoveryManager, snapshotId) {
  try {
    const result = await dataRecoveryManager.restore(snapshotId);
    sendJson(response, 200, resumeRegistryResponse(result.registry, {
      preRestoreBackup: path.basename(result.preRestoreBackup),
      generation: "needs generate"
    }));
  } catch (error) {
    sendDataRecoveryError(response, error);
  }
}

function createDataMutationGate({ isReplacing }) {
  let activeMutations = 0;
  let replacementPending = false;

  return {
    beginMutation() {
      if (replacementPending || isReplacing()) {
        return false;
      }
      activeMutations += 1;
      return true;
    },
    endMutation() {
      activeMutations = Math.max(0, activeMutations - 1);
    },
    beginReplacement() {
      if (replacementPending || isReplacing() || activeMutations > 0) {
        return false;
      }
      replacementPending = true;
      return true;
    },
    endReplacement() {
      replacementPending = false;
    },
    isReplacementLocked() {
      return replacementPending || isReplacing();
    }
  };
}

function isBlockedByDataReplacement(request, url, mutationGate) {
  if (!mutationGate.isReplacementLocked() || !url.pathname.startsWith("/api/")) {
    return false;
  }
  if (request.method === "GET" && url.pathname !== "/api/data/export") {
    return false;
  }
  return url.pathname !== "/api/preview";
}

function isOfficialDataMutation(request, url) {
  if (!url.pathname.startsWith("/api/") || request.method === "GET") {
    return false;
  }
  if (
    url.pathname === "/api/preview"
    || url.pathname.startsWith("/api/data/import/")
    || url.pathname.startsWith("/api/data/recovery/")
  ) {
    return false;
  }
  return true;
}

async function runWithOfficialDataMutation(request, response, url, mutationGate, task) {
  if (!isOfficialDataMutation(request, url)) {
    await task();
    return;
  }
  if (!mutationGate.beginMutation()) {
    sendJson(response, 423, {
      ok: false,
      error: "Data replacement is in progress. Try again shortly."
    });
    return;
  }
  try {
    await task();
  } finally {
    mutationGate.endMutation();
  }
}

async function handleResumeApi(request, response, dataRoot, resumeId, bodyLimitBytes) {
  try {
    const context = loadResumeContext(dataRoot, resumeId);
    if (request.method === "GET") {
      const resume = validateResume(loadResumeYaml(context.paths.yaml), dataRoot);
      sendJson(response, 200, {
        ok: true,
        resumeId: context.entry.id,
        resume,
        generatedPreviewAvailable: existsSync(context.paths.previewHtml)
      });
      return;
    }

    if (request.method === "PUT") {
      const resume = await readJsonBody(request, bodyLimitBytes);
      const validated = validateResume(resume, dataRoot);
      const backup = backupResumeYaml(context);
      saveResumeYaml(context.paths.yaml, validated);
      sendJson(response, 200, {
        ok: true,
        resumeId: context.entry.id,
        resume: validated,
        ...backupResponseFields(backup)
      });
      return;
    }

    sendJson(response, 405, { ok: false, error: "Method not allowed." });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleBackupsApi(request, response, dataRoot, resumeId) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    const context = loadResumeContext(dataRoot, resumeId);
    sendJson(response, 200, {
      ok: true,
      resumeId: context.entry.id,
      backups: listResumeBackups(context)
    });
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleRestoreBackupApi(request, response, dataRoot, bodyLimitBytes) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    const body = await readJsonBody(request, bodyLimitBytes);
    const context = loadResumeContext(dataRoot, body.resumeId);
    const backupFile = resolveBackup(context, body.file);
    const restored = validateResume(loadResumeYaml(backupFile.path), dataRoot);
    const backup = backupResumeYaml(context);
    saveResumeYaml(context.paths.yaml, restored);
    sendJson(response, 200, {
      ok: true,
      resumeId: context.entry.id,
      resume: restored,
      restoredBackup: backupFile.file,
      ...backupResponseFields(backup)
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleGenerateApi(request, response, projectRoot, dataRoot, generateResume, bodyLimitBytes) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  let context;
  try {
    const body = await readJsonBody(request, bodyLimitBytes);
    context = loadResumeContext(dataRoot, body.resumeId);
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      ok: false,
      error: error.message
    });
    return;
  }

  try {
    const result = await generateResume({ projectRoot, dataRoot, resumeId: context.entry.id });
    sendJson(response, 200, {
      ok: true,
      resumeId: context.entry.id,
      density: result.density,
      contentHeight: result.metrics?.height,
      outputs: {
        pdf: `/output/${context.entry.id}/resume.pdf`,
        png: `/output/${context.entry.id}/resume.png`,
        html: `/output/${context.entry.id}/preview.html`
      }
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  }
}

async function handlePreviewApi(request, response, projectRoot, dataRoot, bodyLimitBytes) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    const body = await readJsonBody(request, bodyLimitBytes);
    const context = loadResumeContext(dataRoot, body.resumeId);
    const resume = validateResume(body.resume, dataRoot);
    const html = renderResumeHtml(resume, {
      density: "normal",
      cssPath: "/templates/resume.css",
      templateFile: path.join(projectRoot, "templates", "resume.html"),
      assetPrefix: "/"
    });
    sendJson(response, 200, { ok: true, resumeId: context.entry.id, html });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      ok: false,
      error: error.message
    });
  }
}

async function handleExamplesApi(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    examples: EXAMPLES
  });
}

function normalizedResumeName(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Resume name is required.");
  }
  return value.trim();
}

function resumeRegistryResponse(registry, extra = {}) {
  return {
    ok: true,
    activeId: registry.activeId,
    resumes: registry.items,
    ...extra
  };
}

function materializeExampleAsset(projectRoot, dataRoot, resume) {
  const sourcePath = resolveResumeAssetPath(projectRoot, resume.profile.photo);
  const targetPath = resolveResumeAssetPath(dataRoot, resume.profile.photo);
  if (existsSync(targetPath)) {
    return;
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

async function handleResumesApi(request, response, dataRoot) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    const registry = loadResumeRegistry(dataRoot);
    sendJson(response, 200, resumeRegistryResponse(registry));
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error.message });
  }
}

async function handleDuplicateResumeApi(request, response, dataRoot, bodyLimitBytes) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  let createdPath = null;
  try {
    const body = await readJsonBody(request, bodyLimitBytes);
    const registry = loadResumeRegistry(dataRoot);
    const source = resolveResumeEntry(registry, body.sourceId || registry.activeId);
    const name = normalizedResumeName(body.name);
    const id = createResumeId(registry, name);
    const entry = { id, name, file: `resumes/${id}.yaml` };
    const nextRegistry = validateResumeRegistry({
      activeId: id,
      items: [...registry.items, entry]
    });
    const sourcePaths = resolveResumePaths(dataRoot, registry, source.id);
    const createdPaths = resolveResumePaths(dataRoot, nextRegistry, id);

    mkdirSync(path.dirname(createdPaths.yaml), { recursive: true });
    copyFileSync(sourcePaths.yaml, createdPaths.yaml);
    createdPath = createdPaths.yaml;
    saveResumeRegistry(dataRoot, nextRegistry);
    createdPath = null;

    sendJson(response, 201, resumeRegistryResponse(nextRegistry, { resume: entry }));
  } catch (error) {
    if (createdPath) {
      rmSync(createdPath, { force: true });
    }
    sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
  }
}

async function handleResumeFromExampleApi(request, response, projectRoot, dataRoot, bodyLimitBytes) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  let createdPath = null;
  try {
    const body = await readJsonBody(request, bodyLimitBytes);
    const example = EXAMPLES.find((item) => item.id === body.exampleId);
    if (!example) {
      throw new Error(`Unknown example: ${body.exampleId || ""}`);
    }

    const registry = loadResumeRegistry(dataRoot);
    const name = normalizedResumeName(body.name);
    const id = createResumeId(registry, name);
    const entry = { id, name, file: `resumes/${id}.yaml` };
    const nextRegistry = validateResumeRegistry({
      activeId: id,
      items: [...registry.items, entry]
    });
    const createdPaths = resolveResumePaths(dataRoot, nextRegistry, id);
    const exampleData = validateResume(
      loadResumeYaml(path.join(projectRoot, example.path)),
      projectRoot
    );
    materializeExampleAsset(projectRoot, dataRoot, exampleData);
    validateResume(exampleData, dataRoot);

    mkdirSync(path.dirname(createdPaths.yaml), { recursive: true });
    saveResumeYaml(createdPaths.yaml, exampleData);
    createdPath = createdPaths.yaml;
    saveResumeRegistry(dataRoot, nextRegistry);
    createdPath = null;

    sendJson(response, 201, resumeRegistryResponse(nextRegistry, { resume: entry }));
  } catch (error) {
    if (createdPath) {
      rmSync(createdPath, { force: true });
    }
    sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
  }
}

async function handleResumeItemApi(request, response, dataRoot, resumeId, action, bodyLimitBytes) {
  try {
    const registry = loadResumeRegistry(dataRoot);
    const current = resolveResumeEntry(registry, resumeId);

    if (action === "activate") {
      if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." });
        return;
      }

      const nextRegistry = { ...registry, activeId: current.id };
      saveResumeRegistry(dataRoot, nextRegistry);
      sendJson(response, 200, resumeRegistryResponse(nextRegistry));
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, bodyLimitBytes);
      const name = normalizedResumeName(body.name);
      const nextEntry = { ...current, name };
      const nextRegistry = validateResumeRegistry({
        ...registry,
        items: registry.items.map((item) => item.id === current.id ? nextEntry : item)
      });
      saveResumeRegistry(dataRoot, nextRegistry);
      sendJson(response, 200, resumeRegistryResponse(nextRegistry, { resume: nextEntry }));
      return;
    }

    if (request.method === "DELETE") {
      if (registry.items.length === 1) {
        throw new Error("Cannot delete the last resume.");
      }

      const deletedIndex = registry.items.findIndex((item) => item.id === current.id);
      const remaining = registry.items.filter((item) => item.id !== current.id);
      const activeId = registry.activeId === current.id
        ? remaining[Math.min(deletedIndex, remaining.length - 1)].id
        : registry.activeId;
      const nextRegistry = validateResumeRegistry({ activeId, items: remaining });
      const deletedPaths = resolveResumePaths(dataRoot, registry, current.id);

      saveResumeRegistry(dataRoot, nextRegistry);
      rmSync(deletedPaths.yaml, { force: true });
      rmSync(deletedPaths.backupDir, { force: true, recursive: true });
      rmSync(deletedPaths.outputDir, { force: true, recursive: true });
      sendJson(response, 200, resumeRegistryResponse(nextRegistry, { deletedId: current.id }));
      return;
    }

    sendJson(response, 405, { ok: false, error: "Method not allowed." });
  } catch (error) {
    sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
  }
}

async function handleLoadExampleApi(request, response, projectRoot, dataRoot, bodyLimitBytes) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    const body = await readJsonBody(request, bodyLimitBytes);
    const context = loadResumeContext(dataRoot, body.resumeId);
    const example = EXAMPLES.find((item) => item.id === body.id);
    if (!example) {
      throw new Error(`Unknown example: ${body.id || ""}`);
    }

    const data = validateResume(loadResumeYaml(path.join(projectRoot, example.path)), projectRoot);
    materializeExampleAsset(projectRoot, dataRoot, data);
    validateResume(data, dataRoot);
    const backup = backupResumeYaml(context);
    saveResumeYaml(context.paths.yaml, data);
    sendJson(response, 200, {
      ok: true,
      resumeId: context.entry.id,
      resume: data,
      ...backupResponseFields(backup)
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      ok: false,
      error: error.message
    });
  }
}

function parsePhotoUpload(body, photoLimitBytes) {
  const filename = typeof body.filename === "string" ? body.filename : "";
  const ext = path.extname(filename).toLowerCase();
  const expectedMime = PHOTO_TYPES[ext];

  if (!expectedMime) {
    throw new Error(`Unsupported photo type: ${ext || "unknown"}`);
  }

  if (typeof body.dataUrl !== "string") {
    throw new Error("Photo dataUrl is required.");
  }

  const match = body.dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error("Invalid photo data URL.");
  }

  const [, mime, base64] = match;
  if (mime !== expectedMime) {
    throw new Error(`Photo MIME does not match extension: ${mime}`);
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > photoLimitBytes) {
    const error = new Error("File too large. Maximum decoded photo size is 5MB.");
    error.statusCode = 413;
    throw error;
  }

  return { ext, bytes };
}

async function handlePhotoApi(request, response, dataRoot, bodyLimitBytes, photoLimitBytes) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed." });
    return;
  }

  try {
    const body = await readJsonBody(request, bodyLimitBytes);
    const context = loadResumeContext(dataRoot, body.resumeId);
    const { ext, bytes } = parsePhotoUpload(body, photoLimitBytes);
    const relativePhotoPath = `assets/${context.entry.id}-photo${ext}`;
    const photoPath = resolveResumeAssetPath(dataRoot, relativePhotoPath);
    mkdirSync(path.dirname(photoPath), { recursive: true });
    writeFileSync(photoPath, bytes);

    const resume = loadResumeYaml(context.paths.yaml);
    resume.profile.photo = relativePhotoPath;
    const validated = validateResume(resume, dataRoot);
    const backup = backupResumeYaml(context);
    saveResumeYaml(context.paths.yaml, validated);
    sendJson(response, 200, {
      ok: true,
      resumeId: context.entry.id,
      resume: validated,
      ...backupResponseFields(backup)
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      ok: false,
      error: error.message
    });
  }
}

function createEditorDataManagers(options, dataRoot, dataArchiveLimitBytes) {
  return {
    dataImportManager: options.dataImportManager || createDataImportManager({
      dataRoot,
      limits: { maxArchiveBytes: dataArchiveLimitBytes }
    }),
    dataRecoveryManager: options.dataRecoveryManager || createDataRecoveryManager({ dataRoot })
  };
}

function createDataManagerDisposer(dataImportManager, dataRecoveryManager) {
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    try {
      dataImportManager.dispose();
    } finally {
      dataRecoveryManager.dispose();
    }
  };
}

export function createEditorServer(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const dataRoot = path.resolve(options.dataRoot || options.rootDir || PROJECT_ROOT);
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  const photoLimitBytes = options.photoLimitBytes ?? DEFAULT_PHOTO_LIMIT_BYTES;
  const dataArchiveLimitBytes = options.dataArchiveLimitBytes ?? DEFAULT_DATA_ARCHIVE_LIMIT_BYTES;
  const generateResume = options.generateResume || defaultGenerateResume;
  const { dataImportManager, dataRecoveryManager } = createEditorDataManagers(
    options,
    dataRoot,
    dataArchiveLimitBytes
  );
  const mutationGate = createDataMutationGate({
    isReplacing: () => dataImportManager.isCommitting()
      || dataRecoveryManager.isRestoring()
  });
  const appVersion = options.appVersion || "0.1.0";

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || DEFAULT_HOST}`);

    if (request.method === "GET" && url.pathname === "/") {
      sendFile(response, path.join(projectRoot, "editor", "index.html"));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/editor/")) {
      sendFile(response, safeResolve(projectRoot, url.pathname.slice(1)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/output/")) {
      sendFile(response, safeResolve(dataRoot, url.pathname.slice(1)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      sendFile(response, safeResolve(dataRoot, url.pathname.slice(1)));
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/templates/")) {
      sendFile(response, safeResolve(projectRoot, url.pathname.slice(1)));
      return;
    }

    if (url.pathname === "/api/data/import/commit") {
      if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: "Method not allowed." });
        return;
      }
      let token;
      try {
        token = await readDataImportCommitToken(request, bodyLimitBytes);
      } catch (error) {
        sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
        return;
      }
      if (!mutationGate.beginReplacement()) {
        sendJson(response, 423, {
          ok: false,
          error: "A resume data replacement or write is already in progress. Retry shortly."
        });
        return;
      }
      try {
        await commitDataImport(response, dataImportManager, token);
      } finally {
        mutationGate.endReplacement();
      }
      return;
    }

    if (url.pathname === "/api/data/recovery/restore" && request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: "Method not allowed." });
      return;
    }

    if (url.pathname === "/api/data/recovery/restore") {
      let snapshotId;
      try {
        snapshotId = await readDataRecoverySnapshotId(request, bodyLimitBytes);
      } catch (error) {
        if (error.code === "invalid-snapshot-id") {
          sendDataRecoveryError(response, error);
        } else {
          sendJson(response, error.statusCode || 400, { ok: false, error: error.message });
        }
        return;
      }
      if (!mutationGate.beginReplacement()) {
        sendJson(response, 423, {
          ok: false,
          error: "A resume data replacement or write is already in progress. Retry shortly."
        });
        return;
      }
      try {
        await restoreDataRecovery(response, dataRecoveryManager, snapshotId);
      } finally {
        mutationGate.endReplacement();
      }
      return;
    }

    if (url.pathname === "/api/data/recovery/snapshots") {
      await handleDataRecoverySnapshotsApi(request, response, dataRecoveryManager);
      return;
    }

    if (isBlockedByDataReplacement(request, url, mutationGate)) {
      sendJson(response, 423, {
        ok: false,
        error: "Data replacement is in progress. Try again shortly."
      });
      return;
    }

    if (url.pathname === "/api/data/export") {
      handleDataExportApi(request, response, dataRoot, appVersion);
      return;
    }

    if (url.pathname === "/api/data/import/inspect") {
      await handleDataImportInspectApi(
        request,
        response,
        dataImportManager,
        dataArchiveLimitBytes
      );
      return;
    }

    const dataImportCancelRoute = url.pathname.match(/^\/api\/data\/import\/([^/]+)$/);
    if (dataImportCancelRoute) {
      try {
        handleDataImportCancelApi(
          request,
          response,
          dataImportManager,
          decodeURIComponent(dataImportCancelRoute[1])
        );
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `Invalid import token: ${error.message}` });
      }
      return;
    }

    await runWithOfficialDataMutation(request, response, url, mutationGate, async () => {
      if (url.pathname === "/api/resumes") {
        await handleResumesApi(request, response, dataRoot);
        return;
      }

      if (url.pathname === "/api/resumes/duplicate") {
        await handleDuplicateResumeApi(request, response, dataRoot, bodyLimitBytes);
        return;
      }

      if (url.pathname === "/api/resumes/from-example") {
        await handleResumeFromExampleApi(request, response, projectRoot, dataRoot, bodyLimitBytes);
        return;
      }

      const resumeRoute = url.pathname.match(/^\/api\/resumes\/([^/]+)(?:\/(activate))?$/);
      if (resumeRoute) {
        try {
          const resumeId = decodeURIComponent(resumeRoute[1]);
          await handleResumeItemApi(
            request,
            response,
            dataRoot,
            resumeId,
            resumeRoute[2] || null,
            bodyLimitBytes
          );
        } catch (error) {
          sendJson(response, 400, { ok: false, error: `Invalid resume id: ${error.message}` });
        }
        return;
      }

      if (url.pathname === "/api/resume") {
        await handleResumeApi(request, response, dataRoot, url.searchParams.get("resumeId"), bodyLimitBytes);
        return;
      }

      if (url.pathname === "/api/generate") {
        await handleGenerateApi(request, response, projectRoot, dataRoot, generateResume, bodyLimitBytes);
        return;
      }

      if (url.pathname === "/api/preview") {
        await handlePreviewApi(request, response, projectRoot, dataRoot, bodyLimitBytes);
        return;
      }

      if (url.pathname === "/api/backups") {
        await handleBackupsApi(request, response, dataRoot, url.searchParams.get("resumeId"));
        return;
      }

      if (url.pathname === "/api/restore-backup") {
        await handleRestoreBackupApi(request, response, dataRoot, bodyLimitBytes);
        return;
      }

      if (url.pathname === "/api/examples") {
        await handleExamplesApi(request, response);
        return;
      }

      if (url.pathname === "/api/load-example") {
        await handleLoadExampleApi(request, response, projectRoot, dataRoot, bodyLimitBytes);
        return;
      }

      if (url.pathname === "/api/photo") {
        await handlePhotoApi(request, response, dataRoot, bodyLimitBytes, photoLimitBytes);
        return;
      }

      sendText(response, 404, "Not found");
    });
  });
  if (options.disposeDataManagersOnClose !== false) {
    server.once("close", createDataManagerDisposer(dataImportManager, dataRecoveryManager));
  }
  return server;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      server.off("error", onError);
      server.off("listening", onListening);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onListening() {
      cleanup();
      resolve();
    }

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startEditorServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const preferredPort = options.preferredPort ?? DEFAULT_PORT;
  const maxPort = options.maxPort ?? DEFAULT_MAX_PORT;
  const log = options.log === false ? null : options.log || console.log;
  const dataRoot = path.resolve(options.dataRoot || options.rootDir || PROJECT_ROOT);
  const dataArchiveLimitBytes = options.dataArchiveLimitBytes ?? DEFAULT_DATA_ARCHIVE_LIMIT_BYTES;
  const { dataImportManager, dataRecoveryManager } = createEditorDataManagers(
    options,
    dataRoot,
    dataArchiveLimitBytes
  );
  const disposeDataManagers = createDataManagerDisposer(
    dataImportManager,
    dataRecoveryManager
  );
  const serverOptions = {
    ...options,
    dataImportManager,
    dataRecoveryManager,
    disposeDataManagersOnClose: false
  };

  const candidatePorts = preferredPort === 0
    ? [0]
    : Array.from(
      { length: Math.max(0, maxPort - preferredPort + 1) },
      (_unused, index) => preferredPort + index
    );

  try {
    for (const candidatePort of candidatePorts) {
      const server = createEditorServer(serverOptions);

      try {
        await listen(server, host, candidatePort);
        server.once("close", disposeDataManagers);
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : candidatePort;
        const url = `http://${host}:${port}`;
        log?.(`Resume editor running at ${url}`);
        log?.(`Resume data: ${dataRoot} (${options.dataStatus || "provided"})`);
        return {
          server,
          host,
          port,
          url,
          close: () => new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
            server.closeAllConnections();
          })
        };
      } catch (error) {
        server.close();
        if (error.code === "EADDRINUSE" && candidatePort !== candidatePorts.at(-1)) {
          continue;
        }
        if (error.code === "EADDRINUSE") {
          throw new Error(`Ports ${preferredPort}-${maxPort} are already in use. Close the process using them or set another port.`);
        }
        throw error;
      }
    }

    throw new Error(`No candidate ports available from ${preferredPort} to ${maxPort}.`);
  } catch (error) {
    disposeDataManagers();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const appPaths = resolveAppPaths({ projectRoot: PROJECT_ROOT });
    const prepared = ensureDataRoot(appPaths);
    await startEditorServer({
      ...appPaths,
      dataStatus: prepared.status
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
