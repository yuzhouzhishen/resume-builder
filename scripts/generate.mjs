#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { compatibilityDensity } from "./layout-settings.mjs";
import {
  DEFAULT_SECTION_ORDER,
  SECTION_TITLES,
  loadResumeYaml,
  resolveResumeAssetPath,
  validateResume
} from "./resume-data.mjs";
import { resolveAppPaths } from "./app-paths.mjs";
import { ensureDataRoot } from "./data-root.mjs";
import {
  loadResumeRegistry,
  resolveResumePaths
} from "./resume-registry.mjs";

export { loadResumeYaml, saveResumeYaml, validateResume } from "./resume-data.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_TEMPLATE_FILE = path.join(PROJECT_ROOT, "templates", "resume.html");
const DEFAULT_CSS_FILE = path.join(PROJECT_ROOT, "templates", "resume.css");

const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;
const FIT_TOLERANCE_PX = 2;

const DENSITY_PROFILES = [
  {
    name: "normal",
    vars: {
      "--body-size": "10.8pt",
      "--body-line-height": "1.38",
      "--item-gap": "3px",
      "--section-gap": "8px",
      "--experience-gap": "5px",
      "--bullet-indent": "16px"
    }
  },
  {
    name: "compact",
    vars: {
      "--body-size": "10.5pt",
      "--body-line-height": "1.32",
      "--item-gap": "2px",
      "--section-gap": "6px",
      "--experience-gap": "4px",
      "--bullet-indent": "15px"
    }
  },
  {
    name: "tight",
    vars: {
      "--body-size": "10.2pt",
      "--body-line-height": "1.25",
      "--item-gap": "1px",
      "--section-gap": "4px",
      "--experience-gap": "3px",
      "--bullet-indent": "14px"
    }
  }
];

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function assetToDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  };
  const mime = mimeTypes[ext] || "application/octet-stream";
  const bytes = readFileSync(filePath);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}

function textValue(value) {
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
      return `${key}: ${textValue(nestedValue)}`;
    }
  }

  return String(value);
}

function renderSection(section, title, innerHtml) {
  return [
    `<section class="section" data-section="${escapeAttribute(section)}">`,
    `  <h2 class="section-title"><span>${escapeHtml(title)}</span></h2>`,
    innerHtml,
    "</section>"
  ].join("\n");
}

function renderProfileField(path, label, value) {
  return `<div data-section="profile" data-path="${escapeAttribute(path)}"><span>${escapeHtml(label)}：</span>${escapeHtml(value)}</div>`;
}

function renderList(items, pathPrefix = "") {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }

  return [
    '<ul class="item-list">',
    ...items.map((item, index) => {
      const pathAttribute = pathPrefix ? ` data-path="${escapeAttribute(`${pathPrefix}.${index}`)}"` : "";
      return `  <li${pathAttribute}>${escapeHtml(textValue(item))}</li>`;
    }),
    "</ul>"
  ].join("\n");
}

function renderLink(label, href, paths = {}) {
  if (!href) {
    return "";
  }

  return [
    '<p class="project-link">',
    `  <span${paths.label ? ` data-path="${escapeAttribute(paths.label)}"` : ""}>${escapeHtml(label || "项目代码链接")}:</span> `,
    `  <a${paths.href ? ` data-path="${escapeAttribute(paths.href)}"` : ""} href="${escapeAttribute(href)}">${escapeHtml(href)}</a>`,
    "</p>"
  ].join("\n");
}

function renderExperience(entry, kind, section, path) {
  const title = kind === "project" ? entry.name : entry.organization;
  const titlePath = kind === "project" ? `${path}.name` : `${path}.organization`;
  return [
    `<article class="experience" data-section="${escapeAttribute(section)}" data-path="${escapeAttribute(path)}">`,
    '  <header class="experience-header">',
    `    <div class="experience-time"><span data-path="${escapeAttribute(`${path}.start`)}">${escapeHtml(entry.start)}</span>-<span data-path="${escapeAttribute(`${path}.end`)}">${escapeHtml(entry.end)}</span></div>`,
    `    <div class="experience-title" data-path="${escapeAttribute(titlePath)}">${escapeHtml(title)}</div>`,
    `    <div class="experience-role" data-path="${escapeAttribute(`${path}.role`)}">${escapeHtml(entry.role)}</div>`,
    "  </header>",
    entry.summary ? `  <p class="experience-summary" data-path="${escapeAttribute(`${path}.summary`)}">${escapeHtml(entry.summary)}</p>` : "",
    renderList(entry.items, `${path}.items`),
    renderLink(entry.linkLabel, entry.link, {
      label: `${path}.linkLabel`,
      href: `${path}.link`
    }),
    "</article>"
  ].filter(Boolean).join("\n");
}

function sectionOrder(data) {
  return data.layout?.sectionOrder || DEFAULT_SECTION_ORDER;
}

