import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assetToDataUri,
  escapeHtml,
  generateResume,
  loadResumeYaml,
  parseGenerateArgs,
  renderResumeHtml,
  saveResumeYaml,
  validateResume
} from "./generate.mjs";
import { buildLayoutCandidates } from "./layout-settings.mjs";
import { resolveResumeLayout } from "./resume-data.mjs";

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
  internships: [
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
  ],
  projects: [
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
  ]
};

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "resume-builder-test-"));
  mkdirSync(path.join(dir, "assets"));
  writeFileSync(path.join(dir, "assets/photo.svg"), "<svg></svg>");
  return dir;
}

function makeGenerationFixture() {
  const parent = mkdtempSync(path.join(tmpdir(), "resume-generation-test-"));
  const projectRoot = path.join(parent, "project");
  const dataRoot = path.join(parent, "data");
  mkdirSync(path.join(projectRoot, "templates"), { recursive: true });
  mkdirSync(path.join(dataRoot, "assets"), { recursive: true });
  mkdirSync(path.join(dataRoot, "resumes"), { recursive: true });
  cpSync(path.resolve("templates/resume.html"), path.join(projectRoot, "templates/resume.html"));
  cpSync(path.resolve("templates/resume.css"), path.join(projectRoot, "templates/resume.css"));
  appendFileSync(path.join(projectRoot, "templates/resume.css"), "\n/* split-root-css-marker */\n");
  writeFileSync(path.join(dataRoot, "assets/photo.svg"), "<svg></svg>");

  const cppResume = structuredClone(validResume);
  cppResume.profile.name = "C++ Candidate";
  const aiResume = structuredClone(validResume);
  aiResume.profile.name = "AI Candidate";

  saveResumeYaml(path.join(dataRoot, "resumes", "cpp.yaml"), cppResume);
  saveResumeYaml(path.join(dataRoot, "resumes", "ai-agent.yaml"), aiResume);
  writeFileSync(path.join(dataRoot, "resumes.json"), `${JSON.stringify({
    activeId: "cpp",
    items: [
      { id: "cpp", name: "C++ 应届生", file: "resumes/cpp.yaml" },
      { id: "ai-agent", name: "AI Agent", file: "resumes/ai-agent.yaml" }
    ]
  }, null, 2)}\n`);

  return { projectRoot, dataRoot };
}

function makeGenerationHarness(options = {}) {
  const styleTags = [];
  const appliedVariables = [];
  const metrics = options.metrics || [];
  let metricIndex = 0;
  let newPageCalls = 0;
  const page = {
    async setContent() {},
    async addStyleTag(options) {
      styleTags.push(options);
    },
    async evaluate(_callback, variables) {
      if (variables) {
        appliedVariables.push(variables);
      }
      const result = metrics[Math.min(metricIndex, metrics.length - 1)] || {
        height: 900,
        width: 760,
        pageHeight: 1123,
        pageWidth: 794,
        viewportHeight: 1123,
        viewportWidth: 794
      };
      metricIndex += 1;
      return result;
    },
    async pdf(options) {
      writeFileSync(options.path, "%PDF-test");
    },
    async close() {}
  };
  const browser = {
    async newPage() {
      newPageCalls += 1;
      return page;
    },
    async close() {}
  };

  return {
    styleTags,
    appliedVariables,
    get newPageCalls() {
      return newPageCalls;
    },
    launchBrowser: async () => browser,
    verifyPdf() {},
    renderPngFile(_pdfPath, outputPrefix) {
      if (options.renderPngError) {
        throw options.renderPngError;
      }
      writeFileSync(`${outputPrefix}.png`, "png-test");
    }
  };
}

test("loadResumeYaml reads resume yaml with expected top-level sections", () => {
  const dir = makeFixture();
  const file = path.join(dir, "resume.yaml");
  writeFileSync(file, [
    "profile:",
    "  name: 测试候选人",
    "  target: C++开发工程师",
    "  school: 示例大学（应届生）",
    "  major: 计算机科学与技术",
    "  phone: 000-0000-0000",
    "  email: candidate@example.com",
    "  photo: assets/photo.svg",
    "skills: []",
    "internships: []",
    "projects: []"
  ].join("\n"));

  const data = loadResumeYaml(file);
  assert.deepEqual(Object.keys(data), ["profile", "skills", "internships", "projects"]);
});

