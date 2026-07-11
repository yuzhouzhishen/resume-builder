import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import { chromium } from "playwright";

import { createDataPackage } from "./data-package.mjs";
import { createEditorServer, startEditorServer } from "./editor-server.mjs";
import { renderResumeHtml } from "./generate.mjs";
import { loadResumeYaml, saveResumeYaml } from "./resume-data.mjs";

const PROJECT_ROOT = path.resolve(".");

function sendTestText(response, statusCode, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(body);
}

function sendTestJson(response, statusCode, payload) {
  sendTestText(response, statusCode, JSON.stringify(payload), "application/json; charset=utf-8");
}

async function readTestJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendTestFile(response, filePath, contentType) {
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(readFileSync(filePath));
}

async function startCustomEditorServer(handler) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (await handler(request, response, url)) {
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/resumes") {
      sendTestJson(response, 200, {
        ok: true,
        activeId: "cpp",
        resumes: [{ id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" }]
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      sendTestFile(response, path.join(PROJECT_ROOT, "editor/index.html"), "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/editor/app.js") {
      sendTestFile(response, path.join(PROJECT_ROOT, "editor/app.js"), "text/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/editor/styles.css") {
      sendTestFile(response, path.join(PROJECT_ROOT, "editor/styles.css"), "text/css; charset=utf-8");
      return;
    }

    if (request.method === "GET" && ["/output/preview.html", "/output/cpp/preview.html"].includes(url.pathname)) {
      sendTestText(response, 200, renderResumeHtml(validResume, {
        density: "normal",
        cssPath: "/templates/resume.css"
      }), "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && url.pathname === "/templates/resume.css") {
      sendTestFile(response, path.join(PROJECT_ROOT, "templates/resume.css"), "text/css; charset=utf-8");
      return;
    }

    sendTestText(response, 404, "Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    })
  };
}

async function openEditorPage(t, options) {
  const browser = await chromium.launch();
  const context = await browser.newContext(options);
  const page = await context.newPage();
  t.after(async () => {
    await browser.close();
  });
  return page;
}

async function waitForResumeOption(page, resumeId) {
  await page.waitForFunction((id) => Array.from(
    document.querySelectorAll("#resumeSelectMenu [data-resume-id]")
  ).some((option) => option.dataset.resumeId === id), resumeId);
}

async function selectResumeOption(page, resumeId) {
  await waitForResumeOption(page, resumeId);
  await page.click("#resumeSelectButton");
  await page.click(`#resumeSelectMenu [data-resume-id='${resumeId}']`);
}

async function selectedResumeId(page) {
  return page.getAttribute("#resumeSelectButton", "data-value");
}

function formatLocalDateTime(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

async function waitForPreviewInteractive(page) {
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    const documentInFrame = iframe?.contentDocument;
    return documentInFrame?.readyState === "complete"
      && documentInFrame.querySelector("#resume-page")
      && documentInFrame.documentElement.dataset.previewInteractive === "true";
  });
}

async function dispatchPreviewClick(page, selector) {
  await waitForPreviewInteractive(page);
  await page.frameLocator("#previewFrame").locator(selector).evaluate((element) => {
    element.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true
    }));
  });
}

async function sendPreviewSelection(page, section, path = "") {
  await page.evaluate(({ section, path }) => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      data: {
        type: "resume-preview-section",
        section,
        path
      }
    }));
  }, { section, path });
}

async function dispatchBeforeUnload(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const dispatchResult = window.dispatchEvent(event);
    return {
      defaultPrevented: event.defaultPrevented,
      dispatchResult
    };
  });
}

async function installControlledLayoutMeasurements(page, overflowByBodySize) {
  await page.addInitScript((overflowMap) => {
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function controlledLayoutRect() {
      const measurementPage = this.closest?.("#resume-page, [data-layout-measurement-page]");
      if (this.id === "resume-page" || this.hasAttribute?.("data-layout-measurement-page")) {
        return {
          x: 0, y: 0, top: 0, left: 0,
          right: 794, bottom: 1123, width: 794, height: 1123,
          toJSON() { return this; }
        };
      }
      if (measurementPage) {
        const bodySize = measurementPage.parentElement?.style.getPropertyValue("--body-size").trim()
          || document.documentElement.style.getPropertyValue("--body-size").trim();
        const overflow = Number(overflowMap[bodySize] || 0);
        if (this.matches("[data-path='profile.name']")) {
          window.parent.__layoutMeasurements ||= [];
          window.parent.__layoutMeasurements.push(bodySize);
        }
        return {
          x: 20, y: 20, top: 20, left: 20,
          right: 760, bottom: 1123 + overflow, width: 740, height: 1103 + overflow,
          toJSON() { return this; }
        };
      }
      return original.call(this);
    };
  }, overflowByBodySize);
}

async function installVisibleLayoutTracking(page) {
  await page.addInitScript(() => {
    if (window === window.top) {
      return;
    }

    window.addEventListener("DOMContentLoaded", () => {
      const root = document.documentElement;
      const record = () => {
        const bodySize = root.style.getPropertyValue("--body-size").trim();
        if (!bodySize) {
          return;
        }
        window.parent.__visibleLayoutSizes ||= [];
        window.parent.__visibleLayoutSizes.push(bodySize);
      };
      new MutationObserver(record).observe(root, {
        attributes: true,
        attributeFilter: ["style"]
      });
    });
  });
}

const validResume = {
  profile: {
    name: "测试候选人",
    target: "C++开发工程师",
    school: "示例大学（应届生）",
    major: "计算机科学与技术",
    phone: "000-0000-0000",
    email: "candidate@example.com",
    photo: "assets/photo.svg"
  },
  skills: [
    {
      title: "C/C++编程",
      items: ["熟悉 C/C++ 基本语法。"]
    }
  ],
  internships: [],
  projects: []
};

async function startPortBlocker() {
  const server = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return server;
}

function writeApiFixture(dir) {
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  mkdirSync(path.join(dir, "output"));
  mkdirSync(path.join(dir, "output/cpp"));
  mkdirSync(path.join(dir, "resumes"));
  writeFileSync(path.join(dir, "assets/photo.svg"), "<svg></svg>");
  writeFileSync(path.join(dir, "assets/photo.png"), "png-photo");
  writeFileSync(path.join(dir, "output/resume.png"), "png-preview");
  saveResumeYaml(path.join(dir, "resumes/cpp.yaml"), validResume);
  writeFileSync(path.join(dir, "resumes.json"), `${JSON.stringify({
    activeId: "cpp",
    items: [{ id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" }]
  }, null, 2)}\n`);
  return dir;
}

function makeApiFixture() {
  return writeApiFixture(mkdtempSync(path.join(tmpdir(), "resume-editor-test-")));
}

function makeRecoveryApiFixture(t) {
  const parent = mkdtempSync(path.join(tmpdir(), "resume-editor-recovery-test-"));
  const dataRoot = writeApiFixture(path.join(parent, "resume-data"));
  const validSnapshotRoot = writeApiFixture(
    `${dataRoot}.pre-import-20260710-070809`
  );
  const invalidSnapshotRoot = path.join(
    parent,
    `${path.basename(dataRoot)}.pre-restore-20260711-080910`
  );
  mkdirSync(invalidSnapshotRoot);
  writeFileSync(path.join(invalidSnapshotRoot, "resumes.json"), "{broken\n");
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>active-before</svg>");
  writeFileSync(path.join(validSnapshotRoot, "assets/photo.svg"), "<svg>snapshot-active</svg>");
  t.after(() => rmSync(parent, { force: true, recursive: true }));
  return { dataRoot, validSnapshotRoot };
}

function apiRegistry() {
  return {
    activeId: "cpp",
    items: [{ id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" }]
  };
}

function replacementResult(type) {
  return {
    registry: apiRegistry(),
    [type === "import" ? "preImportBackup" : "preRestoreBackup"]:
      `resume-data.pre-${type}-20260711-080910`
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function stubImportManager(overrides = {}) {
  return {
    inspect() {
      throw new Error("not used");
    },
    commit() {
      return replacementResult("import");
    },
    cancel() {
      return false;
    },
    isCommitting() {
      return false;
    },
    dispose() {},
    ...overrides
  };
}

function stubRecoveryManager(overrides = {}) {
  return {
    list() {
      return [];
    },
    restore() {
      return replacementResult("restore");
    },
    isRestoring() {
      return false;
    },
    dispose() {},
    ...overrides
  };
}

async function waitForManagerStart(started, request) {
  await Promise.race([
    started,
    request.then((response) => {
      throw new Error(`Request completed before its manager started (${response.status}).`);
    })
  ]);
}

function resumeYamlPath(rootDir, resumeId = "cpp") {
  return path.join(rootDir, "resumes", `${resumeId}.yaml`);
}

function previewHtmlPath(rootDir, resumeId = "cpp") {
  return path.join(rootDir, "output", resumeId, "preview.html");
}

function makeProjectFixture() {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "resume-project-root-test-"));
  mkdirSync(path.join(projectRoot, "editor"), { recursive: true });
  mkdirSync(path.join(projectRoot, "templates"), { recursive: true });
  mkdirSync(path.join(projectRoot, "examples"), { recursive: true });
  mkdirSync(path.join(projectRoot, "assets"), { recursive: true });
  writeFileSync(path.join(projectRoot, "editor/index.html"), "<!doctype html><p>project-root-index</p>");
  writeFileSync(path.join(projectRoot, "editor/app.js"), "// project-root-script");
  writeFileSync(path.join(projectRoot, "editor/styles.css"), "/* project-root-editor-css */");
  writeFileSync(path.join(projectRoot, "templates/resume.css"), "/* project-root-resume-css */");
  writeFileSync(path.join(projectRoot, "assets/photo.svg"), "<svg>public-placeholder</svg>");
  saveResumeYaml(path.join(projectRoot, "examples/cpp.yaml"), validResume);
  return projectRoot;
}

function makeMultiResumeFixture() {
  const rootDir = makeApiFixture();

  const cppResume = structuredClone(validResume);
  cppResume.profile.name = "C++ Candidate";
  const aiResume = structuredClone(validResume);
  aiResume.profile.name = "AI Candidate";
  aiResume.profile.target = "AI Agent 应用开发工程师";

  saveResumeYaml(path.join(rootDir, "resumes/cpp.yaml"), cppResume);
  saveResumeYaml(path.join(rootDir, "resumes/ai-agent.yaml"), aiResume);
  writeFileSync(path.join(rootDir, "resumes.json"), `${JSON.stringify({
    activeId: "cpp",
    items: [
      { id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" },
      { id: "ai-agent", name: "AI Agent", file: "resumes/ai-agent.yaml" }
    ]
  }, null, 2)}\n`);

  return rootDir;
}

function resumeWithContentCards() {
  const resume = structuredClone(validResume);
  resume.internships = [
    {
      start: "2025.08",
      end: "至今",
      organization: "示例科技有限公司",
      role: "软件开发实习生",
      summary: "智能多端口设备主控固件开发。",
      items: ["负责节点间通信、资源调度、状态管理。"],
      linkLabel: "项目代码链接",
      link: "https://example.com/resume-project"
    }
  ];
  resume.projects = [
    {
      start: "2025.04",
      end: "2025.07",
      name: "并发内存池实验",
      role: "后端开发",
      summary: "基于 tcmalloc 的简化版设计与实现",
      items: ["模拟实现核心功能。"],
      linkLabel: "项目代码链接",
      link: "https://example.com/project"
    }
  ];
  return resume;
}

function resumeWithDeleteTargets() {
  const resume = resumeWithContentCards();
  resume.internships.push({
    start: "2025.09",
    end: "2025.12",
    organization: "第二家公司",
    role: "后端实习生",
    summary: "第二段实习概述。",
    items: ["第二段实习要点。"],
    linkLabel: "项目代码链接",
    link: ""
  });
  resume.skills = [
    {
      title: "C/C++编程",
      items: ["第一条技能要点。", "第二条技能要点。"]
    },
    {
      title: "操作系统/Linux 系统编程",
      items: ["熟悉 Linux 常用工具。"]
    }
  ];
  return resume;
}

test("editor server serves the local editor shell", async (t) => {
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /简历编辑器/);
  assert.match(html, /id="app"/);
  assert.match(html, /id="previewFrame"/);
  assert.match(html, /A4 待测量/);
  assert.doesNotMatch(html, /id="previewImage"/);
});

test("editor server close terminates a request already being handled", async () => {
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    log: false
  });
  const socket = net.createConnection({ host: app.host, port: app.port });
  await once(socket, "connect");
  const requestStarted = once(app.server, "request");
  socket.write([
    "POST /api/preview HTTP/1.1",
    `Host: ${app.host}:${app.port}`,
    "Content-Type: application/json",
    "Content-Length: 100000",
    "Connection: keep-alive",
    "",
    "{"
  ].join("\r\n"));
  await requestStarted;
  await new Promise((resolve) => setImmediate(resolve));

  const closePromise = app.close();
  const closedPromptly = await Promise.race([
    closePromise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250))
  ]);
  socket.destroy();
  await closePromise;

  assert.equal(closedPromptly, true);
});

test("editor server serves editor and output static files", async (t) => {
  const rootDir = makeApiFixture();
  writeFileSync(previewHtmlPath(rootDir), "<!doctype html><html><body>preview</body></html>");
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const scriptResponse = await fetch(`${app.url}/editor/app.js`);
  const previewResponse = await fetch(`${app.url}/output/resume.png`);
  const htmlPreviewResponse = await fetch(`${app.url}/output/cpp/preview.html`);
  const script = await scriptResponse.text();
  const htmlPreview = await htmlPreviewResponse.text();

  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /javascript/);
  assert.match(script, /loadResume/);
  assert.match(script, /上一版已备份/);
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get("content-type"), /image\/png/);
  assert.equal(htmlPreviewResponse.status, 200);
  assert.match(htmlPreviewResponse.headers.get("content-type"), /text\/html/);
  assert.match(htmlPreview, /preview/);
});

test("editor server does not serve static symlinks outside the data root", async (t) => {
  const rootDir = makeApiFixture();
  const outsideFile = path.join(path.dirname(rootDir), `${path.basename(rootDir)}-outside.txt`);
  writeFileSync(outsideFile, "private-outside-data");
  symlinkSync(outsideFile, path.join(rootDir, "output/cpp/outside.txt"));
  symlinkSync(outsideFile, path.join(rootDir, "assets/outside.txt"));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());

  const [outputResponse, assetResponse] = await Promise.all([
    fetch(`${app.url}/output/cpp/outside.txt`),
    fetch(`${app.url}/assets/outside.txt`)
  ]);

  assert.equal(outputResponse.status, 404);
  assert.equal(assetResponse.status, 404);
});

test("editor server maps code files from project root and user files from data root", async (t) => {
  const projectRoot = makeProjectFixture();
  const dataRoot = makeApiFixture();
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg>data-root-photo</svg>");
  writeFileSync(previewHtmlPath(dataRoot), "<!doctype html><p>data-root-preview</p>");
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    projectRoot,
    dataRoot,
    log: false
  });
  t.after(async () => app.close());

  const [index, script, template, photo, preview] = await Promise.all([
    fetch(`${app.url}/`).then((response) => response.text()),
    fetch(`${app.url}/editor/app.js`).then((response) => response.text()),
    fetch(`${app.url}/templates/resume.css`).then((response) => response.text()),
    fetch(`${app.url}/assets/photo.svg`).then((response) => response.text()),
    fetch(`${app.url}/output/cpp/preview.html`).then((response) => response.text())
  ]);

  assert.match(index, /project-root-index/);
  assert.match(script, /project-root-script/);
  assert.match(template, /project-root-resume-css/);
  assert.match(photo, /data-root-photo/);
  assert.match(preview, /data-root-preview/);
});

test("editor resume APIs read and write only the configured data root", async (t) => {
  const projectRoot = makeProjectFixture();
  const dataRoot = makeApiFixture();
  const resume = loadResumeYaml(resumeYamlPath(dataRoot));
  resume.profile.name = "Data Root Candidate";
  saveResumeYaml(resumeYamlPath(dataRoot), resume);
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    projectRoot,
    dataRoot,
    log: false
  });
  t.after(async () => app.close());

  const getResponse = await fetch(`${app.url}/api/resume?resumeId=cpp`);
  const getBody = await getResponse.json();
  const updated = structuredClone(getBody.resume);
  updated.profile.name = "Saved In Data Root";
  const putResponse = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updated)
  });

  assert.equal(getBody.resume.profile.name, "Data Root Candidate");
  assert.equal(putResponse.status, 200);
  assert.equal(loadResumeYaml(resumeYamlPath(dataRoot)).profile.name, "Saved In Data Root");
  assert.equal(existsSync(path.join(projectRoot, "resumes.json")), false);
  assert.equal(existsSync(path.join(projectRoot, "backups")), false);
});

test("editor generation passes both project and data roots", async (t) => {
  const projectRoot = makeProjectFixture();
  const dataRoot = makeApiFixture();
  let receivedOptions;
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    projectRoot,
    dataRoot,
    generateResume: async (options) => {
      receivedOptions = options;
      return {
        density: "normal",
        metrics: { height: 900 },
        outputPaths: {
          preview: path.join(dataRoot, "output/cpp/preview.html"),
          pdf: path.join(dataRoot, "output/cpp/resume.pdf"),
          png: path.join(dataRoot, "output/cpp/resume.png")
        }
      };
    },
    log: false
  });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp" })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedOptions, { projectRoot, dataRoot, resumeId: "cpp" });
});

