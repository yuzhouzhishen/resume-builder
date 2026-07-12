#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4321;
const DEFAULT_MAX_PORT = 4330;
const HEALTH_PROTOCOL_VERSION = 1;
const MINIMUM_NODE_VERSION = [20, 12, 0];

function commandName(name, platform) {
  return platform === "win32" ? `${name}.cmd` : name;
}

function runRequiredCommand(command, args, options, spawnSyncImpl) {
  const result = spawnSyncImpl(command, args, options);
  if (result.error) {
    throw new Error(`Cannot run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
  }
}

export function assertSupportedNode(version = process.versions.node) {
  const current = String(version).split(".").map((part) => Number(part));
  const supported = MINIMUM_NODE_VERSION.every((minimum, index) => {
    if (current[index] === minimum) {
      return true;
    }
    const earlierPartsEqual = MINIMUM_NODE_VERSION
      .slice(0, index)
      .every((part, partIndex) => current[partIndex] === part);
    return !earlierPartsEqual || current[index] > minimum;
  });
  if (!supported) {
    throw new Error(`Node.js 20.12 or newer is required. Current version: ${version}.`);
  }
}

export function ensureProjectDependencies(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const log = options.log || console.log;
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const dependencies = Object.keys(packageJson.dependencies || {});
  const missing = dependencies.filter((name) => !existsSync(path.join(
    projectRoot,
    "node_modules",
    ...name.split("/"),
    "package.json"
  )));
  if (missing.length === 0) {
    return false;
  }

  log("Installing Resume Builder dependencies...");
  runRequiredCommand(
    commandName("npm", platform),
    ["install"],
    { cwd: projectRoot, stdio: "inherit", windowsHide: false },
    spawnSyncImpl
  );
  return true;
}

export function ensureChromiumRuntime(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const platform = options.platform || process.platform;
  const executablePath = options.executablePath || "";
  const existsSyncImpl = options.existsSyncImpl || existsSync;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const log = options.log || console.log;
  if (executablePath && existsSyncImpl(executablePath)) {
    return false;
  }

  log("Installing the Chromium runtime used for PDF generation...");
  runRequiredCommand(
    commandName("npx", platform),
    ["playwright", "install", "chromium"],
    { cwd: projectRoot, stdio: "inherit", windowsHide: false },
    spawnSyncImpl
  );
  if (!executablePath || !existsSyncImpl(executablePath)) {
    throw new Error("Chromium installation completed but its executable is still unavailable.");
  }
  return true;
}

function commandAvailable(command, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(command, ["-v"], {
    stdio: "ignore",
    windowsHide: true
  });
  return !result.error && result.status === 0;
}

export async function prepareRuntime(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const log = options.log || console.log;
  assertSupportedNode(options.nodeVersion);
  ensureProjectDependencies({ projectRoot, platform, spawnSyncImpl, log });

  const { chromium } = await import("playwright");
  ensureChromiumRuntime({
    projectRoot,
    platform,
    executablePath: chromium.executablePath(),
    spawnSyncImpl,
    log
  });

  const popplerAvailable = commandAvailable("pdfinfo", spawnSyncImpl)
    && commandAvailable("pdftoppm", spawnSyncImpl);
  if (!popplerAvailable) {
    log("Warning: Poppler is not installed. Editing works, but PDF/PNG generation requires pdfinfo and pdftoppm. See README.md.");
  }
  return { popplerAvailable };
}

export function browserOpenCommand(url, platform = process.platform) {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", url]
    };
  }
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(url, options = {}) {
  const platform = options.platform || process.platform;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const { command, args } = browserOpenCommand(url, platform);
  runRequiredCommand(command, args, {
    stdio: "ignore",
    windowsHide: true
  }, spawnSyncImpl);
}

export async function findRunningEditor(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const preferredPort = options.preferredPort ?? DEFAULT_PORT;
  const maxPort = options.maxPort ?? DEFAULT_MAX_PORT;
  const instanceId = options.instanceId;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 350;

  for (let port = preferredPort; port <= maxPort; port += 1) {
    const url = `http://${host}:${port}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${url}/api/health`, {
        signal: controller.signal,
        headers: { accept: "application/json" }
      });
      if (!response.ok) {
        continue;
      }
      const body = await response.json();
      if (
        body?.ok === true
        && body.app === "resume-builder"
        && body.protocolVersion === HEALTH_PROTOCOL_VERSION
        && body.instanceId === instanceId
      ) {
        return url;
      }
    } catch (_error) {
      // An unused port or unrelated local service is not a launcher error.
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

async function loadAppModules() {
  const [appPathsModule, dataRootModule, editorServerModule] = await Promise.all([
    import("./app-paths.mjs"),
    import("./data-root.mjs"),
    import("./editor-server.mjs")
  ]);
  return {
    resolveAppPaths: appPathsModule.resolveAppPaths,
    ensureDataRoot: dataRootModule.ensureDataRoot,
    createEditorInstanceId: editorServerModule.createEditorInstanceId,
    startEditorServer: editorServerModule.startEditorServer
  };
}

function tryOpenBrowser(url, opener, platform, log) {
  try {
    opener(url, { platform });
  } catch (error) {
    log(`Could not open the browser automatically: ${error.message}`);
    log(`Open this address manually: ${url}`);
  }
}

export async function launchEditor(options = {}, dependencies = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const platform = options.platform || process.platform;
  const host = options.host || DEFAULT_HOST;
  const preferredPort = options.preferredPort ?? DEFAULT_PORT;
  const maxPort = options.maxPort ?? DEFAULT_MAX_PORT;
  const log = dependencies.log || console.log;
  const runtime = await (dependencies.prepareRuntime || prepareRuntime)({
    projectRoot,
    platform,
    log
  });
  if (runtime?.popplerAvailable === false) {
    log("Resume Builder will still open for editing.");
  }

  const modules = dependencies.resolveAppPaths
    ? dependencies
    : { ...await loadAppModules(), ...dependencies };
  const appPaths = modules.resolveAppPaths({ projectRoot });
  const prepared = modules.ensureDataRoot(appPaths);
  const instanceId = modules.createEditorInstanceId(appPaths.dataRoot);
  const runningUrl = await (modules.findRunningEditor || findRunningEditor)({
    host,
    preferredPort,
    maxPort,
    instanceId
  });
  const opener = modules.openBrowser || openBrowser;

  if (runningUrl) {
    log(`Resume Builder is already running at ${runningUrl}`);
    tryOpenBrowser(runningUrl, opener, platform, log);
    return { existing: true, url: runningUrl, app: null };
  }

  const app = await modules.startEditorServer({
    ...appPaths,
    host,
    preferredPort,
    maxPort,
    dataStatus: prepared.status,
    instanceId
  });
  tryOpenBrowser(app.url, opener, platform, log);
  return { existing: false, url: app.url, app };
}

function installShutdownHandlers(app) {
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  const signals = process.platform === "win32"
    ? ["SIGINT", "SIGTERM"]
    : ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.once(signal, shutdown);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const result = await launchEditor();
    if (result.app) {
      installShutdownHandlers(result.app);
      console.log("Keep this window open while editing. Press Ctrl+C to stop Resume Builder.");
    }
  } catch (error) {
    console.error(`Resume Builder could not start: ${error.message}`);
    process.exitCode = 1;
  }
}