test("loadResumeYaml reports invalid YAML clearly", () => {
  const dir = makeFixture();
  const file = path.join(dir, "resume.yaml");
  writeFileSync(file, "profile:\n  name: [broken\n");

  assert.throws(() => loadResumeYaml(file), /Invalid YAML/);
});

test("loadResumeYaml normalizes accidental YAML mapping bullets to text", () => {
  const dir = makeFixture();
  const file = path.join(dir, "resume.yaml");
  writeFileSync(file, [
    "profile:",
    "  name: 测试候选人",
    "  target: C++开发工程师",
    "  school: 示例大学（应届生）",
    "  major: 计算机科学与技术",
    "  phone: 000-0000-0000",
    "  email: candidate@example.com",
    "  photo: assets/photo.svg",
    "skills:",
    "  - title: C/C++编程",
    "    items:",
    "      - 熟悉常见的数据结构，如: 顺序表、栈、队列。",
    "internships: []",
    "projects: []"
  ].join("\n"));

  const data = loadResumeYaml(file);

  assert.equal(data.skills[0].items[0], "熟悉常见的数据结构，如: 顺序表、栈、队列。");
});

test("validateResume rejects missing required profile fields", () => {
  const data = structuredClone(validResume);
  delete data.profile.email;

  assert.throws(() => validateResume(data, "/tmp/resume-builder"), /profile.email is required/);
});

test("validateResume rejects unsupported top-level sections", () => {
  const data = structuredClone(validResume);
  data.awards = [];

  assert.throws(() => validateResume(data, "/tmp/resume-builder"), /Unsupported top-level section: awards/);
});

test("validateResume accepts layout section order", () => {
  const dir = makeFixture();
  const data = structuredClone(validResume);
  data.layout = {
    sectionOrder: ["internships", "skills", "projects"]
  };

  assert.equal(validateResume(data, dir), data);
});

test("validateResume accepts per-resume layout preferences", () => {
  const dir = makeFixture();
  const data = structuredClone(validResume);
  data.layout = {
    sectionOrder: ["internships", "skills", "projects"],
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  };

  assert.equal(validateResume(data, dir), data);
  assert.deepEqual(resolveResumeLayout(data), {
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  });
});

test("old layout resolves defaults without mutating YAML data", () => {
  const dir = makeFixture();
  const data = structuredClone(validResume);
  data.layout = {
    sectionOrder: ["internships", "skills", "projects"]
  };
  const before = structuredClone(data.layout);

  validateResume(data, dir);

  assert.deepEqual(data.layout, before);
  assert.equal(resolveResumeLayout(data).fontSizePt, 10.8);
  assert.deepEqual(data.layout, before);
});

test("validateResume rejects unknown and invalid layout preferences", () => {
  const dir = makeFixture();
  const unknown = structuredClone(validResume);
  unknown.layout = {
    sectionOrder: ["internships", "skills", "projects"],
    color: "blue"
  };
  assert.throws(() => validateResume(unknown, dir), /Unknown layout field: color/);

  const invalid = structuredClone(validResume);
  invalid.layout = {
    sectionOrder: ["internships", "skills", "projects"],
    fontSizePt: 9
  };
  assert.throws(
    () => validateResume(invalid, dir),
    /layout.fontSizePt must be between 10.2 and 11.2 in 0.1 steps/
  );
});

test("validateResume rejects unknown layout section names", () => {
  const dir = makeFixture();
  const data = structuredClone(validResume);
  data.layout = {
    sectionOrder: ["internships", "skills", "awards"]
  };

  assert.throws(() => validateResume(data, dir), /Unknown layout.sectionOrder section: awards/);
});

test("validateResume rejects missing photo file", () => {
  const dir = makeFixture();
  const data = structuredClone(validResume);
  data.profile.photo = "assets/missing.svg";

  assert.throws(() => validateResume(data, dir), /Photo file not found/);
});

test("escapeHtml escapes unsafe characters", () => {
  assert.equal(escapeHtml("<C++ & \"Linux\">"), "&lt;C++ &amp; &quot;Linux&quot;&gt;");
});

test("renderResumeHtml includes core resume sections and links", () => {
  const html = renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.match(html, /测试候选人/);
  assert.match(html, /专业技能/);
  assert.match(html, /实习经历/);
  assert.match(html, /项目经历/);
  assert.match(html, /https:\/\/example\.com\/resume-project/);
  assert.match(html, /data-density="normal"/);
});