test("creating from an example materializes its allowlisted photo in the data root", async (t) => {
  const projectRoot = makeProjectFixture();
  const dataRoot = makeApiFixture();
  unlinkSync(path.join(dataRoot, "assets/photo.svg"));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    projectRoot,
    dataRoot,
    log: false
  });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/resumes/from-example`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exampleId: "cpp", name: "Example Copy" })
  });

  assert.equal(response.status, 201);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>public-placeholder</svg>"
  );
});

test("editor opens a draft directly when the generated preview is absent", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  const privateLookingPath = ["", "Users", "example", "private"].join("/");
  const generatedPreviewRequests = [];
  const consoleErrors = [];
  page.on("response", (response) => {
    if (response.url().includes("/output/cpp/preview.html")) {
      generatedPreviewRequests.push(response.status());
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await waitForPreviewInteractive(page);

  assert.deepEqual(generatedPreviewRequests, []);
  assert.deepEqual(consoleErrors, []);
  assert.match(await page.textContent("#statusStrip"), /PDF 待生成/);
  assert.match(await page.getAttribute("#previewFrame", "srcdoc"), /测试候选人/);
});

test("editor switches modules when a preview section is clicked", async (t) => {
  const rootDir = makeApiFixture();
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-module='profile']");
  await waitForPreviewInteractive(page);
  await page.frameLocator("#previewFrame").locator("section[data-section='skills']").click();
  await page.waitForFunction(() => document
    .querySelector("[data-module='skills']")
    ?.getAttribute("aria-selected") === "true");

  assert.equal(await page.getAttribute("[data-area='content']", "aria-selected"), "true");
  assert.equal(await page.getAttribute("[data-module='skills']", "aria-selected"), "true");
  assert.match(await page.textContent("#messageLine"), /正在编辑：专业技能/);
});

test("editor opens a profile field when the matching preview field is selected", async (t) => {
  const rootDir = makeApiFixture();
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await sendPreviewSelection(page, "profile", "profile.name");
  await page.waitForSelector("[data-path='profile.name'].is-form-selected");

  assert.equal(await page.getAttribute("[data-area='content']", "aria-selected"), "true");
  assert.equal(await page.getAttribute("[data-module='profile']", "aria-selected"), "true");
  assert.equal(await page.locator("[data-path='profile.name']").inputValue(), "测试候选人");
  assert.match(await page.textContent("#messageLine"), /正在编辑：姓名/);
});

test("editor scrolls to a content card when the matching preview card is clicked", async (t) => {
  const rootDir = makeApiFixture();
  const resume = resumeWithContentCards();
  saveResumeYaml(resumeYamlPath(rootDir), resume);
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(resume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-module='profile']");

  await sendPreviewSelection(page, "internships", "internships.0");
  await page.waitForSelector(".item-block.is-form-selected[data-path='internships.0']");
  assert.equal(await page.getAttribute("[data-module='internships']", "aria-selected"), "true");
  assert.match(await page.textContent("#messageLine"), /正在编辑：实习经历 1/);

  await sendPreviewSelection(page, "skills", "skills.0");
  await page.waitForSelector(".item-block.is-form-selected[data-path='skills.0']");
  assert.equal(await page.getAttribute("[data-module='skills']", "aria-selected"), "true");
  assert.match(await page.textContent("#messageLine"), /正在编辑：专业技能 1/);

  await sendPreviewSelection(page, "projects", "projects.0");
  await page.waitForSelector(".item-block.is-form-selected[data-path='projects.0']");
  assert.equal(await page.getAttribute("[data-module='projects']", "aria-selected"), "true");
  assert.match(await page.textContent("#messageLine"), /正在编辑：项目经历 1/);
});

test("editor opens nested form controls when matching preview fields are clicked", async (t) => {
  const rootDir = makeApiFixture();
  const resume = resumeWithContentCards();
  saveResumeYaml(resumeYamlPath(rootDir), resume);
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(resume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await waitForPreviewInteractive(page);

  const frame = page.frameLocator("#previewFrame");
  assert.equal(await frame.locator("[data-path='internships.0.organization']").count(), 1);
  assert.equal(await frame.locator("[data-path='skills.0.items.0']").count(), 1);
  assert.equal(await frame.locator("[data-path='projects.0.items.0']").count(), 1);

  await sendPreviewSelection(page, "internships", "internships.0.organization");
  await page.waitForFunction(() => document.querySelector("[data-module='internships']")?.getAttribute("aria-selected") === "true");
  assert.equal(await page.getAttribute("[data-module='internships']", "aria-selected"), "true");
  assert.equal(await page.locator("[data-path='internships.0.organization']").inputValue(), "示例科技有限公司");
  assert.match(await page.textContent("#messageLine"), /正在编辑：实习经历 1 公司/);

  await sendPreviewSelection(page, "skills", "skills.0.items.0");
  await page.waitForFunction(() => document.querySelector("[data-module='skills']")?.getAttribute("aria-selected") === "true");
  assert.equal(await page.getAttribute("[data-module='skills']", "aria-selected"), "true");
  assert.equal(await page.locator("[data-path='skills.0.items.0']").inputValue(), "熟悉 C/C++ 基本语法。");
  assert.match(await page.textContent("#messageLine"), /正在编辑：专业技能 1 要点 1/);

  await sendPreviewSelection(page, "projects", "projects.0.items.0");
  await page.waitForFunction(() => document.querySelector("[data-module='projects']")?.getAttribute("aria-selected") === "true");
  assert.equal(await page.getAttribute("[data-module='projects']", "aria-selected"), "true");
  assert.equal(await page.locator("[data-path='projects.0.items.0']").inputValue(), "模拟实现核心功能。");
  assert.match(await page.textContent("#messageLine"), /正在编辑：项目经历 1 要点 1/);
});

test("editor adds experiences skills and bullets in the expected location", async (t) => {
  const rootDir = makeApiFixture();
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);

  await page.click("[data-module='internships']");
  await page.click("[data-action='add-experience'][data-key='internships']");
  await page.waitForSelector("[data-path='internships.0.start']");
  assert.equal(await page.locator("[data-path='internships.0.start']").count(), 1);
  assert.match(await page.textContent("#statusStrip"), /未保存/);

  await page.click("[data-module='projects']");
  await page.click("[data-action='add-experience'][data-key='projects']");
  await page.waitForSelector("[data-path='projects.0.start']");
  assert.equal(await page.locator("[data-path='projects.0.start']").count(), 1);

  await page.click("[data-module='skills']");
  await page.click("[data-action='add-skill']");
  await page.waitForSelector("[data-path='skills.1.title']");
  assert.equal(await page.locator("[data-path='skills.1.title']").count(), 1);

  await page.click("[data-action='add-bullet'][data-key='skills'][data-index='0']");
  await page.waitForSelector("[data-path='skills.0.items.1']");
  assert.equal(await page.locator("[data-path='skills.0.items.1']").count(), 1);
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    const status = document.querySelector("#statusStrip")?.textContent || "";
    return Boolean(iframe?.contentDocument?.querySelector("[data-path='skills.0.items.1']"))
      && status.includes("草稿预览");
  });
});

test("editor confirms deletion inline and focuses adjacent content", async (t) => {
  const rootDir = makeApiFixture();
  const resume = resumeWithDeleteTargets();
  saveResumeYaml(resumeYamlPath(rootDir), resume);
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(resume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  let dialogCount = 0;
  page.on("dialog", async (dialog) => {
    dialogCount += 1;
    await dialog.dismiss();
  });

  await page.goto(app.url);
  await page.click("[data-module='skills']");

  await page.click("[data-action='delete-bullet'][data-key='skills'][data-index='0'][data-item-index='0']");
  await page.waitForSelector(".delete-confirm-panel [data-action='confirm-delete'][data-kind='bullet'][data-key='skills'][data-index='0'][data-item-index='0']");
  assert.equal(dialogCount, 0);
  assert.equal(await page.locator("[data-path^='skills.0.items.']").count(), 2);
  assert.equal(await page.locator(".row-actions-bullet.is-confirming-delete").count(), 0);

  await page.click("[data-action='cancel-delete'][data-kind='bullet'][data-key='skills'][data-index='0'][data-item-index='0']");
  await page.waitForSelector("[data-action='delete-bullet'][data-key='skills'][data-index='0'][data-item-index='0']");
  assert.equal(await page.locator(".delete-confirm-panel").count(), 0);
  assert.equal(await page.locator("[data-path^='skills.0.items.']").count(), 2);

  await page.click("[data-action='delete-bullet'][data-key='skills'][data-index='0'][data-item-index='0']");
  await page.click(".delete-confirm-panel [data-action='confirm-delete'][data-kind='bullet'][data-key='skills'][data-index='0'][data-item-index='0']");
  await page.waitForFunction(() => document.activeElement?.dataset?.path === "skills.0.items.0");
  assert.equal(await page.locator("[data-path^='skills.0.items.']").count(), 1);
  assert.equal(await page.locator("[data-path='skills.0.items.0']").inputValue(), "第二条技能要点。");

  await page.click("[data-action='delete-skill'][data-key='skills'][data-index='0']");
  await page.waitForSelector(".item-block[data-path='skills.0'] .delete-confirm-panel");
  await page.click(".delete-confirm-panel [data-action='confirm-delete'][data-kind='skill'][data-key='skills'][data-index='0']");
  await page.waitForFunction(() => document.activeElement?.dataset?.path === "skills.0.title");
  assert.equal(await page.locator(".item-block").count(), 1);
  assert.equal(await page.locator("[data-path='skills.0.title']").inputValue(), "操作系统/Linux 系统编程");

  await page.click("[data-module='internships']");
  await page.click("[data-action='delete-experience'][data-key='internships'][data-index='0']");
  await page.waitForSelector(".item-block[data-path='internships.0'] .delete-confirm-panel");
  await page.click(".delete-confirm-panel [data-action='confirm-delete'][data-kind='experience'][data-key='internships'][data-index='0']");
  await page.waitForFunction(() => document.activeElement?.dataset?.path === "internships.0.start");
  assert.equal(await page.locator(".item-block").count(), 1);
  assert.equal(await page.locator("[data-path='internships.0.start']").inputValue(), "2025.09");
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    const remainingCompany = iframe?.contentDocument?.querySelector("[data-path='internships.0.organization']")?.textContent || "";
    const status = document.querySelector("#statusStrip")?.textContent || "";
    return remainingCompany.includes("第二家公司") && status.includes("草稿预览");
  });
});

test("editor protects edits, saves with keyboard shortcuts, and generates the latest preview", async (t) => {
  const rootDir = makeApiFixture();
  const previewPath = previewHtmlPath(rootDir);
  writeFileSync(previewPath, renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    generateResume: async () => {
      const savedResume = loadResumeYaml(resumeYamlPath(rootDir));
      writeFileSync(previewPath, renderResumeHtml(savedResume, {
        density: "tight",
        cssPath: "/templates/resume.css"
      }));
      return {
        density: "tight",
        metrics: { height: 1000 },
        layout: {
          mode: "fixed",
          fontSizePt: 10.3,
          lineHeight: 1.27,
          spacingLevel: 35,
          marginPreset: "narrow",
          cssVariables: { "--body-size": "10.3pt" }
        },
        overflow: { vertical: 0, horizontal: 0, total: 0 },
        outputPaths: {
          preview: previewPath,
          pdf: path.join(rootDir, "output/resume.pdf"),
          png: path.join(rootDir, "output/resume.png")
        }
      };
    },
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  let saveRequestCount = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes("/api/resume?")) {
      saveRequestCount += 1;
    }
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await waitForPreviewInteractive(page);
  await page.evaluate(() => {
    window.__resumeSaveShortcuts = [];
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        window.__resumeSaveShortcuts.push(event.defaultPrevented);
      }
    });
  });
  assert.match(await page.textContent("#statusStrip"), /预览已更新/);
  assert.equal(await page.textContent("#generateButton"), "重新生成预览");
  assert.deepEqual(await dispatchBeforeUnload(page), {
    defaultPrevented: false,
    dispatchResult: true
  });

  await page.fill("[data-path='profile.name']", "测试姓名");
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("草稿预览"));
  assert.match(await page.textContent("#statusStrip"), /未保存/);
  assert.equal(await page.textContent("#generateButton"), "保存后生成");
  assert.equal(await page.locator("#generateButton").isDisabled(), true);
  assert.deepEqual(await dispatchBeforeUnload(page), {
    defaultPrevented: true,
    dispatchResult: false
  });

  await dispatchPreviewClick(page, "[data-path='profile.name']");
  await page.waitForFunction(() => document.querySelector("#messageLine")?.textContent?.includes("未保存草稿"));

  const metaSaveResponse = page.waitForResponse((response) => response.request().method() === "PUT"
    && response.url().includes("/api/resume?"));
  await page.keyboard.press("Meta+S");
  await metaSaveResponse;
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("PDF 待生成"));
  assert.match(await page.textContent("#statusStrip"), /已保存/);
  assert.equal(await page.textContent("#generateButton"), "生成 PDF");
  assert.equal(await page.locator("#generateButton").isDisabled(), false);
  assert.match(await page.getAttribute("#previewFrame", "srcdoc"), /测试姓名/);
  assert.deepEqual(await dispatchBeforeUnload(page), {
    defaultPrevented: false,
    dispatchResult: true
  });

  await page.fill("[data-path='profile.name']", "Ctrl 保存测试");
  const ctrlSaveResponse = page.waitForResponse((response) => response.request().method() === "PUT"
    && response.url().includes("/api/resume?"));
  await page.keyboard.press("Control+S");
  await ctrlSaveResponse;
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("PDF 待生成")
    && document.querySelector("#statusStrip")?.textContent?.includes("已保存"));
  assert.equal(saveRequestCount, 2);
  assert.equal(loadResumeYaml(resumeYamlPath(rootDir)).profile.name, "Ctrl 保存测试");
  assert.deepEqual(await page.evaluate(() => window.__resumeSaveShortcuts), [true, true]);

  await page.click("#generateButton");
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("预览已更新"));
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    return !iframe?.hasAttribute("srcdoc")
      && iframe?.contentDocument?.querySelector("[data-path='profile.name']")?.textContent?.includes("Ctrl 保存测试");
  });
  assert.equal(await page.textContent("#generateButton"), "重新生成预览");
  assert.match(await page.textContent("#messageLine"), /预览已更新/);
  assert.match(await page.textContent("#statusStrip"), /固定.*10\.3pt.*行距 1\.27.*较紧.*窄边距/);
  assert.match(await page.textContent("#statusStrip"), /A4 单页/);
});

test("editor renders unsaved edits in a debounced draft preview without writing files", async (t) => {
  const rootDir = makeApiFixture();
  const previewPath = previewHtmlPath(rootDir);
  const generatedPreview = renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  });
  writeFileSync(previewPath, generatedPreview);
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await waitForPreviewInteractive(page);

  await page.fill("[data-path='profile.name']", "实时草稿姓名");
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    const previewName = iframe?.contentDocument?.querySelector("[data-path='profile.name']")?.textContent || "";
    const status = document.querySelector("#statusStrip")?.textContent || "";
    return previewName.includes("实时草稿姓名") && status.includes("草稿预览");
  }, null, { timeout: 2000 });

  assert.match(await page.textContent("#statusStrip"), /未保存/);
  assert.equal(await page.textContent("#generateButton"), "保存后生成");
  assert.equal(loadResumeYaml(resumeYamlPath(rootDir)).profile.name, "测试候选人");
  assert.equal(readFileSync(previewPath, "utf8"), generatedPreview);
});

test("draft preview applies layout candidates in order and selects the first A4 fit", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  await installControlledLayoutMeasurements(page, {
    "11.2pt": 24,
    "10.8pt": 0
  });
  await installVisibleLayoutTracking(page);
  await page.route("**/api/preview", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        resumeId: "cpp",
        html: renderResumeHtml(body.resume, { density: "custom", cssPath: "/templates/resume.css" }),
        layout: {
          mode: "auto",
          candidates: [
            {
              mode: "auto", fontSizePt: 11.2, lineHeight: 1.4, spacingLevel: 80, marginPreset: "normal",
              cssVariables: { "--body-size": "11.2pt", "--body-line-height": "1.4" }
            },
            {
              mode: "auto", fontSizePt: 10.8, lineHeight: 1.32, spacingLevel: 50, marginPreset: "normal",
              cssVariables: { "--body-size": "10.8pt", "--body-line-height": "1.32" }
            }
          ]
        }
      })
    });
  });

  await page.goto(app.url);
  await page.fill("[data-path='profile.name']", "候选适配测试");
  await page.waitForFunction(() => {
    const status = document.querySelector("#statusStrip")?.textContent || "";
    return status.includes("10.8pt") && status.includes("A4 单页");
  });

  assert.deepEqual(await page.evaluate(() => window.__layoutMeasurements), ["11.2pt", "10.8pt"]);
  assert.equal(await page.evaluate(() => window.__visibleLayoutSizes.includes("11.2pt")), false);
  assert.equal(await page.evaluate(() => window.__visibleLayoutSizes.at(-1)), "10.8pt");
  assert.match(await page.textContent("#statusStrip"), /自动.*10\.8pt.*行距 1\.32.*较紧.*标准边距/);
});

test("layout-only drafts reuse the preview document while content drafts reload it", async (t) => {
  const rootDir = makeApiFixture();
  const resume = structuredClone(validResume);
  resume.layout = {
    mode: "fixed",
    fontSizePt: 10.8,
    lineHeight: 1.38,
    spacingLevel: 67,
    marginPreset: "normal",
    sectionOrder: ["internships", "skills", "projects"]
  };
  saveResumeYaml(resumeYamlPath(rootDir), resume);
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(resume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await page.waitForSelector("[data-area='layout']");
  await waitForPreviewInteractive(page);
  await page.click("[data-area='layout']");
  await page.locator("#previewFrame").evaluate((iframe) => {
    window.__trackedPreviewDocument = iframe.contentDocument;
    window.__trackedPreviewLoads = 0;
    iframe.addEventListener("load", () => {
      window.__trackedPreviewLoads += 1;
    });
  });

  await page.locator("input[data-layout-field='fontSizePt']").fill("10.9");
  await page.waitForFunction(() => {
    const status = document.querySelector("#statusStrip")?.textContent || "";
    return status.includes("10.9pt") && status.includes("草稿预览");
  });
  assert.deepEqual(await page.locator("#previewFrame").evaluate((iframe) => ({
    sameDocument: iframe.contentDocument === window.__trackedPreviewDocument,
    loadCount: window.__trackedPreviewLoads
  })), {
    sameDocument: true,
    loadCount: 0
  });

  await page.click("[data-area='content']");
  await page.fill("[data-path='profile.name']", "内容变更仍需重载");
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    return iframe?.contentDocument?.querySelector("[data-path='profile.name']")?.textContent?.includes("内容变更仍需重载");
  });
  assert.deepEqual(await page.locator("#previewFrame").evaluate((iframe) => ({
    sameDocument: iframe.contentDocument === window.__trackedPreviewDocument,
    loadCount: window.__trackedPreviewLoads
  })), {
    sameDocument: false,
    loadCount: 1
  });
});

test("fixed draft overflow allows saving but gates generation until the draft fits", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  let fitting = false;
  await installControlledLayoutMeasurements(page, {
    "10.6pt": 38,
    "10.5pt": 0
  });
  await page.route("**/api/preview", async (route) => {
    const body = route.request().postDataJSON();
    const fontSizePt = fitting ? 10.5 : 10.6;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        resumeId: "cpp",
        html: renderResumeHtml(body.resume, { density: "custom", cssPath: "/templates/resume.css" }),
        layout: {
          mode: "fixed",
          candidates: [{
            mode: "fixed", fontSizePt, lineHeight: 1.3, spacingLevel: 50, marginPreset: "narrow",
            cssVariables: { "--body-size": `${fontSizePt}pt`, "--body-line-height": "1.3" }
          }]
        }
      })
    });
  });

  await page.goto(app.url);
  await page.click("[data-area='layout']");
  await page.click("[data-action='set-layout-mode'][data-layout-value='fixed']");
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("超出 A4 38px"));
  assert.equal(await page.locator("#saveButton").isDisabled(), false);
  assert.equal(await page.locator("#generateButton").isDisabled(), true);

  await page.click("#saveButton");
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("已保存"));
  assert.equal(await page.locator("#saveButton").isDisabled(), true);
  assert.equal(await page.locator("#generateButton").isDisabled(), true);

  fitting = true;
  await page.click("[data-area='content']");
  await page.fill("[data-path='profile.name']", "恢复为单页");
  await page.waitForFunction(() => {
    const status = document.querySelector("#statusStrip")?.textContent || "";
    return status.includes("10.5pt") && status.includes("A4 单页");
  });
  await page.click("#saveButton");
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("已保存"));
  assert.equal(await page.locator("#generateButton").isDisabled(), false);
});

test("editor ignores a slower draft response after a newer edit", async (t) => {
  const previewRequests = [];
  const app = await startCustomEditorServer(async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/resume") {
      sendTestJson(response, 200, { ok: true, resume: validResume });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/examples") {
      sendTestJson(response, 200, { ok: true, examples: [] });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/backups") {
      sendTestJson(response, 200, { ok: true, backups: [] });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/preview") {
      const body = await readTestJsonBody(request);
      const name = body.resume.profile.name;
      previewRequests.push(name);
      if (name === "较慢的第一版") {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      const fontSizePt = name === "较慢的第一版" ? 11.2 : 10.4;
      sendTestJson(response, 200, {
        ok: true,
        html: renderResumeHtml(body.resume, {
          density: "normal",
          cssPath: "/templates/resume.css",
          assetPrefix: "/"
        }),
        layout: {
          mode: "fixed",
          candidates: [{
            mode: "fixed",
            fontSizePt,
            lineHeight: 1.3,
            spacingLevel: 50,
            marginPreset: "normal",
            cssVariables: { "--body-size": `${fontSizePt}pt`, "--body-line-height": "1.3" }
          }]
        }
      });
      return true;
    }
    return false;
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.fill("[data-path='profile.name']", "较慢的第一版");
  await page.waitForTimeout(350);
  await page.fill("[data-path='profile.name']", "最终的第二版");
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    return iframe?.contentDocument?.querySelector("[data-path='profile.name']")?.textContent?.includes("最终的第二版");
  });
  await page.waitForTimeout(600);

  const previewName = await page.frameLocator("#previewFrame").locator("[data-path='profile.name']").textContent();
  assert.match(previewName, /最终的第二版/);
  assert.deepEqual(previewRequests, ["较慢的第一版", "最终的第二版"]);
  assert.match(await page.textContent("#statusStrip"), /10\.4pt/);
  assert.doesNotMatch(await page.textContent("#statusStrip"), /11\.2pt/);
});

test("editor previews section reordering without saving yaml", async (t) => {
  const rootDir = makeApiFixture();
  const resume = structuredClone(validResume);
  resume.layout = { sectionOrder: ["internships", "skills", "projects"] };
  const resumePath = resumeYamlPath(rootDir);
  saveResumeYaml(resumePath, resume);
  const resumeBefore = readFileSync(resumePath, "utf8");
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(resume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-area='layout']");
  await page.click("[data-area='layout']");
  await page.click("[data-action='move-layout'][data-index='0'][data-direction='1']");
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    const sections = Array.from(iframe?.contentDocument?.querySelectorAll("#resume-page > section") || []);
    const status = document.querySelector("#statusStrip")?.textContent || "";
    return sections[0]?.dataset.section === "skills"
      && sections[1]?.dataset.section === "internships"
      && status.includes("草稿预览");
  });

  assert.match(await page.textContent("#statusStrip"), /草稿预览/);
  assert.equal(readFileSync(resumePath, "utf8"), resumeBefore);
});

test("editor exposes bounded layout settings and previews changed values", async (t) => {
  const rootDir = makeApiFixture();
  const originalProfile = structuredClone(validResume.profile);
  const previewBodies = [];
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());

  const page = await openEditorPage(t);
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/preview")) {
      previewBodies.push(request.postDataJSON());
    }
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-area='layout']");

  assert.deepEqual(
    await page.locator("[data-area]").evaluateAll((buttons) => buttons.map((button) => button.textContent.trim())),
    ["内容编辑", "排版设置"]
  );
  await page.click("[data-area='layout']");

  assert.match(await page.textContent("#editorForm"), /适配方式/);
  assert.match(await page.textContent("#editorForm"), /正文字号/);
  assert.match(await page.textContent("#editorForm"), /行高/);
  assert.match(await page.textContent("#editorForm"), /内容间距/);
  assert.match(await page.textContent("#editorForm"), /页边距/);
  assert.match(await page.textContent("#editorForm"), /模块顺序/);
  assert.equal(await page.getAttribute("[data-action='set-layout-mode'][data-layout-value='auto']", "aria-pressed"), "true");
  assert.equal(await page.inputValue("input[data-layout-field='fontSizePt']"), "10.8");
  assert.equal(await page.inputValue("input[data-layout-field='lineHeight']"), "1.38");
  assert.equal(await page.inputValue("input[data-layout-field='spacingLevel']"), "67");
  assert.equal(await page.getAttribute("[data-action='set-layout-margin'][data-layout-value='normal']", "aria-pressed"), "true");
  assert.equal(await page.locator("[data-action='step-layout'][data-layout-field='fontSizePt'][data-direction='-1']").getAttribute("aria-label"), "减小正文字号");
  assert.equal(await page.locator("[data-action='step-layout'][data-layout-field='fontSizePt'][data-direction='1']").getAttribute("aria-label"), "增大正文字号");

  await page.click("[data-action='set-layout-mode'][data-layout-value='fixed']");
  await page.locator("input[data-layout-field='fontSizePt']").evaluate((input) => {
    window.__trackedLayoutRange = input;
    input.focus();
    input.value = "10.9";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.deepEqual(await page.evaluate(() => {
    const input = document.querySelector("input[data-layout-field='fontSizePt']");
    return {
      sameNode: input === window.__trackedLayoutRange,
      focused: document.activeElement === input,
      output: document.querySelector("[data-layout-output='fontSizePt']")?.textContent,
      valueText: input?.getAttribute("aria-valuetext")
    };
  }), {
    sameNode: true,
    focused: true,
    output: "10.9pt",
    valueText: "10.9pt"
  });
  await page.locator("input[data-layout-field='fontSizePt']").fill("11.2");
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("未保存"));
  assert.equal(await page.locator("[data-action='step-layout'][data-layout-field='fontSizePt'][data-direction='1']").isDisabled(), true);

  await page.locator("input[data-layout-field='fontSizePt']").focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.querySelector("input[data-layout-field='fontSizePt']")?.value === "11.1");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.layoutField), "fontSizePt");

  await page.waitForTimeout(400);
  assert.ok(previewBodies.some((body) => (
    body.resume.layout.mode === "fixed"
      && body.resume.layout.fontSizePt === 11.1
  )));

  await page.click("[data-action='reset-layout']");
  assert.equal(await page.inputValue("input[data-layout-field='fontSizePt']"), "10.8");
  assert.equal(await page.inputValue("input[data-layout-field='lineHeight']"), "1.38");
  assert.equal(await page.inputValue("input[data-layout-field='spacingLevel']"), "67");
  assert.equal(await page.getAttribute("[data-action='set-layout-mode'][data-layout-value='auto']", "aria-pressed"), "true");
  await page.click("[data-area='content']");
  assert.equal(await page.inputValue("[data-path='profile.name']"), originalProfile.name);
  assert.equal(await page.inputValue("[data-path='profile.target']"), originalProfile.target);
  assert.deepEqual(loadResumeYaml(resumeYamlPath(rootDir)).profile, originalProfile);
});

test("layout settings stay independent across resumes and survive duplication", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const cppPath = resumeYamlPath(rootDir, "cpp");
  const aiPath = resumeYamlPath(rootDir, "ai-agent");
  const cppResume = loadResumeYaml(cppPath);
  cppResume.layout = {
    mode: "fixed",
    fontSizePt: 10.4,
    lineHeight: 1.29,
    spacingLevel: 35,
    marginPreset: "narrow"
  };
  const aiResume = loadResumeYaml(aiPath);
  aiResume.layout = {
    mode: "auto",
    fontSizePt: 11.1,
    lineHeight: 1.4,
    spacingLevel: 80,
    marginPreset: "wide"
  };
  saveResumeYaml(cppPath, cppResume);
  saveResumeYaml(aiPath, aiResume);
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await waitForResumeOption(page, "ai-agent");
  await page.click("[data-area='layout']");
  assert.equal(await page.inputValue("input[data-layout-field='fontSizePt']"), "10.4");

  await selectResumeOption(page, "ai-agent");
  await page.waitForFunction(() => document.querySelector("[data-path='profile.name']")?.value === "AI Candidate");
  await page.click("[data-area='layout']");
  await page.waitForFunction(() => document.querySelector("input[data-layout-field='fontSizePt']")?.value === "11.1");
  assert.equal(await page.getAttribute("[data-action='set-layout-margin'][data-layout-value='wide']", "aria-pressed"), "true");

  await page.click("#addResumeButton");
  await page.click("[data-resume-action='duplicate']");
  await page.fill("#resumeDialogInput", "AI Layout Copy");
  await page.click("[data-dialog-action='confirm-duplicate']");
  await waitForResumeOption(page, "ai-layout-copy");
  await page.click("[data-area='layout']");
  assert.equal(await page.inputValue("input[data-layout-field='fontSizePt']"), "11.1");
  assert.equal(await page.inputValue("input[data-layout-field='spacingLevel']"), "80");
  assert.equal(await page.getAttribute("[data-action='set-layout-margin'][data-layout-value='wide']", "aria-pressed"), "true");
});

test("editor explains backend version mismatch when an API endpoint is missing", async (t) => {
  const app = await startCustomEditorServer(async (_request, response, url) => {
    if (url.pathname === "/api/resume") {
      sendTestJson(response, 200, { ok: true, resume: validResume });
      return true;
    }

    if (url.pathname === "/api/examples") {
      sendTestJson(response, 200, { ok: true, examples: [] });
      return true;
    }

    if (url.pathname === "/api/backups") {
      sendTestText(response, 404, "Not found");
      return true;
    }

    return false;
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  const backupsResponse = page.waitForResponse((response) => response.url().includes("/api/backups?"));
  await page.goto(app.url);
  await backupsResponse;
  await page.waitForFunction(() => {
    const text = document.querySelector("#messageLine")?.textContent || "";
    return text.includes("重新运行 npm run editor") || text.includes("前端和后端版本不一致");
  });

  assert.match(await page.textContent("#messageLine"), /前端和后端版本不一致/);
});

test("editor disables save controls while a save request is in flight", async (t) => {
  let releaseSave;
  let saveCount = 0;
  const saveBlocked = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const app = await startCustomEditorServer(async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/resume") {
      sendTestJson(response, 200, { ok: true, resume: validResume });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/examples") {
      sendTestJson(response, 200, { ok: true, examples: [] });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/backups") {
      sendTestJson(response, 200, { ok: true, backups: [] });
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/resume") {
      saveCount += 1;
      await saveBlocked;
      sendTestJson(response, 200, {
        ok: true,
        resume: validResume,
        backup: "backups/cpp/resume.backup.yaml",
        versionedBackup: "backups/cpp/resume-20260710-142530.yaml"
      });
      return true;
    }

    return false;
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.fill("[data-path='profile.name']", "测试姓名");
  await page.click("#saveButton");
  await page.waitForFunction(() => document.querySelector("#saveButton")?.textContent === "保存中");

  assert.equal(await page.locator("#saveButton").isDisabled(), true);
  assert.equal(await page.locator("#generateButton").isDisabled(), true);
  assert.equal(await page.locator("#loadExampleButton").isDisabled(), true);
  assert.equal(saveCount, 1);

  releaseSave();
  await page.waitForFunction(() => document.querySelector("#saveButton")?.textContent === "保存");
  assert.equal(saveCount, 1);
  assert.match(await page.textContent("#messageLine"), /已保存/);
});

test("editor lists recent backups and restores the selected backup after confirmation", async (t) => {
  const rootDir = makeApiFixture();
  const backupResume = structuredClone(validResume);
  backupResume.profile.name = "备份姓名";
  const currentResume = structuredClone(validResume);
  currentResume.profile.name = "当前姓名";
  mkdirSync(path.join(rootDir, "backups/cpp"), { recursive: true });
  saveResumeYaml(resumeYamlPath(rootDir), currentResume);
  saveResumeYaml(path.join(rootDir, "backups/cpp/resume-20260710-142530.yaml"), backupResume);
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(currentResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.addInitScript(() => {
    window.__confirmMessages = [];
    window.confirm = (message) => {
      window.__confirmMessages.push(message);
      return true;
    };
  });

  await page.goto(app.url);
  await page.waitForFunction(() => Array
    .from(document.querySelectorAll("#backupSelect option"))
    .some((option) => option.value === "backups/cpp/resume-20260710-142530.yaml"));
  await page.fill("[data-path='profile.name']", "恢复前的未保存草稿");
  await page.waitForFunction(() => document.querySelector("#statusStrip")?.textContent?.includes("草稿预览"));
  assert.match(await page.getAttribute("#previewFrame", "srcdoc"), /恢复前的未保存草稿/);
  await page.selectOption("#backupSelect", "backups/cpp/resume-20260710-142530.yaml");
  await page.click("#restoreBackupButton");
  await page.waitForFunction(() => document.querySelector("#messageLine")?.textContent?.includes("已恢复备份"));
  await page.waitForSelector("[data-path='profile.name']");

  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));
  const confirmMessages = await page.evaluate(() => window.__confirmMessages);
  assert.equal(confirmMessages.length, 1);
  assert.match(confirmMessages[0], /确认恢复备份/);
  assert.equal(reloaded.profile.name, "备份姓名");
  assert.equal(await page.locator("[data-path='profile.name']").inputValue(), "备份姓名");
  assert.match(await page.textContent("#statusStrip"), /待生成/);
  assert.equal(await page.getAttribute("#previewFrame", "srcdoc"), null);
});

test("editor scales the HTML preview so the A4 page is not horizontally clipped", async (t) => {
  const rootDir = makeApiFixture();
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t, { viewport: { width: 1280, height: 900 } });
  await page.goto(app.url);
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    const resume = iframe?.contentDocument?.querySelector("#resume-page");
    return Boolean(resume);
  });

  const metrics = await page.locator("#previewFrame").evaluate((iframe) => {
    const documentInFrame = iframe.contentDocument;
    const resume = documentInFrame.querySelector("#resume-page");
    return {
      iframeViewportWidth: iframe.contentWindow.innerWidth,
      resumeWidth: Math.ceil(resume.getBoundingClientRect().width)
    };
  });

  assert.ok(metrics.iframeViewportWidth >= metrics.resumeWidth);
});

test("editor keeps the complete A4 preview and footer inside the viewport", async (t) => {
  const rootDir = makeApiFixture();
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t, { viewport: { width: 1440, height: 900 } });
  await page.goto(app.url);
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    return Boolean(iframe?.contentDocument?.querySelector("#resume-page"));
  });

  const metrics = await page.evaluate(() => {
    const stage = document.querySelector(".preview-stage").getBoundingClientRect();
    const frame = document.querySelector(".a4-frame").getBoundingClientRect();
    const actionBar = document.querySelector(".action-bar").getBoundingClientRect();
    const message = document.querySelector(".message-line").getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      stage: { top: stage.top, bottom: stage.bottom },
      frame: { top: frame.top, bottom: frame.bottom },
      actionBar: { top: actionBar.top, bottom: actionBar.bottom },
      message: { top: message.top, bottom: message.bottom }
    };
  });

  assert.ok(metrics.documentHeight <= metrics.viewportHeight);
  assert.ok(metrics.frame.top >= metrics.stage.top);
  assert.ok(metrics.frame.bottom <= metrics.stage.bottom);
  assert.ok(metrics.actionBar.bottom <= metrics.viewportHeight);
  assert.ok(metrics.message.bottom <= metrics.viewportHeight);
});

test("editor asks to regenerate a preview created without field paths", async (t) => {
  const rootDir = makeApiFixture();
  const stalePreview = renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }).replace(/\sdata-path="[^"]*"/g, "");
  writeFileSync(previewHtmlPath(rootDir), stalePreview);
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await waitForPreviewInteractive(page);
  await page.waitForFunction(() => {
    const message = document.querySelector("#messageLine")?.textContent || "";
    return message.includes("旧版本生成") && message.includes("重新生成");
  }, null, { timeout: 1000 });

  assert.match(await page.textContent("#statusStrip"), /待生成/);
  assert.equal(await page.textContent("#generateButton"), "生成 PDF");
});

test("editor keeps footer utilities stacked beside the generate action", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t, { viewport: { width: 1024, height: 900 } });
  await page.goto(app.url);
  await page.waitForSelector("#generateButton");

  assert.equal(await page.locator(".example-actions").count(), 1);

  const metrics = await page.evaluate(() => {
    const actionBar = document.querySelector(".action-bar");
    const example = document.querySelector(".example-actions");
    const backup = document.querySelector(".backup-actions");
    const generate = document.querySelector("#generateButton");
    const box = (element) => element.getBoundingClientRect();
    return {
      display: window.getComputedStyle(actionBar).display,
      example: box(example),
      backup: box(backup),
      generate: box(generate)
    };
  });

  assert.equal(metrics.display, "grid");
  assert.ok(metrics.example.bottom <= metrics.backup.top);
  assert.ok(metrics.example.right < metrics.generate.left);
  assert.ok(metrics.backup.right < metrics.generate.left);
  assert.ok(metrics.generate.top < metrics.backup.top);
  assert.ok(metrics.generate.bottom > metrics.example.bottom);
});

test("preview field hover and selection do not paint ancestor sections", async (t) => {
  const rootDir = makeApiFixture();
  const resume = resumeWithContentCards();
  saveResumeYaml(resumeYamlPath(rootDir), resume);
  writeFileSync(previewHtmlPath(rootDir), renderResumeHtml(resume, {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const page = await openEditorPage(t);
  await page.goto(app.url);
  await waitForPreviewInteractive(page);
  const frame = page.frameLocator("#previewFrame");
  const skillSection = frame.locator("section[data-section='skills']");
  const skillGroup = frame.locator("[data-path='skills.0']");
  const skillBullet = frame.locator("[data-path='skills.0.items.0']");
  const bulletBox = await skillBullet.boundingBox();
  assert.ok(bulletBox);
  await page.mouse.move(bulletBox.x + bulletBox.width / 2, bulletBox.y + bulletBox.height / 2);
  await page.waitForTimeout(50);

  const hoverStyles = {
    sectionBackground: await skillSection.evaluate((section) => window.getComputedStyle(section).backgroundColor),
    groupBackground: await skillGroup.evaluate((group) => window.getComputedStyle(group).backgroundColor),
    bulletBackground: await skillBullet.evaluate((bullet) => window.getComputedStyle(bullet).backgroundColor)
  };
  assert.equal(hoverStyles.sectionBackground, "rgba(0, 0, 0, 0)");
  assert.equal(hoverStyles.groupBackground, "rgba(0, 0, 0, 0)");
  assert.notEqual(hoverStyles.bulletBackground, "rgba(0, 0, 0, 0)");

  await dispatchPreviewClick(page, "[data-path='skills.0.items.0']");
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    return iframe
      ?.contentDocument
      ?.querySelector("[data-path='skills.0.items.0']")
      ?.classList
      .contains("is-preview-selected");
  });
  await page.waitForFunction(() => {
    const iframe = document.querySelector("#previewFrame");
    const section = iframe?.contentDocument?.querySelector("section[data-section='skills']");
    const group = iframe?.contentDocument?.querySelector("[data-path='skills.0']");
    const bullet = iframe?.contentDocument?.querySelector("[data-path='skills.0.items.0']");
    if (!section || !group || !bullet) {
      return false;
    }
    const sectionStyle = iframe.contentWindow.getComputedStyle(section);
    const groupStyle = iframe.contentWindow.getComputedStyle(group);
    const bulletStyle = iframe.contentWindow.getComputedStyle(bullet);
    return bulletStyle.outlineStyle === "none"
      && bulletStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
      && bulletStyle.boxShadow === "none"
      && sectionStyle.backgroundColor === "rgba(0, 0, 0, 0)"
      && groupStyle.backgroundColor === "rgba(0, 0, 0, 0)";
  });

  const fieldStyles = await skillBullet.evaluate((bullet) => {
    const computed = window.getComputedStyle(bullet);
    return {
      outlineStyle: computed.outlineStyle,
      backgroundColor: computed.backgroundColor,
      boxShadow: computed.boxShadow
    };
  });
  const sectionBackground = await skillSection.evaluate((section) => window.getComputedStyle(section).backgroundColor);
  const groupBackground = await skillGroup.evaluate((group) => window.getComputedStyle(group).backgroundColor);

  await frame.locator("[data-path='internships.0.items.0']").hover();
  const experienceBackground = await frame
    .locator("[data-path='internships.0']")
    .evaluate((experience) => window.getComputedStyle(experience).backgroundColor);

  assert.equal(fieldStyles.outlineStyle, "none");
  assert.equal(fieldStyles.boxShadow, "none");
  assert.notEqual(fieldStyles.backgroundColor, "rgba(0, 0, 0, 0)");
  assert.equal(sectionBackground, "rgba(0, 0, 0, 0)");
  assert.equal(groupBackground, "rgba(0, 0, 0, 0)");
  assert.equal(experienceBackground, "rgba(0, 0, 0, 0)");
});

test("editor server falls back when the preferred port is occupied", async (t) => {
  const blocker = await startPortBlocker();
  t.after(() => blocker.close());
  const occupiedPort = blocker.address().port;
  const app = await startEditorServer({
    preferredPort: occupiedPort,
    maxPort: occupiedPort + 1,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  assert.equal(app.port, occupiedPort + 1);
  assert.equal(app.url, `http://127.0.0.1:${occupiedPort + 1}`);
});