function renderContent(data, options) {
  const photoSrc = options.photoSrc || resolveAssetSrc(data.profile.photo, options.assetPrefix || "../");
  const skills = data.skills.map((group, index) => [
    `<div class="skill-group" data-section="skills" data-path="skills.${index}">`,
    `  <h3 data-path="skills.${index}.title">${escapeHtml(group.title)}</h3>`,
    renderList(group.items, `skills.${index}.items`),
    "</div>"
  ].join("\n")).join("\n");

  return [
    '<main class="page" id="resume-page">',
    '  <header class="profile" data-section="profile">',
    '    <div class="profile-grid">',
    `      ${renderProfileField("profile.name", "姓名", data.profile.name)}`,
    `      ${renderProfileField("profile.target", "求职意向", data.profile.target)}`,
    `      ${renderProfileField("profile.school", "学校", data.profile.school)}`,
    `      ${renderProfileField("profile.major", "专业", data.profile.major)}`,
    `      ${renderProfileField("profile.phone", "电话", data.profile.phone)}`,
    `      ${renderProfileField("profile.email", "邮箱", data.profile.email)}`,
    "    </div>",
    `    <img class="photo" data-section="photo" src="${escapeAttribute(photoSrc)}" alt="证件照">`,
    "  </header>",
    ...sectionOrder(data).map((section) => {
      const sectionHtml = {
        skills,
        internships: data.internships.map((item, index) => renderExperience(item, "internship", "internships", `internships.${index}`)).join("\n"),
        projects: data.projects.map((item, index) => renderExperience(item, "project", "projects", `projects.${index}`)).join("\n")
      };
      return renderSection(section, SECTION_TITLES[section], sectionHtml[section]);
    }),
    "</main>"
  ].join("\n");
}

export function renderResumeHtml(data, options = {}) {
  const density = options.density || (options.layoutCandidate
    ? compatibilityDensity(options.layoutCandidate)
    : "normal");
  const layoutMode = options.layoutCandidate?.settings?.mode || data.layout?.mode || "auto";
  const cssPath = options.cssPath || "../templates/resume.css";
  const templateFile = options.templateFile || DEFAULT_TEMPLATE_FILE;
  const template = existsSync(templateFile)
    ? readFileSync(templateFile, "utf8")
    : "<!doctype html><html><head><title>{{title}}</title></head><body data-density=\"{{density}}\" data-layout-mode=\"{{layoutMode}}\">{{content}}</body></html>";

  let html = template
    .replaceAll("{{title}}", escapeHtml(`${data.profile.name} - Resume`))
    .replaceAll("{{density}}", escapeAttribute(density))
    .replaceAll("{{layoutMode}}", escapeAttribute(layoutMode))
    .replace("../templates/resume.css", escapeAttribute(cssPath))
    .replace("{{content}}", renderContent(data, options));

  if (typeof options.cssText === "string") {
    html = html.replace(
      /<link\s+rel="stylesheet"\s+href="[^"]+">/,
      `<style>\n${options.cssText}\n</style>`
    );
  }
  if (options.layoutCandidate) {
    html = html.replace(
      "</head>",
      `<style data-layout-variables>\n:root { ${densityStyle(options.layoutCandidate)} }\n</style>\n</head>`
    );
  }
  return html;
}

function resolveAssetSrc(assetPath, assetPrefix) {
  if (/^[a-z]+:/i.test(assetPrefix)) {
    return new URL(assetPath, assetPrefix).href;
  }

  return path.posix.join(assetPrefix, assetPath).replaceAll("\\", "/");
}