test("renderResumeHtml embeds selected layout variables", () => {
  const candidate = buildLayoutCandidates({
    mode: "fixed",
    fontSizePt: 10.5,
    lineHeight: 1.3,
    spacingLevel: 50,
    marginPreset: "narrow"
  })[0];
  const html = renderResumeHtml(validResume, {
    layoutCandidate: candidate,
    cssPath: "templates/resume.css"
  });

  assert.match(html, /data-layout-mode="fixed"/);
  assert.match(html, /data-density="custom"/);
  assert.match(html, /--body-size:\s*10\.5pt/);
  assert.match(html, /--body-line-height:\s*1\.3/);
  assert.match(html, /--page-x:\s*6mm/);
  assert.match(html, /--page-y:\s*4mm/);
});

test("resume template typography uses explicit layout variables", () => {
  const css = readFileSync(path.resolve("templates/resume.css"), "utf8");

  assert.match(css, /font-size:\s*var\(--profile-size\)/);
  assert.match(css, /font-size:\s*var\(--section-title-size\)/);
  assert.match(css, /font-size:\s*var\(--skill-title-size\)/);
  assert.match(css, /font-size:\s*var\(--experience-title-size\)/);
  assert.doesNotMatch(css, /body\[data-density="(?:normal|compact|tight)"\]/);
});

test("renderResumeHtml marks preview-clickable sections with stable ids", () => {
  const html = renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.match(html, /<header class="profile" data-section="profile">/);
  assert.match(html, /<img class="photo" data-section="photo"/);
  assert.match(html, /<section class="section" data-section="skills">/);
  assert.match(html, /<section class="section" data-section="internships">/);
  assert.match(html, /<section class="section" data-section="projects">/);
});

test("renderResumeHtml marks profile fields with stable data paths", () => {
  const html = renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.match(html, /data-path="profile\.name"/);
  assert.match(html, /data-path="profile\.target"/);
  assert.match(html, /data-path="profile\.school"/);
  assert.match(html, /data-path="profile\.major"/);
  assert.match(html, /data-path="profile\.phone"/);
  assert.match(html, /data-path="profile\.email"/);
});

test("renderResumeHtml marks editable content cards with stable data paths", () => {
  const html = renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.match(html, /<div class="skill-group" data-section="skills" data-path="skills\.0">/);
  assert.match(html, /<article class="experience" data-section="internships" data-path="internships\.0">/);
  assert.match(html, /<article class="experience" data-section="projects" data-path="projects\.0">/);
});

test("renderResumeHtml marks editable nested fields with stable data paths", () => {
  const html = renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.match(html, /data-path="internships\.0\.start"/);
  assert.match(html, /data-path="internships\.0\.organization"/);
  assert.match(html, /data-path="internships\.0\.role"/);
  assert.match(html, /data-path="internships\.0\.summary"/);
  assert.match(html, /data-path="internships\.0\.items\.0"/);
  assert.match(html, /data-path="internships\.0\.link"/);
  assert.match(html, /data-path="skills\.0\.title"/);
  assert.match(html, /data-path="skills\.0\.items\.0"/);
  assert.match(html, /data-path="projects\.0\.name"/);
  assert.match(html, /data-path="projects\.0\.summary"/);
  assert.match(html, /data-path="projects\.0\.items\.0"/);
});