test("recovery managers survive occupied-port fallback until final close", async (t) => {
  const blocker = await startPortBlocker();
  t.after(() => blocker.close());
  const occupiedPort = blocker.address().port;
  let importDisposeCalls = 0;
  let recoveryDisposeCalls = 0;
  const app = await startEditorServer({
    preferredPort: occupiedPort,
    maxPort: occupiedPort + 1,
    rootDir: makeApiFixture(),
    dataImportManager: stubImportManager({
      dispose() {
        importDisposeCalls += 1;
      }
    }),
    dataRecoveryManager: stubRecoveryManager({
      dispose() {
        recoveryDisposeCalls += 1;
      }
    }),
    log: false
  });
  t.after(async () => {
    if (app.server.listening) {
      await app.close();
    }
  });

  assert.equal(app.port, occupiedPort + 1);
  assert.equal(importDisposeCalls, 0);
  assert.equal(recoveryDisposeCalls, 0);

  await app.close();
  assert.equal(importDisposeCalls, 1);
  assert.equal(recoveryDisposeCalls, 1);
});

test("GET /api/resume returns the current resume yaml", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/resume?resumeId=cpp`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.resume.profile.name, "测试候选人");
  assert.equal(body.generatedPreviewAvailable, false);

  writeFileSync(previewHtmlPath(rootDir), "<!doctype html><p>generated</p>");
  const generatedResponse = await fetch(`${app.url}/api/resume?resumeId=cpp`);
  const generatedBody = await generatedResponse.json();
  assert.equal(generatedBody.generatedPreviewAvailable, true);
});

test("POST /api/preview renders draft HTML without writing project files", async (t) => {
  const rootDir = makeApiFixture();
  const resumePath = resumeYamlPath(rootDir);
  const previewPath = previewHtmlPath(rootDir);
  writeFileSync(previewPath, "existing generated preview");
  const resumeBefore = readFileSync(resumePath, "utf8");
  const previewBefore = readFileSync(previewPath, "utf8");
  const draft = structuredClone(validResume);
  draft.profile.name = "实时草稿姓名";
  draft.layout = {
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  };
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp", resume: draft })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.match(body.html, /实时草稿姓名/);
  assert.match(body.html, /data-path="profile\.name"/);
  assert.match(body.html, /href="\/templates\/resume\.css"/);
  assert.match(body.html, /src="\/assets\/photo\.svg"/);
  assert.match(body.html, /data-layout-mode="fixed"/);
  assert.match(body.html, /--body-size:\s*10\.5pt/);
  assert.equal(body.layout.mode, "fixed");
  assert.equal(body.layout.candidates.length, 1);
  assert.deepEqual(body.layout.candidates[0], {
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow",
    cssVariables: {
      "--body-size": "10.5pt",
      "--body-line-height": "1.3",
      "--page-x": "6mm",
      "--page-y": "4mm",
      "--item-gap": "2px",
      "--section-gap": "6px",
      "--experience-gap": "4px",
      "--bullet-indent": "15px",
      "--profile-size": "11.96pt",
      "--section-title-size": "13.61pt",
      "--skill-title-size": "12.25pt",
      "--experience-title-size": "12.64pt"
    }
  });
  assert.equal(JSON.stringify(body).includes(rootDir), false);
  assert.equal(readFileSync(resumePath, "utf8"), resumeBefore);
  assert.equal(readFileSync(previewPath, "utf8"), previewBefore);
  assert.equal(existsSync(path.join(rootDir, "backups/cpp/resume.backup.yaml")), false);
  assert.equal(existsSync(path.join(rootDir, "backups")), false);
});

test("POST /api/preview rejects invalid layout settings", async (t) => {
  const rootDir = makeApiFixture();
  const draft = structuredClone(validResume);
  draft.layout = { fontSizePt: 9.9 };
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp", resume: draft })
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /layout\.fontSizePt must be between 10\.2 and 11\.2/);
  assert.equal(JSON.stringify(body).includes(rootDir), false);
});

test("PUT /api/resume validates and saves resume yaml", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });
  const updated = structuredClone(validResume);
  updated.profile.name = "测试姓名";

  const response = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updated)
  });
  const body = await response.json();
  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(reloaded.profile.name, "测试姓名");
});

test("PUT /api/resume backs up the previous resume yaml before saving", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });
  const updated = structuredClone(validResume);
  updated.profile.name = "覆盖后的姓名";

  const response = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updated)
  });
  const body = await response.json();
  const backup = loadResumeYaml(path.join(rootDir, "backups/cpp/resume.backup.yaml"));

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.backup, "backups/cpp/resume.backup.yaml");
  assert.equal(backup.profile.name, "测试候选人");
});

test("PUT /api/resume writes a timestamped backup entry", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });
  const updated = structuredClone(validResume);
  updated.profile.name = "覆盖后的姓名";

  const response = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updated)
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.match(body.versionedBackup, /^backups\/cpp\/resume-\d{8}-\d{6}(?:-\d+)?\.yaml$/);
  assert.ok(existsSync(path.join(rootDir, body.versionedBackup)));
  assert.equal(loadResumeYaml(path.join(rootDir, body.versionedBackup)).profile.name, "测试候选人");
});

test("PUT /api/resume rejects invalid data without overwriting yaml", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });
  const invalid = structuredClone(validResume);
  delete invalid.profile.email;

  const response = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(invalid)
  });
  const body = await response.json();
  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /profile.email is required/);
  assert.equal(reloaded.profile.name, "测试候选人");
});

test("PUT /api/resume rejects oversized JSON bodies", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    bodyLimitBytes: 32,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(128) })
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.ok, false);
  assert.match(body.error, /File too large/);
});

test("POST /api/generate returns generation metadata and output URLs", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    generateResume: async () => ({
      density: "tight",
      metrics: { height: 1074 },
      layout: {
        mode: "auto",
        fontSizePt: 10.2,
        lineHeight: 1.25,
        spacingLevel: 0,
        marginPreset: "narrow",
        cssVariables: { "--body-size": "10.2pt" }
      },
      overflow: { vertical: 0, horizontal: 0, total: 0 },
      outputPaths: {
        preview: previewHtmlPath(rootDir),
        pdf: path.join(rootDir, "output/resume.pdf"),
        png: path.join(rootDir, "output/resume.png")
      }
    }),
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp" })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.density, "tight");
  assert.equal(body.contentHeight, 1074);
  assert.deepEqual(body.layout, {
    mode: "auto",
    fontSizePt: 10.2,
    lineHeight: 1.25,
    spacingLevel: 0,
    marginPreset: "narrow",
    cssVariables: { "--body-size": "10.2pt" }
  });
  assert.deepEqual(body.overflow, { vertical: 0, horizontal: 0, total: 0 });
  assert.equal(body.outputs.pdf, "/output/cpp/resume.pdf");
  assert.equal(body.outputs.png, "/output/cpp/resume.png");
  assert.equal(body.outputs.html, "/output/cpp/preview.html");
});

test("GET /api/backups returns recent timestamped backups", async (t) => {
  const rootDir = makeApiFixture();
  mkdirSync(path.join(rootDir, "backups/cpp"), { recursive: true });
  saveResumeYaml(path.join(rootDir, "backups/cpp/resume-20260710-142530.yaml"), validResume);
  saveResumeYaml(path.join(rootDir, "backups/cpp/resume-20260710-142531.yaml"), validResume);
  writeFileSync(path.join(rootDir, "backups/cpp/not-a-resume.yaml"), "profile: invalid\n");
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/backups?resumeId=cpp`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.backups.map((backup) => backup.file), [
    "backups/cpp/resume-20260710-142531.yaml",
    "backups/cpp/resume-20260710-142530.yaml"
  ]);
  assert.match(body.backups[0].label, /2026-07-10 14:25:31/);
});