function densityStyle(profile) {
  const variables = profile.cssVariables || profile.vars;
  return Object.entries(variables)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

async function measureHtml(browser, html, profile, cssFile) {
  const page = await browser.newPage({
    viewport: { width: A4_WIDTH_PX, height: A4_HEIGHT_PX },
    deviceScaleFactor: 1
  });

  await page.setContent(html, {
    waitUntil: "networkidle"
  });
  await page.addStyleTag({ path: cssFile });
  await page.addStyleTag({ content: `:root { ${densityStyle(profile)} }` });

  const metrics = await page.evaluate(() => {
    const resume = document.querySelector("#resume-page");
    const pageRect = resume.getBoundingClientRect();
    const descendants = Array.from(resume.querySelectorAll("*"));
    const contentRect = descendants.reduce((acc, element) => {
      const rect = element.getBoundingClientRect();
      return {
        bottom: Math.max(acc.bottom, rect.bottom - pageRect.top),
        right: Math.max(acc.right, rect.right - pageRect.left)
      };
    }, { bottom: 0, right: 0 });
    return {
      height: Math.ceil(contentRect.bottom),
      width: Math.ceil(contentRect.right),
      pageHeight: Math.ceil(pageRect.height),
      pageWidth: Math.ceil(pageRect.width),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth
    };
  });

  return { page, metrics };
}

async function selectDensity(browser, data, photoSrc, options) {
  let lastResult = null;

  for (const profile of DENSITY_PROFILES) {
    const html = renderResumeHtml(data, {
      density: profile.name,
      templateFile: options.templateFile,
      assetPrefix: pathToFileURL(`${options.dataRoot}/`).href,
      photoSrc
    });
    const result = await measureHtml(browser, html, profile, options.cssFile);
    const verticalOverflow = Math.max(0, result.metrics.height - A4_HEIGHT_PX);
    const horizontalOverflow = Math.max(0, result.metrics.width - A4_WIDTH_PX);

    if (verticalOverflow <= FIT_TOLERANCE_PX && horizontalOverflow <= FIT_TOLERANCE_PX) {
      return {
        profile,
        html,
        page: result.page,
        metrics: result.metrics
      };
    }

    await result.page.close();
    lastResult = { profile, metrics: result.metrics, verticalOverflow, horizontalOverflow };
  }

  const overflow = Math.max(lastResult?.verticalOverflow || 0, lastResult?.horizontalOverflow || 0);
  throw new Error([
    "Content does not fit one A4 page after tight profile.",
    `Overflow: ${overflow}px.`,
    "Suggestion: shorten the longest section or reduce 1-2 bullet items."
  ].join("\n"));
}

function assertOnePage(pdfPath) {
  let output;
  try {
    output = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
  } catch (error) {
    throw new Error(`Cannot run pdfinfo. Install Poppler with: brew install poppler\n${error.message}`);
  }

  if (!/^Pages:\s+1$/m.test(output)) {
    throw new Error(`Expected one-page PDF, got:\n${output}`);
  }

  return output;
}

function renderPng(pdfPath, outputPrefix) {
  try {
    execFileSync("pdftoppm", ["-png", "-singlefile", "-r", "180", pdfPath, outputPrefix], {
      encoding: "utf8",
      stdio: "pipe"
    });
  } catch (error) {
    throw new Error(`Cannot render PNG with pdftoppm. Install Poppler with: brew install poppler\n${error.message}`);
  }
}

export async function generateResume(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const dataRoot = path.resolve(options.dataRoot || options.rootDir || PROJECT_ROOT);
  const templateFile = path.join(projectRoot, "templates", "resume.html");
  const cssFile = path.join(projectRoot, "templates", "resume.css");
  const registry = loadResumeRegistry(dataRoot);
  const resumeId = options.resumeId || registry.activeId;
  let paths;

  try {
    paths = resolveResumePaths(dataRoot, registry, resumeId);
  } catch (error) {
    if (/^Unknown resume id:/.test(error.message)) {
      const availableIds = registry.items.map((item) => item.id).join(", ");
      throw new Error(`${error.message}. Available resume ids: ${availableIds}`);
    }
    throw error;
  }

  mkdirSync(paths.outputDir, { recursive: true });
  const data = validateResume(loadResumeYaml(paths.yaml), dataRoot);
  const photoSrc = assetToDataUri(resolveResumeAssetPath(dataRoot, data.profile.photo));
  const cssText = readFileSync(cssFile, "utf8");
  const launchBrowser = options.launchBrowser || (() => chromium.launch());
  const verifyPdf = options.verifyPdf || assertOnePage;
  const renderPngFile = options.renderPngFile || renderPng;
  const browser = await launchBrowser();

  try {
    const selected = await selectDensity(browser, data, photoSrc, {
      cssFile,
      dataRoot,
      templateFile
    });
    const pngPrefix = path.join(paths.outputDir, "resume");
    const previewHtml = renderResumeHtml(data, {
      density: selected.profile.name,
      templateFile,
      cssText,
      photoSrc
    });

    writeFileSync(paths.previewHtml, previewHtml);
    await selected.page.pdf({
      path: paths.pdf,
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" }
    });
    await selected.page.close();

    verifyPdf(paths.pdf);
    renderPngFile(paths.pdf, pngPrefix);

    console.log(`Selected density: ${selected.profile.name}`);
    console.log(`Measured content height: ${selected.metrics.height}px`);
    console.log(`Wrote: ${path.relative(dataRoot, paths.previewHtml)}`);
    console.log(`Wrote: ${path.relative(dataRoot, paths.pdf)}`);
    console.log(`Wrote: ${path.relative(dataRoot, paths.png)}`);

    return {
      resumeId,
      density: selected.profile.name,
      metrics: selected.metrics,
      outputPaths: {
        preview: paths.previewHtml,
        pdf: paths.pdf,
        png: paths.png
      }
    };
  } finally {
    await browser.close();
  }
}

export function parseGenerateArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--resume") {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const resumeId = args[index + 1];
    if (!resumeId || resumeId.startsWith("--")) {
      throw new Error("--resume requires an id");
    }
    if (options.resumeId) {
      throw new Error("--resume can only be provided once");
    }

    options.resumeId = resumeId;
    index += 1;
  }

  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  let options;
  try {
    options = parseGenerateArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }

  if (options) {
    try {
      const appPaths = resolveAppPaths({ projectRoot: PROJECT_ROOT });
      ensureDataRoot(appPaths);
      await generateResume({ ...options, ...appPaths });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