test("renderResumeHtml defaults to skills before internships", () => {
  const html = renderResumeHtml(validResume, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.ok(html.indexOf("专业技能") < html.indexOf("实习经历"));
});

test("renderResumeHtml honors configured section order", () => {
  const data = structuredClone(validResume);
  data.layout = {
    sectionOrder: ["projects", "internships", "skills"]
  };

  const html = renderResumeHtml(data, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.ok(html.indexOf("项目经历") < html.indexOf("实习经历"));
  assert.ok(html.indexOf("实习经历") < html.indexOf("专业技能"));
});

test("renderResumeHtml escapes content before interpolation", () => {
  const data = structuredClone(validResume);
  data.profile.name = "<script>";

  const html = renderResumeHtml(data, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<title><script> - Resume<\/title>/);
  assert.doesNotMatch(html, /姓名：<\/span><script>/);
});

test("renderResumeHtml converts accidental YAML mapping list items back to text", () => {
  const data = structuredClone(validResume);
  data.skills[0].items = [
    { "熟悉常见的数据结构，如": "顺序表、栈、队列。" }
  ];

  const html = renderResumeHtml(data, {
    density: "normal",
    cssPath: "templates/resume.css"
  });

  assert.match(html, /熟悉常见的数据结构，如: 顺序表、栈、队列。/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("assetToDataUri embeds local image assets", () => {
  const dir = makeFixture();
  const file = path.join(dir, "assets/photo.svg");

  const uri = assetToDataUri(file);

  assert.match(uri, /^data:image\/svg\+xml;base64,/);
});

test("example resume yaml files validate", () => {
  const root = path.resolve(".");
  const files = ["examples/cpp.yaml", "examples/ai-agent.yaml"];

  for (const file of files) {
    const data = loadResumeYaml(path.join(root, file));

    assert.equal(validateResume(data, root), data);
  }
});

test("public examples tests and early documentation use fictional identities", () => {
  const root = path.resolve(".");
  const cpp = loadResumeYaml(path.join(root, "examples/cpp.yaml"));
  const ai = loadResumeYaml(path.join(root, "examples/ai-agent.yaml"));
  const earlyPlan = readFileSync(path.join(root, "docs/plans/2026-07-08-resume-builder.md"), "utf8");

  assert.equal(validResume.profile.name, "测试候选人");
  assert.equal(validResume.profile.email, "candidate@example.com");
  assert.equal(cpp.profile.name, "示例候选人");
  assert.equal(ai.profile.name, "示例候选人");
  assert.equal(cpp.profile.photo, "assets/photo.svg");
  assert.equal(ai.profile.photo, "assets/photo.svg");
  assert.match(earlyPlan, /\/path\/to\/source-resume\.pdf/);
});

test("generation fixtures use a valid temporary active resume", () => {
  const { dataRoot } = makeGenerationFixture();
  const registry = JSON.parse(readFileSync(path.join(dataRoot, "resumes.json"), "utf8"));
  const active = registry.items.find((item) => item.id === registry.activeId);

  assert.ok(active);
  assert.equal(existsSync(path.join(dataRoot, active.file)), true);

  const data = loadResumeYaml(path.join(dataRoot, active.file));
  assert.equal(validateResume(data, dataRoot), data);
});

test("resume data module can load validate and save yaml", async () => {
  const { loadResumeYaml: load, saveResumeYaml, validateResume: validate } = await import("./resume-data.mjs");
  const dir = makeFixture();
  const file = path.join(dir, "resume.yaml");
  const data = structuredClone(validResume);

  saveResumeYaml(file, data);

  const reloaded = load(file);
  assert.equal(reloaded.profile.name, "测试候选人");
  assert.equal(reloaded.profile.photo, "assets/photo.svg");
  assert.equal(validate(reloaded, dir), reloaded);
});

test("generate module exports generateResume for the local editor", async () => {
  const module = await import("./generate.mjs");

  assert.equal(typeof module.generateResume, "function");
});

test("generateResume uses the active resume and writes isolated outputs", async () => {
  const { projectRoot, dataRoot } = makeGenerationFixture();
  const harness = makeGenerationHarness();

  const result = await generateResume({ projectRoot, dataRoot, ...harness });

  assert.equal(result.resumeId, "cpp");
  assert.equal(result.outputPaths.preview, path.join(dataRoot, "output", "cpp", "preview.html"));
  assert.equal(result.outputPaths.pdf, path.join(dataRoot, "output", "cpp", "resume.pdf"));
  assert.equal(result.outputPaths.png, path.join(dataRoot, "output", "cpp", "resume.png"));
  const preview = readFileSync(result.outputPaths.preview, "utf8");
  assert.match(preview, /C\+\+ Candidate/);
  assert.match(preview, /split-root-css-marker/);
  assert.doesNotMatch(preview, /<link[^>]+resume\.css/);
  assert.equal(harness.styleTags[0].path, path.join(projectRoot, "templates/resume.css"));
  assert.equal(existsSync(path.join(projectRoot, "output")), false);
  assert.ok(existsSync(result.outputPaths.pdf));
  assert.ok(existsSync(result.outputPaths.png));
  assert.equal(harness.newPageCalls, 1);
  assert.deepEqual(result.layout, {
    mode: "auto",
    fontSizePt: 10.8,
    lineHeight: 1.38,
    spacingLevel: 67,
    marginPreset: "normal",
    cssVariables: harness.appliedVariables[0]
  });
  assert.deepEqual(result.overflow, { vertical: 0, horizontal: 0, total: 0 });
});

test("generateResume reuses one page and selects the first fitting auto candidate", async () => {
  const { projectRoot, dataRoot } = makeGenerationFixture();
  const harness = makeGenerationHarness({
    metrics: [
      { height: 1140, width: 760, pageHeight: 1123, pageWidth: 794 },
      { height: 1110, width: 760, pageHeight: 1123, pageWidth: 794 }
    ]
  });

  const result = await generateResume({ projectRoot, dataRoot, ...harness });

  assert.equal(harness.newPageCalls, 1);
  assert.equal(harness.appliedVariables.length, 2);
  assert.equal(result.layout.spacingLevel < 67, true);
  assert.equal(result.metrics.height, 1110);
});

test("generateResume fixed mode measures once and reports exact overflow", async () => {
  const { projectRoot, dataRoot } = makeGenerationFixture();
  const yamlPath = path.join(dataRoot, "resumes", "cpp.yaml");
  const data = loadResumeYaml(yamlPath);
  data.layout = {
    sectionOrder: ["skills", "internships", "projects"],
    mode: "fixed",
    fontSizePt: 11.2,
    lineHeight: 1.42,
    spacingLevel: 100,
    marginPreset: "wide"
  };
  saveResumeYaml(yamlPath, data);
  const harness = makeGenerationHarness({
    metrics: [{ height: 1161, width: 800, pageHeight: 1123, pageWidth: 794 }]
  });

  await assert.rejects(
    () => generateResume({ projectRoot, dataRoot, ...harness }),
    /Fixed layout does not fit one A4 page[\s\S]*Overflow: 38px/
  );
  assert.equal(harness.newPageCalls, 1);
  assert.equal(harness.appliedVariables.length, 1);
});

test("generation failures before publication preserve previous outputs", async () => {
  const { projectRoot, dataRoot } = makeGenerationFixture();
  const outputDir = path.join(dataRoot, "output", "cpp");
  mkdirSync(outputDir, { recursive: true });
  const previous = {
    preview: "old-preview",
    pdf: "old-pdf",
    png: "old-png"
  };
  writeFileSync(path.join(outputDir, "preview.html"), previous.preview);
  writeFileSync(path.join(outputDir, "resume.pdf"), previous.pdf);
  writeFileSync(path.join(outputDir, "resume.png"), previous.png);

  await assert.rejects(() => generateResume({
    projectRoot,
    dataRoot,
    ...makeGenerationHarness({ renderPngError: new Error("png failed") })
  }), /png failed/);

  assert.equal(readFileSync(path.join(outputDir, "preview.html"), "utf8"), previous.preview);
  assert.equal(readFileSync(path.join(outputDir, "resume.pdf"), "utf8"), previous.pdf);
  assert.equal(readFileSync(path.join(outputDir, "resume.png"), "utf8"), previous.png);
});

test("generateResume accepts an explicit registered resume id", async () => {
  const { projectRoot, dataRoot } = makeGenerationFixture();

  const result = await generateResume({
    projectRoot,
    dataRoot,
    resumeId: "ai-agent",
    ...makeGenerationHarness()
  });

  assert.equal(result.resumeId, "ai-agent");
  assert.match(readFileSync(result.outputPaths.preview, "utf8"), /AI Candidate/);
  assert.equal(result.outputPaths.preview, path.join(dataRoot, "output", "ai-agent", "preview.html"));
});

test("generateResume rejects unknown resume ids before launching a browser", async () => {
  const { projectRoot, dataRoot } = makeGenerationFixture();
  let launched = false;

  await assert.rejects(() => generateResume({
    projectRoot,
    dataRoot,
    resumeId: "missing",
    launchBrowser: async () => {
      launched = true;
      throw new Error("should not launch");
    }
  }), /Unknown resume id: missing/);
  assert.equal(launched, false);
});

test("parseGenerateArgs supports --resume and rejects malformed arguments", () => {
  assert.deepEqual(parseGenerateArgs([]), {});
  assert.deepEqual(parseGenerateArgs(["--resume", "cpp"]), { resumeId: "cpp" });
  assert.throws(() => parseGenerateArgs(["--resume"]), /--resume requires an id/);
  assert.throws(() => parseGenerateArgs(["--unknown"]), /Unknown argument: --unknown/);
});