test("POST /api/restore-backup restores an allowlisted backup and backs up current yaml first", async (t) => {
  const rootDir = makeApiFixture();
  const backupResume = structuredClone(validResume);
  backupResume.profile.name = "备份姓名";
  const currentResume = structuredClone(validResume);
  currentResume.profile.name = "当前姓名";
  mkdirSync(path.join(rootDir, "backups/cpp"), { recursive: true });
  saveResumeYaml(resumeYamlPath(rootDir), currentResume);
  saveResumeYaml(path.join(rootDir, "backups/cpp/resume-20260710-142530.yaml"), backupResume);
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/restore-backup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp", file: "backups/cpp/resume-20260710-142530.yaml" })
  });
  const body = await response.json();
  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.restoredBackup, "backups/cpp/resume-20260710-142530.yaml");
  assert.equal(reloaded.profile.name, "备份姓名");
  assert.equal(loadResumeYaml(path.join(rootDir, "backups/cpp/resume.backup.yaml")).profile.name, "当前姓名");
  assert.match(body.versionedBackup, /^backups\/cpp\/resume-\d{8}-\d{6}(?:-\d+)?\.yaml$/);
  assert.equal(loadResumeYaml(path.join(rootDir, body.versionedBackup)).profile.name, "当前姓名");
});

test("POST /api/restore-backup rejects path traversal without overwriting yaml", async (t) => {
  const rootDir = makeApiFixture();
  const currentResume = structuredClone(validResume);
  currentResume.profile.name = "当前姓名";
  saveResumeYaml(resumeYamlPath(rootDir), currentResume);
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/restore-backup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp", file: "../resume.yaml" })
  });
  const body = await response.json();
  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /Unknown backup/);
  assert.equal(reloaded.profile.name, "当前姓名");
});

test("GET /api/examples returns allowlisted examples", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/examples`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.examples.map((example) => example.id), ["cpp", "ai-agent"]);
});

test("POST /api/load-example loads an allowlisted example into resume yaml", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/load-example`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp", id: "ai-agent" })
  });
  const body = await response.json();
  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(reloaded.profile.target, "AI Agent 应用开发工程师");
});

test("POST /api/load-example backs up the previous resume yaml before overwriting", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/load-example`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp", id: "ai-agent" })
  });
  const body = await response.json();
  const backup = loadResumeYaml(path.join(rootDir, "backups/cpp/resume.backup.yaml"));

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.backup, "backups/cpp/resume.backup.yaml");
  assert.equal(backup.profile.target, "C++开发工程师");
});

test("POST /api/load-example rejects unknown example ids", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/load-example`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp", id: "../resume" })
  });
  const body = await response.json();
  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /Unknown example/);
  assert.equal(reloaded.profile.name, "测试候选人");
});

test("POST /api/photo writes a supported image and updates resume yaml", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/photo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resumeId: "cpp",
      filename: "portrait.png",
      dataUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
    })
  });
  const body = await response.json();
  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(reloaded.profile.photo, "assets/cpp-photo.png");
  assert.equal(body.resume.profile.photo, "assets/cpp-photo.png");
});

test("POST /api/photo rejects an asset symlink before writing outside the data root", async (t) => {
  const rootDir = makeApiFixture();
  const resume = loadResumeYaml(resumeYamlPath(rootDir));
  resume.profile.photo = "photos/photo.svg";
  mkdirSync(path.join(rootDir, "photos"));
  writeFileSync(path.join(rootDir, "photos/photo.svg"), "<svg></svg>");
  saveResumeYaml(resumeYamlPath(rootDir), resume);
  rmSync(path.join(rootDir, "assets"), { recursive: true });
  const outsideAssets = `${rootDir}-outside-assets`;
  mkdirSync(outsideAssets);
  symlinkSync(outsideAssets, path.join(rootDir, "assets"));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/photo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resumeId: "cpp",
      filename: "photo.png",
      dataUrl: "data:image/png;base64,cG5nLXBob3Rv"
    })
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /photo path.*inside/i);
  assert.equal(existsSync(path.join(outsideAssets, "cpp-photo.png")), false);
});

test("POST /api/photo rejects unsupported image extensions", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/photo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resumeId: "cpp",
      filename: "portrait.gif",
      dataUrl: `data:image/gif;base64,${Buffer.from("gif-bytes").toString("base64")}`
    })
  });
  const body = await response.json();
  const reloaded = loadResumeYaml(resumeYamlPath(rootDir));

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /Unsupported photo type/);
  assert.equal(reloaded.profile.photo, "assets/photo.svg");
});

test("POST /api/photo rejects decoded image bytes above the configured limit", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    photoLimitBytes: 4,
    log: false
  });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${app.url}/api/photo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resumeId: "cpp",
      filename: "portrait.png",
      dataUrl: `data:image/png;base64,${Buffer.from("too-large").toString("base64")}`
    })
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.ok, false);
  assert.match(body.error, /File too large/);
});

test("GET /api/resumes returns the validated registry", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/resumes`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.activeId, "cpp");
  assert.deepEqual(body.resumes.map(({ id, name }) => ({ id, name })), [
    { id: "cpp", name: "C++ 应届生" },
    { id: "ai-agent", name: "AI Agent" }
  ]);
});

test("POST /api/resumes/duplicate copies YAML and activates the new resume", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/resumes/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "cpp", name: "Backend Engineer" })
  });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.resume.id, "backend-engineer");
  assert.equal(body.activeId, "backend-engineer");
  assert.equal(loadResumeYaml(path.join(rootDir, "resumes/backend-engineer.yaml")).profile.name, "C++ Candidate");
  assert.equal(loadResumeYaml(path.join(rootDir, "resumes/cpp.yaml")).profile.name, "C++ Candidate");
});

test("POST /api/resumes/from-example creates and activates an allowlisted example", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/resumes/from-example`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ exampleId: "ai-agent", name: "Agent Platform" })
  });
  const body = await response.json();
  const created = loadResumeYaml(path.join(rootDir, "resumes/agent-platform.yaml"));

  assert.equal(response.status, 201);
  assert.equal(body.resume.id, "agent-platform");
  assert.equal(body.activeId, "agent-platform");
  assert.equal(created.profile.target, "AI Agent 应用开发工程师");
});

test("resume lifecycle API renames and activates registered resumes", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const renameResponse = await fetch(`${app.url}/api/resumes/ai-agent`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "AI Agent 校招" })
  });
  const renameBody = await renameResponse.json();
  const activateResponse = await fetch(`${app.url}/api/resumes/ai-agent/activate`, { method: "POST" });
  const activateBody = await activateResponse.json();

  assert.equal(renameResponse.status, 200);
  assert.equal(renameBody.resume.name, "AI Agent 校招");
  assert.equal(renameBody.resume.id, "ai-agent");
  assert.equal(activateResponse.status, 200);
  assert.equal(activateBody.activeId, "ai-agent");
  assert.equal(JSON.parse(readFileSync(path.join(rootDir, "resumes.json"), "utf8")).activeId, "ai-agent");
});

