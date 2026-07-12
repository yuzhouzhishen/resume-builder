import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSupportedNode,
  browserOpenCommand,
  ensureChromiumRuntime,
  ensureProjectDependencies,
  findRunningEditor,
  launchEditor
} from "./launch-editor.mjs";

const PROJECT_ROOT = path.resolve(".");

test("launcher enforces the documented minimum Node version", () => {
  assert.doesNotThrow(() => assertSupportedNode("20.12.0"));
  assert.doesNotThrow(() => assertSupportedNode("22.0.0"));
  assert.throws(() => assertSupportedNode("20.11.9"), /20\.12 or newer/);
  assert.throws(() => assertSupportedNode("19.20.0"), /20\.12 or newer/);
});

test("browser open commands support macOS Windows and Linux", () => {
  const url = "http://127.0.0.1:4321";
  assert.deepEqual(browserOpenCommand(url, "darwin"), {
    command: "open",
    args: [url]
  });
  assert.deepEqual(browserOpenCommand(url, "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "start", "", url]
  });
  assert.deepEqual(browserOpenCommand(url, "linux"), {
    command: "xdg-open",
    args: [url]
  });
});

test("running editor discovery accepts only a matching health identity", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const port = Number(new URL(url).port);
    const identity = port === 4321
      ? { app: "another-service", instanceId: "matching-instance" }
      : port === 4322
        ? { app: "resume-builder", instanceId: "other-instance" }
        : { app: "resume-builder", instanceId: "matching-instance" };
    return new Response(JSON.stringify({
      ok: true,
      protocolVersion: 1,
      ...identity
    }), { status: 200 });
  };

  const url = await findRunningEditor({
    host: "127.0.0.1",
    preferredPort: 4321,
    maxPort: 4323,
    instanceId: "matching-instance",
    fetchImpl,
    timeoutMs: 50
  });

  assert.equal(url, "http://127.0.0.1:4323");
  assert.equal(requests.length, 3);
});

test("project dependency preparation installs only when direct dependencies are missing", () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "resume-launch-deps-"));
  writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
    dependencies: { alpha: "1.0.0", beta: "1.0.0" }
  }));
  const calls = [];
  const spawnSyncImpl = (...args) => {
    calls.push(args);
    return { status: 0 };
  };

  assert.equal(ensureProjectDependencies({ projectRoot, platform: "win32", spawnSyncImpl }), true);
  assert.equal(calls[0][0], "npm.cmd");
  assert.deepEqual(calls[0][1], ["install"]);

  mkdirSync(path.join(projectRoot, "node_modules/alpha"), { recursive: true });
  mkdirSync(path.join(projectRoot, "node_modules/beta"), { recursive: true });
  writeFileSync(path.join(projectRoot, "node_modules/alpha/package.json"), "{}");
  writeFileSync(path.join(projectRoot, "node_modules/beta/package.json"), "{}");
  calls.length = 0;
  assert.equal(ensureProjectDependencies({ projectRoot, platform: "linux", spawnSyncImpl }), false);
  assert.equal(calls.length, 0);
});

test("Chromium preparation installs its runtime only when the executable is missing", () => {
  const calls = [];
  const spawnSyncImpl = (...args) => {
    calls.push(args);
    return { status: 0 };
  };
  let executableChecks = 0;

  assert.equal(ensureChromiumRuntime({
    projectRoot: PROJECT_ROOT,
    platform: "win32",
    executablePath: "C:\\cache\\chromium.exe",
    existsSyncImpl: () => {
      executableChecks += 1;
      return executableChecks > 1;
    },
    spawnSyncImpl
  }), true);
  assert.equal(calls[0][0], "npx.cmd");
  assert.deepEqual(calls[0][1], ["playwright", "install", "chromium"]);
  assert.equal(executableChecks, 2);

  calls.length = 0;
  assert.equal(ensureChromiumRuntime({
    projectRoot: PROJECT_ROOT,
    platform: "darwin",
    executablePath: "/cache/chromium",
    existsSyncImpl: () => true,
    spawnSyncImpl
  }), false);
  assert.equal(calls.length, 0);
});

test("launcher reopens a matching server without starting another process", async () => {
  const opened = [];
  let starts = 0;
  const result = await launchEditor({ projectRoot: PROJECT_ROOT }, {
    prepareRuntime: async () => ({ popplerAvailable: true }),
    resolveAppPaths: () => ({ projectRoot: PROJECT_ROOT, dataRoot: "/tmp/resume-launch-data" }),
    ensureDataRoot: () => ({ status: "existing" }),
    createEditorInstanceId: () => "matching-instance",
    findRunningEditor: async () => "http://127.0.0.1:4324",
    startEditorServer: async () => {
      starts += 1;
      return null;
    },
    openBrowser: (url) => opened.push(url),
    log: () => {}
  });

  assert.deepEqual(result, {
    existing: true,
    url: "http://127.0.0.1:4324",
    app: null
  });
  assert.equal(starts, 0);
  assert.deepEqual(opened, ["http://127.0.0.1:4324"]);
});

test("launcher starts and opens the actual fallback URL when no instance exists", async () => {
  const opened = [];
  const app = { url: "http://127.0.0.1:4322", close: async () => {} };
  const result = await launchEditor({ projectRoot: PROJECT_ROOT }, {
    prepareRuntime: async () => ({ popplerAvailable: true }),
    resolveAppPaths: () => ({ projectRoot: PROJECT_ROOT, dataRoot: "/tmp/resume-launch-data" }),
    ensureDataRoot: () => ({ status: "existing" }),
    createEditorInstanceId: () => "matching-instance",
    findRunningEditor: async () => null,
    startEditorServer: async (options) => {
      assert.equal(options.instanceId, "matching-instance");
      return app;
    },
    openBrowser: (url) => opened.push(url),
    log: () => {}
  });

  assert.equal(result.existing, false);
  assert.equal(result.url, app.url);
  assert.equal(result.app, app);
  assert.deepEqual(opened, [app.url]);
});

test("double-click wrappers delegate to the shared launcher without absolute paths", () => {
  const macPath = path.join(PROJECT_ROOT, "Start Resume Builder.command");
  const windowsPath = path.join(PROJECT_ROOT, "Start Resume Builder.cmd");
  const mac = readFileSync(macPath, "utf8");
  const windows = readFileSync(windowsPath, "utf8");

  assert.match(mac, /node scripts\/launch-editor\.mjs/);
  assert.match(windows, /node scripts\\launch-editor\.mjs/);
  assert.doesNotMatch(mac, /\/Users\//);
  assert.doesNotMatch(windows, /[A-Z]:\\Users\\/i);
  assert.notEqual(statSync(macPath).mode & 0o111, 0);
});