test("DELETE /api/resumes/:id removes only allowlisted resume data", async (t) => {
  const rootDir = makeMultiResumeFixture();
  mkdirSync(path.join(rootDir, "backups/cpp"), { recursive: true });
  mkdirSync(path.join(rootDir, "output/cpp"), { recursive: true });
  writeFileSync(path.join(rootDir, "backups/cpp/resume-20260710-142530.yaml"), "backup");
  writeFileSync(path.join(rootDir, "output/cpp/preview.html"), "preview");
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/resumes/cpp`, { method: "DELETE" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.deletedId, "cpp");
  assert.equal(body.activeId, "ai-agent");
  assert.equal(existsSync(path.join(rootDir, "resumes/cpp.yaml")), false);
  assert.equal(existsSync(path.join(rootDir, "backups/cpp")), false);
  assert.equal(existsSync(path.join(rootDir, "output/cpp")), false);
  assert.equal(existsSync(path.join(rootDir, "resumes/ai-agent.yaml")), true);
  assert.equal(existsSync(path.join(rootDir, "assets/photo.svg")), true);
});

test("resume lifecycle rejects duplicate names unknown ids and unsafe ids without file changes", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const registryPath = path.join(rootDir, "resumes.json");
  const before = readFileSync(registryPath, "utf8");
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const duplicateResponse = await fetch(`${app.url}/api/resumes/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "cpp", name: " ai agent " })
  });
  const unknownResponse = await fetch(`${app.url}/api/resumes/missing/activate`, { method: "POST" });
  const unsafeResponse = await fetch(`${app.url}/api/resumes/%2E%2E%2Fcpp`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Unsafe" })
  });

  assert.equal(duplicateResponse.status, 400);
  assert.equal(unknownResponse.status, 400);
  assert.equal(unsafeResponse.status, 400);
  assert.equal(readFileSync(registryPath, "utf8"), before);
  assert.equal(existsSync(path.join(rootDir, "resumes/ai-agent-2.yaml")), false);
});

test("DELETE /api/resumes/:id rejects deleting the final resume", async (t) => {
  const rootDir = makeMultiResumeFixture();
  writeFileSync(path.join(rootDir, "resumes.json"), `${JSON.stringify({
    activeId: "cpp",
    items: [{ id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" }]
  }, null, 2)}\n`);
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/resumes/cpp`, { method: "DELETE" });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error, /last resume/i);
  assert.equal(existsSync(path.join(rootDir, "resumes/cpp.yaml")), true);
});

test("resume save and draft preview are isolated by resumeId", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const aiBefore = readFileSync(resumeYamlPath(rootDir, "ai-agent"), "utf8");
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const updated = structuredClone(validResume);
  updated.profile.name = "Updated C++ Candidate";

  const saveResponse = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(updated)
  });
  const previewResponse = await fetch(`${app.url}/api/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp", resume: updated })
  });
  const previewBody = await previewResponse.json();

  assert.equal(saveResponse.status, 200);
  assert.equal(previewResponse.status, 200);
  assert.match(previewBody.html, /Updated C\+\+ Candidate/);
  assert.equal(loadResumeYaml(resumeYamlPath(rootDir, "cpp")).profile.name, "Updated C++ Candidate");
  assert.equal(readFileSync(resumeYamlPath(rootDir, "ai-agent"), "utf8"), aiBefore);
  assert.equal(existsSync(path.join(rootDir, "backups/ai-agent")), false);
});

test("resume generation passes resumeId and returns isolated output URLs", async (t) => {
  const rootDir = makeMultiResumeFixture();
  let receivedOptions;
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    generateResume: async (options) => {
      receivedOptions = options;
      return {
        resumeId: options.resumeId,
        density: "tight",
        metrics: { height: 1010 },
        outputPaths: {
          preview: path.join(rootDir, "output/ai-agent/preview.html"),
          pdf: path.join(rootDir, "output/ai-agent/resume.pdf"),
          png: path.join(rootDir, "output/ai-agent/resume.png")
        }
      };
    },
    log: false
  });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "ai-agent" })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(receivedOptions, {
    projectRoot: PROJECT_ROOT,
    dataRoot: rootDir,
    resumeId: "ai-agent"
  });
  assert.deepEqual(body.outputs, {
    pdf: "/output/ai-agent/resume.pdf",
    png: "/output/ai-agent/resume.png",
    html: "/output/ai-agent/preview.html"
  });
});

test("resume backup listing and restore are isolated by resumeId", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const cppBackup = structuredClone(validResume);
  cppBackup.profile.name = "Restored C++ Candidate";
  mkdirSync(path.join(rootDir, "backups/cpp"), { recursive: true });
  mkdirSync(path.join(rootDir, "backups/ai-agent"), { recursive: true });
  saveResumeYaml(path.join(rootDir, "backups/cpp/resume-20260710-142530.yaml"), cppBackup);
  saveResumeYaml(path.join(rootDir, "backups/ai-agent/resume-20260710-142531.yaml"), validResume);
  const aiBefore = readFileSync(resumeYamlPath(rootDir, "ai-agent"), "utf8");
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const listResponse = await fetch(`${app.url}/api/backups?resumeId=cpp`);
  const listBody = await listResponse.json();
  const restoreResponse = await fetch(`${app.url}/api/restore-backup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resumeId: "cpp",
      file: "backups/cpp/resume-20260710-142530.yaml"
    })
  });

  assert.equal(listResponse.status, 200);
  assert.deepEqual(listBody.backups.map((backup) => backup.file), [
    "backups/cpp/resume-20260710-142530.yaml"
  ]);
  assert.equal(restoreResponse.status, 200);
  assert.equal(loadResumeYaml(resumeYamlPath(rootDir, "cpp")).profile.name, "Restored C++ Candidate");
  assert.equal(readFileSync(resumeYamlPath(rootDir, "ai-agent"), "utf8"), aiBefore);
});

test("resume photo upload uses an id-scoped filename without changing other resumes", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const aiBefore = readFileSync(resumeYamlPath(rootDir, "ai-agent"), "utf8");
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/photo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      resumeId: "cpp",
      filename: "portrait.png",
      dataUrl: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`
    })
  });

  assert.equal(response.status, 200);
  assert.equal(loadResumeYaml(resumeYamlPath(rootDir, "cpp")).profile.photo, "assets/cpp-photo.png");
  assert.equal(readFileSync(resumeYamlPath(rootDir, "ai-agent"), "utf8"), aiBefore);
  assert.equal(existsSync(path.join(rootDir, "assets/cpp-photo.png")), true);
});

test("resume-scoped APIs reject unknown and path-like resume ids", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    generateResume: async () => {
      throw new Error("must not generate");
    },
    log: false
  });
  t.after(async () => app.close());

  const resumeResponse = await fetch(`${app.url}/api/resume?resumeId=${encodeURIComponent("../../x")}`);
  const generateResponse = await fetch(`${app.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "missing" })
  });

  assert.equal(resumeResponse.status, 400);
  assert.equal(generateResponse.status, 400);
});

test("resume-scoped APIs require an explicit resumeId", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  const resumeResponse = await fetch(`${app.url}/api/resume`);
  const previewResponse = await fetch(`${app.url}/api/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume: validResume })
  });
  const generateResponse = await fetch(`${app.url}/api/generate`, { method: "POST" });

  assert.equal(resumeResponse.status, 400);
  assert.equal(previewResponse.status, 400);
  assert.equal(generateResponse.status, 400);
});

test("editor shows the active resume selector in the preview toolbar", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await waitForResumeOption(page, "ai-agent");

  assert.equal(await selectedResumeId(page), "cpp");
  assert.equal(await page.getAttribute("#addResumeButton", "aria-label"), "新建简历");
  assert.equal(await page.getAttribute("#manageResumeButton", "aria-label"), "管理当前简历");
  assert.equal(await page.textContent("#currentFileLabel"), "resumes/cpp.yaml");
});

test("resume selector menu opens below the trigger when a later item is active", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  await fetch(`${app.url}/api/resumes/ai-agent/activate`, { method: "POST" });
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.click("#resumeSelectButton");

  const geometry = await page.evaluate(() => {
    const trigger = document.querySelector("#resumeSelectButton").getBoundingClientRect();
    const menu = document.querySelector("#resumeSelectMenu").getBoundingClientRect();
    return {
      triggerBottom: trigger.bottom,
      menuTop: menu.top,
      labels: Array.from(document.querySelectorAll("#resumeSelectMenu .resume-select-option-label"))
        .map((option) => option.textContent.trim()),
      selectedId: document.querySelector("#resumeSelectMenu [aria-selected='true']")?.dataset.resumeId
    };
  });

  assert.ok(geometry.menuTop >= geometry.triggerBottom);
  assert.deepEqual(geometry.labels, ["C++ 应届生", "AI Agent"]);
  assert.equal(geometry.selectedId, "ai-agent");
});

test("editor switches a clean resume and synchronizes form preview and backups", async (t) => {
  const rootDir = makeMultiResumeFixture();
  mkdirSync(path.join(rootDir, "output/cpp"), { recursive: true });
  mkdirSync(path.join(rootDir, "output/ai-agent"), { recursive: true });
  writeFileSync(path.join(rootDir, "output/cpp/preview.html"), renderResumeHtml(loadResumeYaml(resumeYamlPath(rootDir, "cpp")), {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  writeFileSync(path.join(rootDir, "output/ai-agent/preview.html"), renderResumeHtml(loadResumeYaml(resumeYamlPath(rootDir, "ai-agent")), {
    density: "normal",
    cssPath: "/templates/resume.css"
  }));
  mkdirSync(path.join(rootDir, "backups/ai-agent"), { recursive: true });
  saveResumeYaml(path.join(rootDir, "backups/ai-agent/resume-20260710-160000.yaml"), validResume);
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await selectResumeOption(page, "ai-agent");
  await page.waitForFunction(() => document.querySelector("[data-path='profile.name']")?.value === "AI Candidate");

  assert.match(await page.getAttribute("#previewFrame", "src"), /\/output\/ai-agent\/preview\.html/);
  assert.equal(await page.textContent("#currentFileLabel"), "resumes/ai-agent.yaml");
  assert.equal(await page.inputValue("#backupSelect"), "backups/ai-agent/resume-20260710-160000.yaml");
  await page.evaluate(() => {
    window.__openedResumePdf = "";
    window.open = (url) => {
      window.__openedResumePdf = url;
    };
  });
  await page.click("#openPdfButton");
  assert.equal(await page.evaluate(() => window.__openedResumePdf), "/output/ai-agent/resume.pdf");
});

test("dirty resume switching supports cancel and discard", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.fill("[data-path='profile.name']", "Unsaved Candidate");
  await selectResumeOption(page, "ai-agent");
  await page.waitForSelector("#resumeDialog[open]");
  assert.match(await page.textContent("#resumeDialogTitle"), /未保存/);

  await page.click("[data-dialog-action='cancel']");
  assert.equal(await selectedResumeId(page), "cpp");
  assert.equal(await page.inputValue("[data-path='profile.name']"), "Unsaved Candidate");

  await selectResumeOption(page, "ai-agent");
  await page.click("[data-dialog-action='discard-switch']");
  await page.waitForFunction(() => document.querySelector("[data-path='profile.name']")?.value === "AI Candidate");
  assert.equal(await selectedResumeId(page), "ai-agent");
});

test("editor duplicates renames and deletes resume variants from toolbar menus", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await waitForResumeOption(page, "ai-agent");
  await page.click("#addResumeButton");
  await page.click("[data-resume-action='duplicate']");
  await page.fill("#resumeDialogInput", "Backend Engineer");
  await page.click("[data-dialog-action='confirm-duplicate']");
  await waitForResumeOption(page, "backend-engineer");
  assert.equal(await selectedResumeId(page), "backend-engineer");

  await page.click("#manageResumeButton");
  await page.click("[data-resume-action='rename']");
  await page.fill("#resumeDialogInput", "AI Agent");
  await page.click("[data-dialog-action='confirm-rename']");
  assert.match(await page.textContent("#resumeDialogError"), /已有同名简历/);
  await page.fill("#resumeDialogInput", "Backend 校招");
  await page.click("[data-dialog-action='confirm-rename']");
  await page.waitForFunction(() => document.querySelector("#resumeSelectLabel")?.textContent === "Backend 校招");

  await page.click("#manageResumeButton");
  await page.click("[data-resume-action='delete']");
  await page.click("[data-dialog-action='confirm-delete-resume']");
  await page.waitForFunction(() => !document.querySelector("#resumeSelectMenu [data-resume-id='backend-engineer']"));
  assert.notEqual(await selectedResumeId(page), "backend-engineer");
});

test("resume toolbar stays inside the preview pane at wide and narrow viewports", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 900 }]) {
    const page = await openEditorPage(t, { viewport });
    await page.goto(app.url);
    await waitForResumeOption(page, "ai-agent");

    const layout = await page.locator(".preview-toolbar").evaluate((toolbar) => ({
      clientWidth: toolbar.clientWidth,
      scrollWidth: toolbar.scrollWidth,
      clientHeight: toolbar.clientHeight,
      scrollHeight: toolbar.scrollHeight,
      controls: Array.from(toolbar.querySelectorAll(
        ".resume-select-button, .toolbar-icon-button, .status-strip, .preview-actions button"
      )).map((element) => {
        const rect = element.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        return {
          left: rect.left - toolbarRect.left,
          right: rect.right - toolbarRect.left,
          top: rect.top - toolbarRect.top,
          bottom: rect.bottom - toolbarRect.top
        };
      })
    }));

    assert.ok(layout.scrollWidth <= layout.clientWidth);
    assert.ok(layout.scrollHeight <= layout.clientHeight);
    assert.ok(layout.controls.every((control) => control.left >= 0 && control.right <= layout.clientWidth + 1));
    assert.ok(layout.controls.every((control) => control.top >= 0 && control.bottom <= layout.clientHeight + 1));
  }
});

test("dirty resume switching saves before activating the target", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.fill("[data-path='profile.name']", "Saved Before Switch");
  await selectResumeOption(page, "ai-agent");
  await page.click("[data-dialog-action='save-switch']");
  await page.waitForFunction(() => document.querySelector("[data-path='profile.name']")?.value === "AI Candidate");

  assert.equal(loadResumeYaml(resumeYamlPath(rootDir, "cpp")).profile.name, "Saved Before Switch");
  assert.equal(JSON.parse(readFileSync(path.join(rootDir, "resumes.json"), "utf8")).activeId, "ai-agent");
});

test("failed save keeps the current resume active during switching", async (t) => {
  let activateCount = 0;
  const app = await startCustomEditorServer(async (request, response, url) => {
    if (request.method === "GET" && url.pathname === "/api/resumes") {
      sendTestJson(response, 200, {
        ok: true,
        activeId: "cpp",
        resumes: [
          { id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" },
          { id: "ai-agent", name: "AI Agent", file: "resumes/ai-agent.yaml" }
        ]
      });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/resume") {
      sendTestJson(response, 200, { ok: true, resumeId: "cpp", resume: validResume });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/examples") {
      sendTestJson(response, 200, { ok: true, examples: [] });
      return true;
    }
    if (request.method === "GET" && url.pathname === "/api/backups") {
      sendTestJson(response, 200, { ok: true, backups: [] });
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/preview") {
      const body = await readTestJsonBody(request);
      sendTestJson(response, 200, {
        ok: true,
        html: renderResumeHtml(body.resume, { density: "normal", cssPath: "/templates/resume.css" })
      });
      return true;
    }
    if (request.method === "PUT" && url.pathname === "/api/resume") {
      sendTestJson(response, 400, { ok: false, error: "Simulated save failure" });
      return true;
    }
    if (request.method === "POST" && url.pathname.endsWith("/activate")) {
      activateCount += 1;
      sendTestJson(response, 200, { ok: true });
      return true;
    }
    return false;
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.fill("[data-path='profile.name']", "Unsaved Candidate");
  await selectResumeOption(page, "ai-agent");
  await page.click("[data-dialog-action='save-switch']");
  await page.waitForFunction(() => document.querySelector("#messageLine")?.textContent?.includes("Simulated save failure"));

  assert.equal(await selectedResumeId(page), "cpp");
  assert.equal(await page.inputValue("[data-path='profile.name']"), "Unsaved Candidate");
  assert.equal(activateCount, 0);
});

test("editor creates a resume from an allowlisted example and shows a draft preview", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await waitForResumeOption(page, "ai-agent");
  await page.click("#addResumeButton");
  await page.click("[data-resume-action='from-example']");
  await page.selectOption("#resumeDialogExample", "ai-agent");
  await page.fill("#resumeDialogInput", "Agent Platform");
  await page.click("[data-dialog-action='confirm-example']");
  await page.waitForFunction(() => document.querySelector("[data-path='profile.target']")?.value === "AI Agent 应用开发工程师");
  await page.waitForFunction(() => document.querySelector("#previewFrame")?.getAttribute("srcdoc")?.includes("AI Agent 应用开发工程师"));

  assert.equal(await selectedResumeId(page), "agent-platform");
  assert.match(await page.textContent("#statusStrip"), /PDF 待生成|草稿预览/);
});

test("editor validates resume names and disables deletion of the final resume", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await waitForResumeOption(page, "cpp");
  await page.click("#manageResumeButton");
  assert.equal(await page.getAttribute("[data-resume-action='delete']", "aria-disabled"), "true");
  assert.equal(await page.locator("#deleteResumeHint").isVisible(), true);
  await page.click("[data-resume-action='rename']");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.id === "manageResumeButton");
  await page.click("#manageResumeButton");
  await page.click("[data-resume-action='rename']");
  await page.fill("#resumeDialogInput", "   ");
  await page.click("[data-dialog-action='confirm-rename']");

  assert.equal(await page.locator("#resumeDialog").getAttribute("open"), "");
  assert.match(await page.textContent("#resumeDialogError"), /请输入简历名称/);
});

test("creating a resume does not discard an unresolved dirty draft", async (t) => {
  const rootDir = makeMultiResumeFixture();
  const registryBefore = readFileSync(path.join(rootDir, "resumes.json"), "utf8");
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);

  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.fill("[data-path='profile.name']", "Unresolved Draft");
  await page.click("#addResumeButton");
  await page.click("[data-resume-action='from-example']");
  await page.waitForSelector("#resumeDialog[open]");

  assert.match(await page.textContent("#resumeDialogTitle"), /未保存/);
  await page.click("[data-dialog-action='cancel']");
  assert.equal(await page.inputValue("[data-path='profile.name']"), "Unresolved Draft");
  assert.equal(await selectedResumeId(page), "cpp");
  assert.equal(readFileSync(path.join(rootDir, "resumes.json"), "utf8"), registryBefore);
});

test("GET /api/data/export downloads a valid resume data package", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    appVersion: "0.1.0-test",
    log: false
  });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/data/export`);
  const archive = new Uint8Array(await response.arrayBuffer());
  const files = unzipSync(archive);
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition"), /attachment; filename="resume-builder-backup-\d{8}-\d{6}\.zip"/);
  assert.equal(manifest.appVersion, "0.1.0-test");
  assert.equal(manifest.resumeCount, 1);
  assert.ok(files["resumes/cpp.yaml"]);
});

test("data import APIs inspect commit and cancel raw ZIP packages", async (t) => {
  const sourceRoot = makeMultiResumeFixture();
  const targetRoot = makeApiFixture();
  writeFileSync(path.join(targetRoot, "assets/photo.svg"), "<svg>old-target</svg>");
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir: targetRoot,
    log: false
  });
  t.after(async () => app.close());

  const firstInspect = await fetch(`${app.url}/api/data/import/inspect`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: Buffer.from(archive)
  });
  const firstBody = await firstInspect.json();
  assert.equal(firstInspect.status, 200);
  assert.equal(firstBody.ok, true);
  assert.equal(firstBody.summary.resumeCount, 2);

  const cancelResponse = await fetch(`${app.url}/api/data/import/${firstBody.token}`, {
    method: "DELETE"
  });
  assert.equal(cancelResponse.status, 200);

  const secondInspect = await fetch(`${app.url}/api/data/import/inspect`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: Buffer.from(archive)
  });
  const secondBody = await secondInspect.json();
  const commitResponse = await fetch(`${app.url}/api/data/import/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: secondBody.token })
  });
  const commitBody = await commitResponse.json();

  assert.equal(commitResponse.status, 200);
  assert.equal(commitBody.ok, true);
  assert.equal(commitBody.activeId, "cpp");
  assert.deepEqual(commitBody.resumes.map((resume) => resume.id), ["cpp", "ai-agent"]);
  assert.match(commitBody.preImportBackup, /^resume-editor-test-.*\.pre-import-\d{8}-\d{6}$/);
  assert.equal(existsSync(path.join(targetRoot, "output")), false);
  assert.equal(
    readFileSync(path.join(path.dirname(targetRoot), commitBody.preImportBackup, "assets/photo.svg"), "utf8"),
    "<svg>old-target</svg>"
  );
});

test("POST /api/data/import/inspect rejects oversized raw archives", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    dataArchiveLimitBytes: 8,
    log: false
  });
  t.after(async () => app.close());

  const response = await fetch(`${app.url}/api/data/import/inspect`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: Buffer.from("0123456789")
  });
  const body = await response.json();

  assert.equal(response.status, 413);
  assert.equal(body.ok, false);
  assert.match(body.error, /archive.*too large/i);
});

test("data recovery APIs list snapshots and restore a selected snapshot", async (t) => {
  const { dataRoot, validSnapshotRoot } = makeRecoveryApiFixture(t);
  const sourceBefore = readFileSync(path.join(validSnapshotRoot, "assets/photo.svg"));
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir: dataRoot,
    log: false
  });
  t.after(async () => app.close());

  const listResponse = await fetch(`${app.url}/api/data/recovery/snapshots`);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  const serializedList = JSON.stringify(listBody);
  const validSnapshot = listBody.snapshots.find((snapshot) => snapshot.valid);
  const invalidSnapshot = listBody.snapshots.find((snapshot) => !snapshot.valid);

  assert.equal(listBody.ok, true);
  assert.equal(listBody.snapshots.length, 2);
  assert.equal(validSnapshot.type, "pre-import");
  assert.equal(validSnapshot.resumeCount, 1);
  assert.equal(invalidSnapshot.type, "pre-restore");
  assert.equal(invalidSnapshot.code, "invalid-data");
  assert.equal(serializedList.includes(dataRoot), false);
  assert.equal(serializedList.includes(path.dirname(dataRoot)), false);

  const restoreResponse = await fetch(`${app.url}/api/data/recovery/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: validSnapshot.id })
  });
  const restoreBody = await restoreResponse.json();
  const serializedRestore = JSON.stringify(restoreBody);

  assert.equal(restoreResponse.status, 200);
  assert.deepEqual(restoreBody, {
    ok: true,
    activeId: "cpp",
    resumes: [{ id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" }],
    preRestoreBackup: restoreBody.preRestoreBackup,
    generation: "needs generate"
  });
  assert.match(
    restoreBody.preRestoreBackup,
    /^resume-data\.pre-restore-\d{8}-\d{6}(?:-\d+)?$/
  );
  assert.equal(serializedRestore.includes(dataRoot), false);
  assert.equal(serializedRestore.includes(path.dirname(dataRoot)), false);
  assert.equal(
    readFileSync(path.join(dataRoot, "assets/photo.svg"), "utf8"),
    "<svg>snapshot-active</svg>"
  );
  assert.equal(existsSync(validSnapshotRoot), true);
  assert.deepEqual(readFileSync(path.join(validSnapshotRoot, "assets/photo.svg")), sourceBefore);
});

test("data recovery APIs map request, method, and manager errors safely", async (t) => {
  const { dataRoot } = makeRecoveryApiFixture(t);
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir: dataRoot,
    log: false
  });
  t.after(async () => app.close());

  const listResponse = await fetch(`${app.url}/api/data/recovery/snapshots`);
  assert.equal(listResponse.status, 200);
  const listed = await listResponse.json();
  const invalidSnapshot = listed.snapshots.find((snapshot) => !snapshot.valid);
  const cases = [
    {
      name: "malformed body",
      request: () => fetch(`${app.url}/api/data/recovery/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      }),
      status: 400
    },
    {
      name: "missing snapshot id",
      request: () => fetch(`${app.url}/api/data/recovery/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      status: 400,
      code: "invalid-snapshot-id"
    },
    {
      name: "null body",
      request: () => fetch(`${app.url}/api/data/recovery/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null"
      }),
      status: 400,
      code: "invalid-snapshot-id"
    },
    {
      name: "unknown snapshot id",
      request: () => fetch(`${app.url}/api/data/recovery/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: "0".repeat(64) })
      }),
      status: 404,
      code: "snapshot-not-found"
    },
    {
      name: "invalid snapshot",
      request: () => fetch(`${app.url}/api/data/recovery/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: invalidSnapshot.id })
      }),
      status: 409,
      code: "snapshot-invalid"
    },
    {
      name: "snapshot list method mismatch",
      request: () => fetch(`${app.url}/api/data/recovery/snapshots`, { method: "POST" }),
      status: 405
    },
    {
      name: "restore method mismatch",
      request: () => fetch(`${app.url}/api/data/recovery/restore`),
      status: 405
    }
  ];

  for (const scenario of cases) {
    const response = await scenario.request();
    const body = await response.json();
    assert.equal(response.status, scenario.status, scenario.name);
    assert.equal(body.ok, false, scenario.name);
    if (scenario.code) {
      assert.equal(body.code, scenario.code, scenario.name);
    }
    assert.equal(JSON.stringify(body).includes(dataRoot), false, scenario.name);
  }

  const allowlistedLeak = path.join(dataRoot, "private", "allowlisted-snapshot");
  const staleError = new Error(`Snapshot changed at ${allowlistedLeak}`);
  staleError.statusCode = 409;
  staleError.code = "restore-source-changed";
  const staleApp = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir: makeApiFixture(),
    dataRecoveryManager: stubRecoveryManager({
      restore() {
        throw staleError;
      }
    }),
    log: false
  });
  t.after(async () => staleApp.close());
  const staleResponse = await fetch(`${staleApp.url}/api/data/recovery/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "a".repeat(64) })
  });
  assert.equal(staleResponse.status, 409);
  assert.deepEqual(await staleResponse.json(), {
    ok: false,
    error: "The selected snapshot changed during restore.",
    code: staleError.code
  });

  const currentAndRetiredCodes = [
    {
      code: "restore-staging-reservation-failed",
      statusCode: 500,
      expected: {
        ok: false,
        error: "A restore staging location could not be reserved.",
        code: "restore-staging-reservation-failed"
      }
    },
    {
      code: "restore-cleanup-failed",
      statusCode: 500,
      expected: {
        ok: false,
        error: "Data recovery failed.",
        code: "recovery-failed"
      }
    },
    {
      code: "restore-lock-acquire-failed",
      statusCode: 500,
      expected: {
        ok: false,
        error: "Data recovery failed.",
        code: "recovery-failed"
      }
    }
  ];
  for (const scenario of currentAndRetiredCodes) {
    const codedError = new Error(`Private detail at ${dataRoot}`);
    codedError.statusCode = scenario.statusCode;
    codedError.code = scenario.code;
    const codedApp = await startEditorServer({
      preferredPort: 0,
      maxPort: 0,
      rootDir: makeApiFixture(),
      dataRecoveryManager: stubRecoveryManager({
        restore() {
          throw codedError;
        }
      }),
      log: false
    });
    t.after(async () => codedApp.close());
    const codedResponse = await fetch(`${codedApp.url}/api/data/recovery/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: "b".repeat(64) })
    });
    assert.equal(codedResponse.status, scenario.statusCode, scenario.code);
    assert.deepEqual(await codedResponse.json(), scenario.expected, scenario.code);
  }

  const leakedPath = path.join(dataRoot, "private", "snapshot");
  const unexpectedManager = stubRecoveryManager({
    list() {
      const error = new Error(`Known code with wrong status: ${leakedPath}`);
      error.statusCode = 500;
      error.code = "snapshot-not-found";
      throw error;
    },
    restore() {
      const error = new Error(`Internal failure at ${leakedPath}`);
      error.statusCode = 500;
      error.code = "internal-failure";
      throw error;
    }
  });
  const unexpectedApp = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir: makeApiFixture(),
    dataRecoveryManager: unexpectedManager,
    log: false
  });
  t.after(async () => unexpectedApp.close());

  const unexpectedList = await fetch(`${unexpectedApp.url}/api/data/recovery/snapshots`);
  const unexpectedRestore = await fetch(`${unexpectedApp.url}/api/data/recovery/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "b".repeat(64) })
  });
  for (const response of [unexpectedList, unexpectedRestore]) {
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.deepEqual(body, {
      ok: false,
      error: "Data recovery failed.",
      code: "recovery-failed"
    });
    assert.equal(JSON.stringify(body).includes(leakedPath), false);
  }
});

test("recovery method semantics precede an active replacement gate", async (t) => {
  const rootDir = makeApiFixture();
  let replacementChecks = 0;
  let listCalls = 0;
  let restoreCalls = 0;
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    dataImportManager: stubImportManager({
      isCommitting() {
        replacementChecks += 1;
        return true;
      }
    }),
    dataRecoveryManager: stubRecoveryManager({
      list() {
        listCalls += 1;
        return [];
      },
      restore() {
        restoreCalls += 1;
        return replacementResult("restore");
      }
    }),
    log: false
  });
  t.after(async () => app.close());

  const restoreResponse = await fetch(`${app.url}/api/data/recovery/restore`);
  const snapshotsResponse = await fetch(`${app.url}/api/data/recovery/snapshots`, {
    method: "POST"
  });
  const importResponse = await fetch(`${app.url}/api/data/import/commit`);

  assert.equal(restoreResponse.status, 405);
  assert.equal(snapshotsResponse.status, 405);
  assert.equal(importResponse.status, 405);
  assert.equal(replacementChecks, 0);
  assert.equal(listCalls, 0);
  assert.equal(restoreCalls, 0);
});

test("data recovery manager injection disposes both managers exactly once", async () => {
  const rootDir = makeApiFixture();
  let importDisposeCalls = 0;
  let recoveryDisposeCalls = 0;
  const server = createEditorServer({
    rootDir,
    dataImportManager: stubImportManager({
      dispose() {
        importDisposeCalls += 1;
      }
    }),
    dataRecoveryManager: stubRecoveryManager({
      dispose() {
        recoveryDisposeCalls += 1;
      }
    })
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/data/recovery/snapshots`
  );
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  assert.equal(response.status, 200);
  assert.equal(importDisposeCalls, 1);
  assert.equal(recoveryDisposeCalls, 1);
});

test("replacement gate rejects recovery restore while generation is writing", async (t) => {
  const rootDir = makeApiFixture();
  const generationStarted = deferred();
  const releaseGeneration = deferred();
  let restoreCalls = 0;
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    generateResume: async () => {
      generationStarted.resolve();
      await releaseGeneration.promise;
      return { density: "normal", metrics: { height: 900 } };
    },
    dataRecoveryManager: stubRecoveryManager({
      restore() {
        restoreCalls += 1;
        return replacementResult("restore");
      }
    }),
    log: false
  });
  t.after(async () => app.close());

  const generationRequest = fetch(`${app.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp" })
  });
  await generationStarted.promise;
  const blockedRestore = await fetch(`${app.url}/api/data/recovery/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "a".repeat(64) })
  });
  releaseGeneration.resolve();
  const generationResponse = await generationRequest;
  const blockedBody = blockedRestore.headers.get("content-type")?.includes("application/json")
    ? await blockedRestore.json()
    : { error: await blockedRestore.text() };

  assert.equal(blockedRestore.status, 423);
  assert.match(blockedBody.error, /replacement|write/i);
  assert.equal(restoreCalls, 0);
  assert.equal(generationResponse.status, 200);

  const retriedRestore = await fetch(`${app.url}/api/data/recovery/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId: "a".repeat(64) })
  });
  assert.equal(retriedRestore.status, 200);
  assert.equal(restoreCalls, 1);
});

test("replacement gate waits for complete import and recovery bodies", async (t) => {
  for (const replacementType of ["import", "restore"]) {
    await t.test(replacementType, async (t) => {
      const rootDir = makeApiFixture();
      const generationStarted = deferred();
      const releaseGeneration = deferred();
      let replacementCalls = 0;
      const app = await startEditorServer({
        preferredPort: 0,
        maxPort: 0,
        rootDir,
        generateResume: async () => {
          generationStarted.resolve();
          await releaseGeneration.promise;
          return { density: "normal", metrics: { height: 900 } };
        },
        dataImportManager: stubImportManager({
          commit() {
            replacementCalls += 1;
            return replacementResult("import");
          }
        }),
        dataRecoveryManager: stubRecoveryManager({
          restore() {
            replacementCalls += 1;
            return replacementResult("restore");
          }
        }),
        log: false
      });
      t.after(async () => app.close());
      const requestPath = replacementType === "import"
        ? "/api/data/import/commit"
        : "/api/data/recovery/restore";
      const fullBody = JSON.stringify(
        replacementType === "import"
          ? { token: "token" }
          : { snapshotId: "a".repeat(64) }
      );
      const requestStarted = once(app.server, "request");
      const replacementRequest = http.request(`${app.url}${requestPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(fullBody)
        }
      });
      replacementRequest.on("error", () => {});
      const replacementResponse = new Promise((resolve) => {
        replacementRequest.once("response", resolve);
      });
      replacementRequest.write("{");
      await requestStarted;
      await new Promise((resolve) => setImmediate(resolve));

      const generationRequest = fetch(`${app.url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resumeId: "cpp" })
      });
      let blockedReplacement;
      try {
        await waitForManagerStart(generationStarted.promise, generationRequest);
        replacementRequest.end(fullBody.slice(1));
        blockedReplacement = await replacementResponse;
        blockedReplacement.resume();
        await once(blockedReplacement, "end");
      } finally {
        releaseGeneration.resolve();
        replacementRequest.destroy();
      }
      const generationResponse = await generationRequest;

      assert.equal(blockedReplacement.statusCode, 423);
      assert.equal(generationResponse.status, 200);
      assert.equal(replacementCalls, 0);
    });
  }
});

test("replacement gate prevents import commit and recovery restore from overlapping", async (t) => {
  for (const activeType of ["import", "restore"]) {
    await t.test(`${activeType} blocks the other replacement`, async (t) => {
      const rootDir = makeApiFixture();
      const started = deferred();
      const release = deferred();
      const controlledOperation = async () => {
        started.resolve();
        await release.promise;
        return replacementResult(activeType);
      };
      const dataImportManager = stubImportManager(
        activeType === "import" ? { commit: controlledOperation } : {}
      );
      const dataRecoveryManager = stubRecoveryManager(
        activeType === "restore" ? { restore: controlledOperation } : {}
      );
      const app = await startEditorServer({
        preferredPort: 0,
        maxPort: 0,
        rootDir,
        dataImportManager,
        dataRecoveryManager,
        log: false
      });
      t.after(async () => app.close());
      const activeUrl = activeType === "import"
        ? "/api/data/import/commit"
        : "/api/data/recovery/restore";
      const blockedUrl = activeType === "import"
        ? "/api/data/recovery/restore"
        : "/api/data/import/commit";
      const activeRequest = fetch(`${app.url}${activeUrl}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          activeType === "import" ? { token: "token" } : { snapshotId: "a".repeat(64) }
        )
      });

      let blockedResponse;
      try {
        await waitForManagerStart(started.promise, activeRequest);
        blockedResponse = await fetch(`${app.url}${blockedUrl}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            activeType === "import" ? { snapshotId: "b".repeat(64) } : { token: "token" }
          )
        });
      } finally {
        release.resolve();
      }
      const activeResponse = await activeRequest;

      assert.equal(blockedResponse.status, 423);
      assert.equal(activeResponse.status, 200);
    });
  }
});

test("replacement gate blocks writes and export but allows preview and reads", async (t) => {
  for (const activeType of ["import", "restore"]) {
    await t.test(`route behavior during ${activeType}`, async (t) => {
      const rootDir = makeApiFixture();
      const started = deferred();
      const release = deferred();
      const controlledOperation = async () => {
        started.resolve();
        await release.promise;
        return replacementResult(activeType);
      };
      const app = await startEditorServer({
        preferredPort: 0,
        maxPort: 0,
        rootDir,
        dataImportManager: stubImportManager(
          activeType === "import" ? { commit: controlledOperation } : {}
        ),
        dataRecoveryManager: stubRecoveryManager(
          activeType === "restore" ? { restore: controlledOperation } : {}
        ),
        log: false
      });
      t.after(async () => app.close());
      const activeUrl = activeType === "import"
        ? "/api/data/import/commit"
        : "/api/data/recovery/restore";
      const activeRequest = fetch(`${app.url}${activeUrl}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          activeType === "import" ? { token: "token" } : { snapshotId: "a".repeat(64) }
        )
      });

      let responses;
      try {
        await waitForManagerStart(started.promise, activeRequest);
        responses = await Promise.all([
          fetch(`${app.url}/api/resume?resumeId=cpp`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(validResume)
          }),
          fetch(`${app.url}/api/data/export`),
          fetch(`${app.url}/api/preview`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ resumeId: "cpp", resume: validResume })
          }),
          fetch(`${app.url}/api/resumes`),
          fetch(`${app.url}/api/data/recovery/snapshots`)
        ]);
      } finally {
        release.resolve();
      }
      const activeResponse = await activeRequest;

      assert.deepEqual(responses.map((response) => response.status), [423, 423, 200, 200, 200]);
      assert.equal(activeResponse.status, 200);
    });
  }
});

test("replacement gate releases failed and malformed import or recovery requests", async (t) => {
  const scenarios = [
    { type: "import", mode: "malformed", status: 400 },
    { type: "restore", mode: "malformed", status: 400 },
    { type: "import", mode: "failed", status: 409 },
    { type: "restore", mode: "failed", status: 409 }
  ];

  for (const scenario of scenarios) {
    await t.test(`${scenario.mode} ${scenario.type}`, async (t) => {
      const failure = new Error("Replacement request failed.");
      failure.statusCode = 409;
      failure.code = scenario.type === "restore" ? "snapshot-invalid" : "import-invalid";
      const rootDir = makeApiFixture();
      const app = await startEditorServer({
        preferredPort: 0,
        maxPort: 0,
        rootDir,
        dataImportManager: stubImportManager(
          scenario.type === "import" && scenario.mode === "failed"
            ? { commit() { throw failure; } }
            : {}
        ),
        dataRecoveryManager: stubRecoveryManager(
          scenario.type === "restore" && scenario.mode === "failed"
            ? { restore() { throw failure; } }
            : {}
        ),
        log: false
      });
      t.after(async () => app.close());
      const requestUrl = scenario.type === "import"
        ? "/api/data/import/commit"
        : "/api/data/recovery/restore";
      const replacementResponse = await fetch(`${app.url}${requestUrl}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: scenario.mode === "malformed"
          ? "{"
          : JSON.stringify(
            scenario.type === "import" ? { token: "token" } : { snapshotId: "a".repeat(64) }
          )
      });
      const mutationResponse = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validResume)
      });

      assert.equal(replacementResponse.status, scenario.status);
      assert.equal(mutationResponse.status, 200);
    });
  }
});

test("replacement gate stays locked after a replacement client disconnects", async (t) => {
  for (const activeType of ["import", "restore"]) {
    await t.test(`${activeType} disconnect`, async (t) => {
      const rootDir = makeApiFixture();
      const started = deferred();
      const release = deferred();
      const completed = deferred();
      const controlledOperation = async () => {
        started.resolve();
        await release.promise;
        completed.resolve();
        return replacementResult(activeType);
      };
      const app = await startEditorServer({
        preferredPort: 0,
        maxPort: 0,
        rootDir,
        dataImportManager: stubImportManager(
          activeType === "import" ? { commit: controlledOperation } : {}
        ),
        dataRecoveryManager: stubRecoveryManager(
          activeType === "restore" ? { restore: controlledOperation } : {}
        ),
        log: false
      });
      t.after(async () => app.close());
      const activeUrl = activeType === "import"
        ? "/api/data/import/commit"
        : "/api/data/recovery/restore";
      const request = http.request(`${app.url}${activeUrl}`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      request.on("error", () => {});
      const requestClosed = new Promise((resolve) => request.once("close", resolve));
      const responseBeforeStart = new Promise((resolve) => {
        request.once("response", (response) => {
          response.resume();
          resolve(response.statusCode);
        });
      });
      request.end(JSON.stringify(
        activeType === "import" ? { token: "token" } : { snapshotId: "a".repeat(64) }
      ));

      let blockedResponse;
      try {
        await Promise.race([
          started.promise,
          responseBeforeStart.then((statusCode) => {
            throw new Error(`Request completed before its manager started (${statusCode}).`);
          })
        ]);
        request.destroy();
        await requestClosed;
        await new Promise((resolve) => setImmediate(resolve));
        blockedResponse = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(validResume)
        });
      } finally {
        release.resolve();
      }
      await completed.promise;
      await new Promise((resolve) => setImmediate(resolve));
      const retriedResponse = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validResume)
      });

      assert.equal(blockedResponse.status, 423);
      assert.equal(retriedResponse.status, 200);
    });
  }
});

test("editor server blocks mutations during an import commit and disposes its manager", async (t) => {
  const rootDir = makeApiFixture();
  let disposed = false;
  const dataImportManager = {
    inspect() {
      throw new Error("not used");
    },
    commit() {
      throw new Error("not used");
    },
    cancel() {
      return false;
    },
    isCommitting() {
      return true;
    },
    dispose() {
      disposed = true;
    }
  };
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    dataImportManager,
    log: false
  });

  const blocked = await fetch(`${app.url}/api/resume?resumeId=cpp`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validResume)
  });
  const blockedBody = await blocked.json();
  const readable = await fetch(`${app.url}/api/resumes`);

  assert.equal(blocked.status, 423);
  assert.match(blockedBody.error, /data replacement.*in progress/i);
  assert.equal(readable.status, 200);
  await app.close();
  assert.equal(disposed, true);
  t.after(async () => {
    if (app.server.listening) {
      await app.close();
    }
  });
});

test("data import commit rejects while an earlier generation is still writing", async (t) => {
  const sourceRoot = makeMultiResumeFixture();
  const targetRoot = makeApiFixture();
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  let markGenerationStarted;
  let releaseGeneration;
  const generationStarted = new Promise((resolve) => {
    markGenerationStarted = resolve;
  });
  const generationBlocked = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir: targetRoot,
    generateResume: async () => {
      markGenerationStarted();
      await generationBlocked;
      return { density: "normal", metrics: { height: 900 } };
    },
    log: false
  });
  t.after(async () => app.close());

  const inspectResponse = await fetch(`${app.url}/api/data/import/inspect`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: Buffer.from(archive)
  });
  const inspected = await inspectResponse.json();
  const generationRequest = fetch(`${app.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ resumeId: "cpp" })
  });
  await generationStarted;

  const blockedCommit = await fetch(`${app.url}/api/data/import/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: inspected.token })
  });
  const blockedBody = await blockedCommit.json();
  releaseGeneration();
  const generationResponse = await generationRequest;

  assert.equal(blockedCommit.status, 423);
  assert.match(blockedBody.error, /write.*in progress/i);
  assert.equal(generationResponse.status, 200);

  const retriedCommit = await fetch(`${app.url}/api/data/import/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: inspected.token })
  });
  assert.equal(retriedCommit.status, 200);
});

test("data import commit stays blocked after a generating client disconnects", async (t) => {
  const sourceRoot = makeMultiResumeFixture();
  const targetRoot = makeApiFixture();
  const archive = createDataPackage({ dataRoot: sourceRoot, appVersion: "0.1.0" });
  let markGenerationStarted;
  let releaseGeneration;
  const generationStarted = new Promise((resolve) => {
    markGenerationStarted = resolve;
  });
  const generationBlocked = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir: targetRoot,
    generateResume: async () => {
      markGenerationStarted();
      await generationBlocked;
      return { density: "normal", metrics: { height: 900 } };
    },
    log: false
  });
  t.after(async () => app.close());

  const inspectResponse = await fetch(`${app.url}/api/data/import/inspect`, {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: Buffer.from(archive)
  });
  const inspected = await inspectResponse.json();
  const generationRequest = http.request(`${app.url}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" }
  });
  generationRequest.on("error", () => {});
  const generationConnectionClosed = new Promise((resolve) => {
    generationRequest.once("close", resolve);
  });
  generationRequest.end(JSON.stringify({ resumeId: "cpp" }));
  await generationStarted;
  generationRequest.destroy();
  await generationConnectionClosed;
  await new Promise((resolve) => setImmediate(resolve));

  const blockedCommit = await fetch(`${app.url}/api/data/import/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: inspected.token })
  });
  const blockedBody = await blockedCommit.json();
  releaseGeneration();

  assert.equal(blockedCommit.status, 423);
  assert.match(blockedBody.error, /write.*in progress/i);

  const retriedCommit = await fetch(`${app.url}/api/data/import/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: inspected.token })
  });
  assert.equal(retriedCommit.status, 200);
});

test("editor data management menu exports an unencrypted package without changing the resume", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t, { acceptDownloads: true });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");

  assert.equal(await page.locator(".preview-toolbar #dataManagerButton").count(), 1);
  assert.equal(await page.locator(".editor-pane #dataManagerButton").count(), 0);
  await page.click("#dataManagerButton");
  assert.deepEqual(await page.locator("#dataManagerMenu button").allTextContents(), [
    "导出数据包",
    "导入数据包",
    "恢复历史数据"
  ]);
  await page.click("#exportDataButton");
  assert.match(await page.textContent("#dataDialog"), /包含个人信息/);
  assert.match(await page.textContent("#dataDialog"), /未加密/);

  const downloadPromise = page.waitForEvent("download");
  await page.click("#dataDialogPrimary");
  const download = await downloadPromise;

  assert.match(download.suggestedFilename(), /^resume-builder-backup-\d{8}-\d{6}\.zip$/);
  assert.equal(await page.getAttribute("#resumeSelectButton", "data-value"), "cpp");
  assert.equal(await page.locator("[data-path='profile.name']").inputValue(), "测试候选人");
});

test("editor blocks data import while the current resume has unsaved changes", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.fill("[data-path='profile.name']", "未保存姓名");

  await page.click("#dataManagerButton");
  await page.click("#importDataButton");

  assert.match(await page.textContent("#messageLine"), /先保存或撤销/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "saveButton");
  assert.equal(await page.locator("#dataDialog").evaluate((dialog) => dialog.open), false);
});

test("editor inspects and commits an imported package then reloads the draft preview", async (t) => {
  const sourceRoot = makeMultiResumeFixture();
  const targetRoot = makeApiFixture();
  const archive = createDataPackage({
    dataRoot: sourceRoot,
    appVersion: "0.1.0",
    now: () => new Date("2026-07-10T15:30:00.000Z")
  });
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir: targetRoot,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");

  await page.click("#dataManagerButton");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#importDataButton");
  const chooser = await chooserPromise;
  const inspectResponse = page.waitForResponse((response) => response.url().endsWith("/api/data/import/inspect"));
  await chooser.setFiles({
    name: "resume-builder-backup.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive)
  });
  await inspectResponse;

  assert.match(await page.textContent("#dataDialog"), /2026-07-10/);
  assert.match(await page.textContent("#dataDialog"), /2 份简历/);
  assert.match(await page.textContent("#dataDialog"), /C\+\+ 应届生/);
  assert.match(await page.textContent("#dataDialog"), /AI Agent/);

  const commitResponse = page.waitForResponse((response) => response.url().endsWith("/api/data/import/commit"));
  await page.click("#dataDialogPrimary");
  await commitResponse;
  await page.waitForFunction(() => document.querySelector("#resumeSelectButton")?.dataset.value === "cpp");
  await page.waitForSelector("[data-path='profile.name']");

  assert.equal(await page.locator("#dataDialog").evaluate((dialog) => dialog.open), false);
  assert.equal(await page.getAttribute("#resumeSelectButton", "data-value"), "cpp");
  assert.equal(await page.locator("#resumeSelectMenu [data-resume-id='ai-agent']").count(), 1);
  assert.match(await page.textContent("#statusStrip"), /PDF 待生成/);
  assert.match(await page.textContent("#messageLine"), /导入完成/);
});

test("editor recovery center menu and historical data dirty protection", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  let snapshotRequests = 0;
  await page.route("**/api/data/recovery/snapshots", async (route) => {
    snapshotRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, snapshots: [] })
    });
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");

  await page.click("#dataManagerButton");
  assert.deepEqual(await page.locator("#dataManagerMenu button").allTextContents(), [
    "导出数据包",
    "导入数据包",
    "恢复历史数据"
  ]);
  await page.fill("[data-path='profile.name']", "未保存姓名");
  await page.click("#recoverDataButton");

  assert.equal(snapshotRequests, 0);
  assert.equal(await page.locator("#dataManagerMenu").isHidden(), true);
  assert.equal(await page.locator("#dataDialog").evaluate((dialog) => dialog.open), false);
  assert.match(await page.textContent("#messageLine"), /恢复前请先保存或撤销当前修改/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "saveButton");
});

test("editor recovery center shows loading, load errors, retry, and empty historical data", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  const privateLookingPath = ["", "Users", "example", "private"].join("/");
  let snapshotRequests = 0;
  let releaseFirstRequest;
  const firstRequestBlocked = new Promise((resolve) => {
    releaseFirstRequest = resolve;
  });
  await page.route("**/api/data/recovery/snapshots", async (route) => {
    snapshotRequests += 1;
    if (snapshotRequests === 1) {
      await firstRequestBlocked;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: `private failure at ${privateLookingPath}/data` })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, snapshots: [] })
    });
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");

  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  assert.equal(await page.textContent("#dataDialogTitle"), "恢复历史数据");
  assert.match(await page.textContent("#dataDialogBody"), /正在读取恢复历史/);
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), true);
  assert.equal(await page.locator("#dataDialogCancel").isDisabled(), false);
  assert.equal(await page.locator("#dataDialogClose").isDisabled(), false);

  releaseFirstRequest();
  await page.waitForFunction(() => document.querySelector("#dataDialogPrimary")?.textContent === "重试");
  const failedDialogText = await page.textContent("#dataDialog");
  assert.match(failedDialogText, /读取恢复历史失败/);
  assert.equal(failedDialogText.includes(privateLookingPath), false);
  assert.doesNotMatch(failedDialogText, /private failure/);
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), false);

  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => document.querySelector("#dataDialogBody")?.textContent?.includes("暂无可恢复的历史数据"));
  assert.equal(snapshotRequests, 2);
  assert.equal(await page.locator("#dataDialogPrimary").isHidden(), true);
  assert.equal(await page.locator("#dataDialogCancel").isDisabled(), false);
  await page.click("#dataDialogCancel");
  assert.equal(await page.locator("#dataDialog").evaluate((dialog) => dialog.open), false);
});

test("editor recovery center ignores a stale historical data list response after reopen", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  const firstResponse = deferred();
  const secondResponse = deferred();
  const secondDelivery = deferred();
  let snapshotRequests = 0;
  const snapshot = (id, name) => ({
    id,
    type: "pre-restore",
    createdAt: "2026-07-11T08:09:10+08:00",
    valid: true,
    resumeCount: 1,
    activeResumeId: id,
    activeResumeName: name,
    resumes: [{ id, name }]
  });
  await page.route("**/api/data/recovery/snapshots", async (route) => {
    const requestNumber = snapshotRequests + 1;
    snapshotRequests = requestNumber;
    const payload = await (requestNumber === 1 ? firstResponse.promise : secondResponse.promise);
    if (requestNumber === 2) {
      await secondDelivery.promise;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload)
    });
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");

  const firstRequest = page.waitForRequest((request) => request.url().endsWith("/api/data/recovery/snapshots"));
  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  const firstRequestObject = await firstRequest;
  await page.click("#dataDialogClose");

  const secondRequest = page.waitForRequest((request) => request.url().endsWith("/api/data/recovery/snapshots"));
  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await secondRequest;
  secondResponse.resolve({ ok: true, snapshots: [snapshot("new-snapshot", "新的恢复数据")] });
  const firstCompleted = page.waitForResponse((response) => response.request() === firstRequestObject);
  firstResponse.resolve({ ok: true, snapshots: [snapshot("old-snapshot", "旧的恢复数据")] });
  await firstCompleted;
  secondDelivery.resolve();
  await page.waitForFunction(() => document.querySelector("#dataDialogBody")?.textContent?.includes("新的恢复数据"));
  await page.waitForTimeout(100);
  const dialogText = await page.textContent("#dataDialog");
  assert.match(dialogText, /新的恢复数据/);
  assert.doesNotMatch(dialogText, /旧的恢复数据/);
  assert.equal(await page.locator("#dataDialog").evaluate((dialog) => dialog.open), true);
});

test("editor recovery center lists historical data accessibly and confirms before restore", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t, { viewport: { width: 1280, height: 800 } });
  let restoreRequests = 0;
  const privateLookingPath = ["", "Users", "example", "private"].join("/");
  const longResumeName = "一份非常长的活动简历名称，用于验证窄屏幕下能够自然换行而不会撑宽恢复对话框";
  const snapshots = [
    {
      id: "newest-valid",
      type: "pre-restore",
      createdAt: "2026-07-11T08:09:10+08:00",
      valid: true,
      resumeCount: 2,
      activeResumeId: "cpp",
      activeResumeName: longResumeName,
      resumes: [
        { id: "cpp", name: longResumeName },
        { id: "safe", name: "<img src=x onerror=window.__recoveryXss=true>" }
      ]
    },
    {
      id: "invalid-middle",
      type: "pre-import",
      createdAt: "2026-07-10T07:08:09+08:00",
      valid: false,
      code: "unsafe-tree",
      reason: `Unsafe symlink at ${privateLookingPath}/photo.jpg`
    },
    {
      id: "invalid-data-middle",
      type: "pre-restore",
      createdAt: "2026-07-09T07:08:09+08:00",
      valid: false,
      code: "invalid-data",
      reason: `Invalid registry at ${privateLookingPath}/resumes.json`
    },
    {
      id: "oldest-valid",
      type: "pre-import",
      createdAt: "2026-07-08T06:07:08+08:00",
      valid: true,
      resumeCount: 1,
      activeResumeId: "legacy",
      activeResumeName: "旧简历",
      resumes: [{ id: "legacy", name: "旧简历" }]
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `history-${index + 1}`,
      type: index % 2 === 0 ? "pre-import" : "pre-restore",
      createdAt: `2026-07-${String(7 - index).padStart(2, "0")}T05:06:07+08:00`,
      valid: true,
      resumeCount: index + 1,
      activeResumeId: `history-${index + 1}`,
      activeResumeName: `${longResumeName} ${index + 1}`,
      resumes: [{ id: `history-${index + 1}`, name: `${longResumeName} ${index + 1}` }]
    }))
  ];
  await page.route("**/api/data/recovery/snapshots", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, snapshots })
  }));
  await page.route("**/api/data/recovery/restore", async (route) => {
    restoreRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.waitForSelector(".recovery-snapshot-row");

  const rowTexts = await page.locator(".recovery-snapshot-row").allTextContents();
  assert.equal(rowTexts.length, 12);
  assert.match(rowTexts[0], /恢复前备份/);
  assert.equal(rowTexts[0].includes(formatLocalDateTime(snapshots[0].createdAt)), true);
  assert.match(rowTexts[0], /2 份简历/);
  assert.match(rowTexts[0], /当前：一份非常长的活动简历名称/);
  assert.match(rowTexts[1], /导入前备份/);
  assert.equal(rowTexts[1].includes(formatLocalDateTime(snapshots[1].createdAt)), true);
  assert.match(rowTexts[1], /存在不安全文件，无法恢复/);
  assert.match(rowTexts[2], /恢复前备份/);
  assert.match(rowTexts[2], /数据文件无效，无法恢复/);
  assert.match(rowTexts[3], /导入前备份/);
  assert.equal(rowTexts.join(" ").includes(privateLookingPath), false);
  assert.doesNotMatch(rowTexts.join(" "), /Unsafe symlink|Invalid registry|private\/photo/);
  assert.deepEqual(await page.locator(".recovery-snapshot-status").allTextContents(), [
    "可恢复",
    "不可恢复",
    "不可恢复",
    ...Array(9).fill("可恢复")
  ]);
  assert.equal(await page.evaluate(() => window.__recoveryXss), undefined);

  const validRows = page.locator("button.recovery-snapshot-row:not(:disabled)");
  assert.equal(await validRows.count(), 10);
  assert.equal(await page.locator(".recovery-snapshot-row.is-invalid").count(), 2);
  assert.equal(await page.locator(".recovery-snapshot-row.is-invalid").first().isDisabled(), true);
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), true);
  await page.locator("#dataDialogClose").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.snapshotId), "newest-valid");
  assert.notEqual(await validRows.first().evaluate((button) => getComputedStyle(button).outlineWidth), "0px");
  await validRows.first().click();
  assert.equal(await validRows.first().getAttribute("aria-pressed"), "true");
  assert.equal(await validRows.first().evaluate((button) => button.classList.contains("is-selected")), true);
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), false);
  assert.match(await page.textContent(".recovery-snapshot-detail"), /一份非常长的活动简历名称/);
  assert.match(await page.textContent(".recovery-snapshot-detail"), /<img src=x onerror=window.__recoveryXss=true>/);

  await page.click("#dataDialogClose");
  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.waitForSelector(".recovery-snapshot-row");
  assert.equal(await page.locator(".recovery-snapshot-row.is-selected").count(), 0);
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), true);
  await page.click("[data-snapshot-id='newest-valid']");

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 700 }
  ]) {
    await page.setViewportSize(viewport);
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector("#dataDialog");
      const list = document.querySelector(".recovery-snapshot-list");
      const dialogBox = dialog.getBoundingClientRect();
      return {
        dialogRight: dialogBox.right,
        dialogLeft: dialogBox.left,
        dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
        listOverflow: list.scrollWidth > list.clientWidth,
        listScrolls: list.scrollHeight > list.clientHeight,
        listOverflowY: getComputedStyle(list).overflowY
      };
    });
    assert.ok(overflow.dialogLeft >= 0);
    assert.ok(overflow.dialogRight <= viewport.width);
    assert.equal(overflow.dialogOverflow, false);
    assert.equal(overflow.listOverflow, false);
    assert.equal(overflow.listScrolls, true);
    assert.equal(overflow.listOverflowY, "auto");
  }

  await page.click("#dataDialogPrimary");
  assert.equal(restoreRequests, 0);
  assert.match(await page.textContent("#dataDialogBody"), /全部已保存数据/);
  assert.match(await page.textContent("#dataDialogBody"), /简历、照片、备份和配置/);
  assert.match(await page.textContent("#dataDialogBody"), /当前数据会自动保留/);
  assert.equal(await page.textContent("#dataDialogPrimary"), "确认恢复");
});

test("editor historical data restore is single-flight, reloads drafts, and keeps confirmation on failure", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  const privateLookingPath = ["", "Users", "example", "private"].join("/");
  let generateRequests = 0;
  const snapshot = {
    id: "recoverable",
    type: "pre-restore",
    createdAt: "2026-07-11T08:09:10+08:00",
    valid: true,
    resumeCount: 1,
    activeResumeId: "cpp",
    activeResumeName: "C++ 应届生",
    resumes: [{ id: "cpp", name: "C++ 应届生" }]
  };
  let restoreRequests = 0;
  let releaseRestore;
  const restoreBlocked = new Promise((resolve) => {
    releaseRestore = resolve;
  });
  await page.route("**/api/data/recovery/snapshots", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, snapshots: [snapshot] })
  }));
  await page.route("**/api/data/recovery/restore", async (route) => {
    restoreRequests += 1;
    if (restoreRequests === 1) {
      await restoreBlocked;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          activeId: "cpp",
          resumes: [{ id: "cpp", name: "恢复后的简历", file: "resumes/cpp.yaml" }],
          preRestoreBackup: `${privateLookingPath}/resume-data.pre-restore-20260711-080910`,
          generation: "needs generate"
        })
      });
      return;
    }
    await route.fulfill({
      status: 423,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        code: "restore-locked",
        error: `Misleading transient failure at ${privateLookingPath}/data.`
      })
    });
  });
  await page.route("**/api/generate", async (route) => {
    generateRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.click("[data-snapshot-id='recoverable']");
  await page.click("#dataDialogPrimary");
  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => document.querySelector("#dataDialog")?.getAttribute("aria-busy") === "true");
  await page.locator("#dataDialogPrimary").evaluate((button) => {
    button.click();
    button.click();
  });

  assert.equal(restoreRequests, 1);
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), true);
  assert.equal(await page.locator("#dataDialogCancel").isDisabled(), true);
  assert.equal(await page.locator("#dataDialogClose").isDisabled(), true);
  releaseRestore();
  await page.waitForFunction(() => !document.querySelector("#dataDialog")?.open);
  await page.waitForFunction(() => document.querySelector("#messageLine")?.textContent?.includes("恢复完成"));

  const successMessage = await page.textContent("#messageLine");
  assert.match(successMessage, /resume-data\.pre-restore-20260711-080910/);
  assert.equal(successMessage.includes(privateLookingPath), false);
  assert.doesNotMatch(successMessage, /private/);
  assert.equal(generateRequests, 0);
  assert.equal(await page.textContent("#resumeSelectLabel"), "恢复后的简历");
  assert.match(await page.textContent("#statusStrip"), /PDF 待生成/);
  assert.equal(await page.locator("#previewFrame").getAttribute("src"), "about:blank");
  await page.waitForFunction(() => document.activeElement?.id === "dataManagerButton");

  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.click("[data-snapshot-id='recoverable']");
  await page.click("#dataDialogPrimary");
  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => document.querySelector("#dataDialogError")?.textContent?.includes("恢复失败"));
  const failureText = await page.textContent("#dataDialog");
  assert.equal(restoreRequests, 2);
  assert.equal(await page.textContent("#dataDialogPrimary"), "确认恢复");
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), false);
  assert.match(failureText, /当前编辑器中已有数据恢复正在进行/);
  assert.match(failureText, /C\+\+ 应届生/);
  assert.equal(failureText.includes(privateLookingPath), false);
  assert.doesNotMatch(failureText, /Misleading transient|private\/data/);

  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => document.querySelector("#dataDialogError")?.textContent?.includes("恢复失败"));
  assert.equal(restoreRequests, 3);

  await page.evaluate(() => {
    const input = document.querySelector("[data-path='profile.name']");
    input.value = "恢复前又发生修改";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#dataDialogPrimary");
  assert.equal(restoreRequests, 3);
  assert.match(await page.textContent("#messageLine"), /恢复前请先保存或撤销当前修改/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "saveButton");
});

test("editor recovery center maps unavailable and transient restore codes to safe states", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  const privateLookingPath = ["", "Users", "example", "private"].join("/");
  const snapshot = {
    id: "coded-error-snapshot",
    type: "pre-import",
    createdAt: "2026-07-11T08:09:10+08:00",
    valid: true,
    resumeCount: 1,
    activeResumeId: "cpp",
    activeResumeName: "错误码测试简历",
    resumes: [{ id: "cpp", name: "错误码测试简历" }]
  };
  let listRequests = 0;
  let restoreRequests = 0;
  await page.route("**/api/data/recovery/snapshots", async (route) => {
    listRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, snapshots: [snapshot] })
    });
  });
  await page.route("**/api/data/recovery/restore", async (route) => {
    restoreRequests += 1;
    const unavailable = restoreRequests === 1;
    await route.fulfill({
      status: unavailable ? 404 : 423,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        code: unavailable ? "snapshot-not-found" : "restore-locked",
        error: `Wrong English message at ${privateLookingPath}/snapshot.`
      })
    });
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.waitForFunction(() => document.activeElement?.dataset.snapshotId === "coded-error-snapshot");
  assert.equal(await page.locator(".recovery-snapshot-row.is-selected").count(), 0);
  await page.click("[data-snapshot-id='coded-error-snapshot']");
  await page.click("#dataDialogPrimary");
  await page.click("#dataDialogPrimary");

  await page.waitForFunction(() => document.querySelector("#dataDialogPrimary")?.textContent === "继续");
  const unavailableText = await page.textContent("#dataDialog");
  assert.equal(listRequests, 2);
  assert.equal(restoreRequests, 1);
  assert.match(unavailableText, /所选恢复数据不存在/);
  assert.equal(unavailableText.includes(privateLookingPath), false);
  assert.doesNotMatch(unavailableText, /Wrong English message/);
  assert.equal(await page.locator(".recovery-snapshot-row.is-selected").count(), 0);
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), true);
  const relistFocus = await page.evaluate(() => {
    const dialog = document.querySelector("#dataDialog");
    const active = document.activeElement;
    return {
      dialogOpen: dialog.open,
      insideDialog: dialog.contains(active),
      enabled: !active.disabled,
      tagName: active.tagName,
      snapshotId: active.dataset.snapshotId || ""
    };
  });
  assert.equal(relistFocus.dialogOpen, true);
  assert.equal(relistFocus.insideDialog, true);
  assert.equal(relistFocus.enabled, true);
  assert.notEqual(relistFocus.tagName, "BODY");
  assert.equal(relistFocus.snapshotId, "coded-error-snapshot");

  await page.click("[data-snapshot-id='coded-error-snapshot']");
  await page.click("#dataDialogPrimary");
  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => document.querySelector("#dataDialogError")?.textContent?.includes("当前编辑器中已有数据恢复正在进行"));
  const transientText = await page.textContent("#dataDialog");
  assert.equal(restoreRequests, 2);
  assert.equal(transientText.includes(privateLookingPath), false);
  assert.equal(await page.locator("#dataDialogPrimary").isDisabled(), false);
  assert.equal(await page.locator(".recovery-snapshot-detail").count(), 1);
  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => document.querySelector("#dataDialogError")?.textContent?.includes("当前编辑器中已有数据恢复正在进行"));
  assert.equal(restoreRequests, 3);
});

test("editor recovery center blocks retry when restore requires manual recovery", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  const privateLookingPath = ["", "Users", "example", "private"].join("/");
  const snapshot = {
    id: "manual-recovery-snapshot",
    type: "pre-restore",
    createdAt: "2026-07-11T08:09:10+08:00",
    valid: true,
    resumeCount: 1,
    activeResumeId: "cpp",
    activeResumeName: "人工恢复测试简历",
    resumes: [{ id: "cpp", name: "人工恢复测试简历" }]
  };
  let restoreRequests = 0;
  await page.route("**/api/data/recovery/snapshots", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, snapshots: [snapshot] })
  }));
  await page.route("**/api/data/recovery/restore", async (route) => {
    restoreRequests += 1;
    const code = restoreRequests === 1
      ? "restore-rollback-failed"
      : "restore-quarantine-failed";
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        code,
        error: `Manual recovery detail at ${privateLookingPath}/snapshot.`
      })
    });
  });

  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.click("[data-snapshot-id='manual-recovery-snapshot']");
  await page.click("#dataDialogPrimary");
  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => document.querySelector("#dataDialogError")?.textContent?.includes("需要人工处理"));

  const dialogText = await page.textContent("#dataDialog");
  assert.equal(restoreRequests, 1);
  assert.match(dialogText, /无法自动回滚/);
  assert.match(dialogText, /停止继续恢复/);
  assert.match(dialogText, /人工恢复测试简历/);
  assert.equal(dialogText.includes(privateLookingPath), false);
  assert.doesNotMatch(dialogText, /Manual recovery detail/);
  assert.equal(await page.locator("#dataDialogPrimary").isHidden(), true);
  assert.equal(await page.locator("#dataDialogClose").isDisabled(), false);
  await page.waitForFunction(() => document.activeElement?.id === "dataDialogClose");
  await page.locator("#dataDialogPrimary").evaluate((button) => button.click());
  assert.equal(restoreRequests, 1);
  await page.click("#dataDialogClose");
  await page.waitForFunction(() => !document.querySelector("#dataDialog")?.open);

  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.click("[data-snapshot-id='manual-recovery-snapshot']");
  await page.click("#dataDialogPrimary");
  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => document.querySelector("#dataDialogError")?.textContent?.includes("异常数据无法隔离"));

  const quarantineText = await page.textContent("#dataDialog");
  assert.equal(restoreRequests, 2);
  assert.match(quarantineText, /需要人工处理/);
  assert.match(quarantineText, /停止继续恢复/);
  assert.equal(quarantineText.includes(privateLookingPath), false);
  assert.equal(await page.locator("#dataDialogPrimary").isHidden(), true);
  assert.equal(await page.locator("#dataDialogCancel").isDisabled(), false);
  await page.waitForFunction(() => document.activeElement?.id === "dataDialogClose");
  await page.locator("#dataDialogPrimary").evaluate((button) => button.click());
  assert.equal(restoreRequests, 2);
  await page.click("#dataDialogCancel");
  await page.waitForFunction(() => !document.querySelector("#dataDialog")?.open);
});

test("editor recovery center retries only UI refresh after a committed restore", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({ preferredPort: 0, maxPort: 0, rootDir, log: false });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  const snapshot = {
    id: "refresh-retry-snapshot",
    type: "pre-restore",
    createdAt: "2026-07-11T08:09:10+08:00",
    valid: true,
    resumeCount: 1,
    activeResumeId: "cpp",
    activeResumeName: "刷新重试简历",
    resumes: [{ id: "cpp", name: "刷新重试简历" }]
  };
  let restoreCommitted = false;
  let restoreRequests = 0;
  let refreshFailures = 0;
  await page.route("**/api/data/recovery/snapshots", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, snapshots: [snapshot] })
  }));
  await page.route("**/api/data/recovery/restore", async (route) => {
    restoreRequests += 1;
    restoreCommitted = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        activeId: "cpp",
        resumes: [{ id: "cpp", name: "恢复后简历", file: "resumes/cpp.yaml" }],
        preRestoreBackup: "resume-data.pre-restore-20260711-080910",
        generation: "needs generate"
      })
    });
  });
  await page.route("**/api/resume?*", async (route) => {
    if (restoreCommitted && refreshFailures === 0) {
      refreshFailures += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "refresh-failed", error: "Synthetic refresh failure." })
      });
      return;
    }
    await route.continue();
  });
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");
  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.click("[data-snapshot-id='refresh-retry-snapshot']");
  await page.click("#dataDialogPrimary");
  await page.click("#dataDialogPrimary");

  await page.waitForFunction(() => document.querySelector("#dataDialogPrimary")?.textContent === "重试刷新");
  assert.equal(restoreRequests, 1);
  assert.equal(await page.locator("#dataDialog").evaluate((dialog) => dialog.open), true);
  assert.match(await page.textContent("#dataDialog"), /数据已恢复.*界面刷新失败/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "dataDialogPrimary");

  await page.click("#dataDialogPrimary");
  await page.waitForFunction(() => !document.querySelector("#dataDialog")?.open);
  await page.waitForFunction(() => document.activeElement?.id === "dataManagerButton");
  assert.equal(restoreRequests, 1);
  assert.match(await page.textContent("#messageLine"), /恢复完成/);
});

test("editor recovery center preserves UI-driven pending import cancellation", async (t) => {
  const rootDir = makeApiFixture();
  const app = await startEditorServer({
    preferredPort: 0,
    maxPort: 0,
    rootDir,
    log: false
  });
  t.after(async () => app.close());
  const page = await openEditorPage(t);
  await page.route("**/api/data/recovery/snapshots", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, snapshots: [] })
  }));
  await page.route("**/api/data/import/inspect", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      token: "pending-token",
      summary: {
        createdAt: "2026-07-11T08:09:10+08:00",
        formatVersion: 1,
        resumeCount: 1,
        activeResumeId: "cpp",
        resumes: [{ id: "cpp", name: "C++ 应届生" }]
      }
    })
  }));
  await page.route("**/api/data/import/pending-token", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true })
  }));
  await page.goto(app.url);
  await page.waitForSelector("[data-path='profile.name']");

  await page.click("#dataManagerButton");
  await page.click("#recoverDataButton");
  await page.waitForFunction(() => document.querySelector("#dataDialogBody")?.textContent?.includes("暂无可恢复的历史数据"));
  await page.click("#dataDialogCancel");

  await page.click("#dataManagerButton");
  const chooserPromise = page.waitForEvent("filechooser");
  await page.click("#importDataButton");
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "resume-builder-backup.zip",
    mimeType: "application/zip",
    buffer: Buffer.from("synthetic package")
  });
  await page.waitForFunction(() => document.querySelector("#dataDialogPrimary")?.textContent === "确认导入");
  const deleteRequest = page.waitForRequest((request) => (
    request.method() === "DELETE" && request.url().endsWith("/api/data/import/pending-token")
  ));
  await page.click("#dataDialogCancel");
  await deleteRequest;
  assert.equal(await page.locator("#dataDialog").evaluate((dialog) => dialog.open), false);
});
