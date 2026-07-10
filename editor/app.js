const areas = [
  ["content", "内容编辑"],
  ["layout", "排版顺序"]
];

const contentModules = [
  ["profile", "基本信息"],
  ["photo", "照片"],
  ["internships", "实习经历"],
  ["skills", "专业技能"],
  ["projects", "项目经历"]
];

const sectionLabels = {
  internships: "实习经历",
  skills: "专业技能",
  projects: "项目经历"
};

const contentModuleLabels = Object.fromEntries(contentModules);

const previewPathLabels = {
  "profile.name": "姓名",
  "profile.target": "求职意向",
  "profile.school": "学校",
  "profile.major": "专业",
  "profile.phone": "电话",
  "profile.email": "邮箱"
};

const previewPathModulePrefixes = {
  profile: "profile",
  internships: "internships",
  skills: "skills",
  projects: "projects"
};

const previewSectionModules = {
  profile: "profile",
  photo: "photo",
  internships: "internships",
  skills: "skills",
  projects: "projects"
};

const fieldLabels = {
  start: "开始",
  end: "结束",
  organization: "公司",
  name: "项目名称",
  role: "角色",
  summary: "概述",
  title: "标题",
  linkLabel: "链接文案",
  link: "链接地址"
};

const defaultOrder = ["internships", "skills", "projects"];
const draftPreviewDelayMs = 300;
const draftDensityNames = ["normal", "compact", "tight"];
const fitTolerancePx = 2;
const previewPageSize = {
  width: 794,
  height: 1123,
  maxFrameWidth: 620
};

const generationLabels = {
  "needs generate": "PDF 待生成",
  generating: "生成中",
  generated: "预览已更新",
  error: "生成失败",
  loaded: "预览已更新"
};

const state = {
  activeArea: "content",
  activeModule: "profile",
  resumes: [],
  activeResumeId: "",
  resume: null,
  examples: [],
  backups: [],
  dirty: false,
  generation: "needs generate",
  saveState: "loading",
  busyAction: "",
  density: "--",
  selectedPreviewSection: "",
  selectedPreviewPath: "",
  previewSource: "generated",
  draftPreview: "idle",
  pendingDelete: null,
  dataDialogMode: "",
  dataDialogBusy: false,
  dataDialogError: "",
  selectedDataFile: null,
  pendingImport: null,
  recoverySnapshots: [],
  selectedRecoverySnapshotId: "",
  pendingDraftPreviewMessage: "",
  message: "",
  messageKind: ""
};

const elements = {
  tabs: document.querySelector("#moduleTabs"),
  form: document.querySelector("#editorForm"),
  status: document.querySelector("#statusStrip"),
  message: document.querySelector("#messageLine"),
  preview: document.querySelector("#previewFrame"),
  previewStage: document.querySelector(".preview-stage"),
  previewFrame: document.querySelector(".a4-frame"),
  save: document.querySelector("#saveButton"),
  generate: document.querySelector("#generateButton"),
  refreshPreview: document.querySelector("#refreshPreviewButton"),
  openPdf: document.querySelector("#openPdfButton"),
  exampleSelect: document.querySelector("#exampleSelect"),
  loadExample: document.querySelector("#loadExampleButton"),
  backupSelect: document.querySelector("#backupSelect"),
  restoreBackup: document.querySelector("#restoreBackupButton"),
  resumeSelectButton: document.querySelector("#resumeSelectButton"),
  resumeSelectLabel: document.querySelector("#resumeSelectLabel"),
  resumeSelectMenu: document.querySelector("#resumeSelectMenu"),
  addResume: document.querySelector("#addResumeButton"),
  manageResume: document.querySelector("#manageResumeButton"),
  addResumeMenu: document.querySelector("#addResumeMenu"),
  manageResumeMenu: document.querySelector("#manageResumeMenu"),
  deleteResumeHint: document.querySelector("#deleteResumeHint"),
  dataManager: document.querySelector("#dataManagerButton"),
  dataManagerMenu: document.querySelector("#dataManagerMenu"),
  exportData: document.querySelector("#exportDataButton"),
  importData: document.querySelector("#importDataButton"),
  recoverData: document.querySelector("#recoverDataButton"),
  dataImportInput: document.querySelector("#dataImportInput"),
  currentFile: document.querySelector("#currentFileLabel"),
  dialog: document.querySelector("#resumeDialog"),
  dialogTitle: document.querySelector("#resumeDialogTitle"),
  dialogDescription: document.querySelector("#resumeDialogDescription"),
  dialogClose: document.querySelector("#resumeDialogClose"),
  dialogInputField: document.querySelector("#resumeDialogInputField"),
  dialogInput: document.querySelector("#resumeDialogInput"),
  dialogExampleField: document.querySelector("#resumeDialogExampleField"),
  dialogExample: document.querySelector("#resumeDialogExample"),
  dialogError: document.querySelector("#resumeDialogError"),
  dialogActions: document.querySelector("#resumeDialogActions"),
  dataDialog: document.querySelector("#dataDialog"),
  dataDialogTitle: document.querySelector("#dataDialogTitle"),
  dataDialogBody: document.querySelector("#dataDialogBody"),
  dataDialogError: document.querySelector("#dataDialogError"),
  dataDialogClose: document.querySelector("#dataDialogClose"),
  dataDialogCancel: document.querySelector("#dataDialogCancel"),
  dataDialogPrimary: document.querySelector("#dataDialogPrimary")
};

let draftPreviewTimer = null;
let draftPreviewVersion = 0;
let resolveDialog = null;
let dialogConfig = null;
let dialogReturnFocus = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function attr(value) {
  return escapeHtml(value).replaceAll("\n", " ");
}

function ensureLayout(resume) {
  resume.layout ||= {};
  resume.layout.sectionOrder ||= [...defaultOrder];
  return resume;
}

function activeResumeEntry() {
  return state.resumes.find((resume) => resume.id === state.activeResumeId) || null;
}

function activeResumeUrl(pathname) {
  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}resumeId=${encodeURIComponent(state.activeResumeId)}`;
}

function generatedPreviewUrl() {
  return `/output/${encodeURIComponent(state.activeResumeId)}/preview.html`;
}

function generatedPdfUrl() {
  return `/output/${encodeURIComponent(state.activeResumeId)}/resume.pdf`;
}

function setMessage(message, kind = "") {
  state.message = message;
  state.messageKind = kind;
  renderStatus();
}

function backupMessage(prefix, backup) {
  return backup ? `${prefix}，上一版已备份到 ${backup}` : prefix;
}

function isBusy() {
  return Boolean(state.busyAction);
}

function isPreviewStale() {
  return state.dirty || state.generation === "needs generate";
}

function markDirty() {
  state.dirty = true;
  state.saveState = "unsaved";
  state.generation = "needs generate";
  scheduleDraftPreview();
}

function cancelDraftPreview() {
  clearTimeout(draftPreviewTimer);
  draftPreviewTimer = null;
  draftPreviewVersion += 1;
  state.draftPreview = "idle";
}

function refreshGeneratedPreview() {
  if (!state.activeResumeId) {
    return;
  }
  cancelDraftPreview();
  state.previewSource = "generated";
  elements.preview.removeAttribute("srcdoc");
  elements.preview.src = `${generatedPreviewUrl()}?ts=${Date.now()}`;
}

function showLoadedPreview({ draftOnly = false } = {}) {
  if (draftOnly || state.generation === "needs generate") {
    elements.preview.src = "about:blank";
    scheduleDraftPreview(0);
    return;
  }
  refreshGeneratedPreview();
}

function refreshPreview() {
  if (state.dirty) {
    scheduleDraftPreview(0);
    return;
  }
  refreshGeneratedPreview();
}

function scalePreviewFrame() {
  const scale = Math.min(
    elements.previewFrame.clientWidth / previewPageSize.width,
    elements.previewFrame.clientHeight / previewPageSize.height
  );
  elements.preview.style.transform = `scale(${scale})`;
}

function fitPreviewFrame() {
  const styles = getComputedStyle(elements.previewStage);
  const horizontalPadding = Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight);
  const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
  const availableWidth = elements.previewStage.clientWidth - horizontalPadding;
  const availableHeight = elements.previewStage.clientHeight - verticalPadding;

  if (availableWidth <= 0 || availableHeight <= 0) {
    return;
  }

  const widthFromHeight = availableHeight * previewPageSize.width / previewPageSize.height;
  const frameWidth = Math.floor(Math.min(
    previewPageSize.maxFrameWidth,
    availableWidth,
    widthFromHeight
  ));
  elements.previewFrame.style.width = `${Math.max(1, frameWidth)}px`;
  scalePreviewFrame();
}

function previewDocument() {
  try {
    return elements.preview.contentDocument;
  } catch (_error) {
    return null;
  }
}

function markPreviewSelection() {
  const documentInFrame = previewDocument();
  if (!documentInFrame) {
    return;
  }

  documentInFrame.documentElement.dataset.previewInteractive = "true";
  for (const target of documentInFrame.querySelectorAll("[data-path], [data-section]")) {
    const isSelectedPath = Boolean(state.selectedPreviewPath)
      && target.dataset.path === state.selectedPreviewPath;
    const isSelectedSection = !state.selectedPreviewPath
      && Boolean(state.selectedPreviewSection)
      && target.dataset.section === state.selectedPreviewSection;
    target.classList.toggle("is-preview-selected", isSelectedPath || isSelectedSection);
  }
}

function warnIfPreviewNeedsRegeneration() {
  const documentInFrame = previewDocument();
  if (!documentInFrame?.querySelector("#resume-page") || documentInFrame.querySelector("[data-path]")) {
    return false;
  }

  state.generation = "needs generate";
  setMessage("当前预览由旧版本生成，请点击“生成 PDF”重新生成后再使用定位功能。", "warning");
  return true;
}

function measurePreviewContent(documentInFrame) {
  const resume = documentInFrame.querySelector("#resume-page");
  const pageRect = resume.getBoundingClientRect();
  const contentRect = Array.from(resume.querySelectorAll("*")).reduce((acc, element) => {
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
    pageWidth: Math.ceil(pageRect.width)
  };
}

function nextPreviewFrame(documentInFrame) {
  return new Promise((resolve) => documentInFrame.defaultView.requestAnimationFrame(resolve));
}

async function selectDraftDensity() {
  const documentInFrame = previewDocument();
  if (!documentInFrame?.querySelector("#resume-page")) {
    return null;
  }

  let lastResult = null;
  for (const density of draftDensityNames) {
    documentInFrame.body.dataset.density = density;
    await nextPreviewFrame(documentInFrame);
    const metrics = measurePreviewContent(documentInFrame);
    const verticalOverflow = Math.max(0, metrics.height - metrics.pageHeight);
    const horizontalOverflow = Math.max(0, metrics.width - metrics.pageWidth);
    const overflow = Math.max(verticalOverflow, horizontalOverflow);
    lastResult = { density, metrics, overflow };
    if (overflow <= fitTolerancePx) {
      return lastResult;
    }
  }

  return lastResult;
}

function scheduleDraftPreview(delay = draftPreviewDelayMs) {
  if (!state.resume) {
    return;
  }

  clearTimeout(draftPreviewTimer);
  draftPreviewVersion += 1;
  const version = draftPreviewVersion;
  state.draftPreview = "pending";
  renderStatus();
  draftPreviewTimer = setTimeout(() => renderDraftPreview(version), delay);
}

async function renderDraftPreview(version) {
  draftPreviewTimer = null;
  if (version !== draftPreviewVersion || !state.resume) {
    return;
  }

  state.draftPreview = "rendering";
  renderStatus();
  try {
    const body = await requestJson("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeId: state.activeResumeId, resume: state.resume })
    });
    if (version !== draftPreviewVersion) {
      return;
    }

    state.previewSource = "draft";
    state.draftPreview = "loading";
    elements.preview.srcdoc = body.html;
  } catch (error) {
    if (version !== draftPreviewVersion) {
      return;
    }
    state.draftPreview = "error";
    setMessage(`草稿预览失败：${error.message}`, "error");
  }
}

function previewSelectionPrefix() {
  if (state.previewSource === "draft") {
    return state.dirty ? "当前为未保存草稿；" : "当前为草稿预览，PDF 待生成；";
  }
  return isPreviewStale() ? "这是上一次生成的预览；" : "";
}

function labelForPreviewPath(path, module) {
  if (previewPathLabels[path]) {
    return previewPathLabels[path];
  }

  const parts = path.split(".");
  const index = Number(parts[1]);
  if (Number.isInteger(index) && index >= 0 && sectionLabels[module]) {
    if (parts[2] === "items") {
      const itemIndex = Number(parts[3]);
      return Number.isInteger(itemIndex) && itemIndex >= 0
        ? `${sectionLabels[module]} ${index + 1} 要点 ${itemIndex + 1}`
        : `${sectionLabels[module]} ${index + 1} 要点`;
    }

    if (fieldLabels[parts[2]]) {
      return `${sectionLabels[module]} ${index + 1} ${fieldLabels[parts[2]]}`;
    }

    return `${sectionLabels[module]} ${index + 1}`;
  }

  return contentModuleLabels[module];
}

function focusFormPath(path) {
  if (!path) {
    return false;
  }

  const target = Array.from(elements.form.querySelectorAll("[data-path]"))
    .find((item) => item.dataset.path === path);
  if (!target) {
    return false;
  }

  for (const selected of elements.form.querySelectorAll(".is-form-selected")) {
    selected.classList.remove("is-form-selected");
  }

  target.classList.add("is-form-selected");
  target.scrollIntoView({ block: "center", behavior: "smooth" });

  if (target.matches("input, textarea, select, button")) {
    target.focus({ preventScroll: true });
    return true;
  }

  target.querySelector("input, textarea, select")?.focus({ preventScroll: true });
  return true;
}

function moduleForPreviewTarget(section, path) {
  if (path) {
    const prefix = path.split(".")[0];
    if (previewPathModulePrefixes[prefix]) {
      return previewPathModulePrefixes[prefix];
    }
  }

  return previewSectionModules[section];
}

function selectPreviewSection(section) {
  const module = moduleForPreviewTarget(section, "");
  if (!module) {
    return;
  }

  state.activeArea = "content";
  state.activeModule = module;
  state.selectedPreviewSection = section;
  state.selectedPreviewPath = "";
  renderAll();
  markPreviewSelection();
  elements.form.closest(".form-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  const prefix = previewSelectionPrefix();
  const kind = isPreviewStale() ? "warning" : "ok";
  setMessage(`${prefix}正在编辑：${contentModuleLabels[module]}`, kind);
}

function selectPreviewTarget(section, path) {
  const module = moduleForPreviewTarget(section, path);
  if (!module) {
    return;
  }

  state.activeArea = "content";
  state.activeModule = module;
  state.selectedPreviewSection = section;
  state.selectedPreviewPath = path || "";
  renderAll();
  markPreviewSelection();

  if (path && focusFormPath(path)) {
    const prefix = previewSelectionPrefix();
    const kind = isPreviewStale() ? "warning" : "ok";
    setMessage(`${prefix}正在编辑：${labelForPreviewPath(path, module)}`, kind);
    return;
  }

  elements.form.closest(".form-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
  const prefix = previewSelectionPrefix();
  const kind = isPreviewStale() ? "warning" : "ok";
  setMessage(`${prefix}正在编辑：${contentModuleLabels[module]}`, kind);
}

function friendlyError(message, url = "") {
  const text = String(message || "");

  if (text.includes("Failed to fetch")) {
    return "无法连接本地编辑器服务，请确认 npm run editor 还在运行。";
  }

  if (text.includes("Unexpected end of JSON input") || text.includes("is not valid JSON")) {
    return "本地编辑器接口返回异常，请刷新页面；如果仍然出现，请重启 npm run editor。";
  }

  if (text.includes("Photo file not found:")) {
    return `${text}。请在照片模块重新上传照片。`;
  }

  if (text.includes("Content does not fit one A4 page after tight profile")) {
    return `${text} 请优先缩短最长模块，或减少 1-2 条 bullet。`;
  }

  if (/^profile\.[a-zA-Z]+ is required$/.test(text)) {
    return `必填字段缺失：${text.replace(" is required", "")}。请回到基本信息补全。`;
  }

  if (url.startsWith("/api/") && text === "Not found") {
    return "编辑器前端和后端版本不一致，请在终端按 Ctrl+C 停止后重新运行 npm run editor。";
  }

  return text || "操作失败。";
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(friendlyError(error.message, url));
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = (await response.text()).trim();
    throw new Error(friendlyError(text || `Request failed: ${response.status}`, url));
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(friendlyError(error.message, url));
  }

  if (!response.ok || !body.ok) {
    throw new Error(friendlyError(body.error || `Request failed: ${response.status}`, url));
  }
  return body;
}

function closeResumeMenus() {
  elements.addResumeMenu.hidden = true;
  elements.manageResumeMenu.hidden = true;
  elements.dataManagerMenu.hidden = true;
  elements.dataManager.setAttribute("aria-expanded", "false");
}

function closeResumeSelectMenu(returnFocus = false) {
  elements.resumeSelectMenu.hidden = true;
  elements.resumeSelectButton.setAttribute("aria-expanded", "false");
  if (returnFocus) {
    elements.resumeSelectButton.focus();
  }
}

function openResumeSelectMenu() {
  if (elements.resumeSelectButton.disabled) {
    return;
  }

  closeResumeMenus();
  elements.resumeSelectMenu.hidden = false;
  elements.resumeSelectButton.setAttribute("aria-expanded", "true");
  const selected = elements.resumeSelectMenu.querySelector("[aria-selected='true']");
  (selected || elements.resumeSelectMenu.querySelector("[role='option']"))?.focus();
}

function toggleResumeSelectMenu() {
  if (elements.resumeSelectMenu.hidden) {
    openResumeSelectMenu();
    return;
  }
  closeResumeSelectMenu(true);
}

function toggleResumeMenu(menu) {
  const shouldOpen = menu.hidden;
  closeResumeMenus();
  menu.hidden = !shouldOpen;
  if (menu === elements.dataManagerMenu) {
    elements.dataManager.setAttribute("aria-expanded", String(shouldOpen));
  }
}

function normalizedDisplayName(value) {
  return String(value || "").trim().normalize("NFKC").toLowerCase();
}

function resumeNameValidation(value, excludeId = "") {
  const name = String(value || "").trim();
  if (!name) {
    return "请输入简历名称。";
  }

  const normalized = normalizedDisplayName(name);
  if (state.resumes.some((resume) => resume.id !== excludeId && normalizedDisplayName(resume.name) === normalized)) {
    return "已有同名简历，请换一个名称。";
  }

  return "";
}

function closeResumeDialog(result = { action: "cancel" }) {
  if (!elements.dialog.open) {
    return;
  }

  const resolve = resolveDialog;
  const returnFocus = dialogReturnFocus;
  resolveDialog = null;
  dialogConfig = null;
  dialogReturnFocus = null;
  elements.dialog.close();
  resolve?.(result);
  queueMicrotask(() => returnFocus?.focus());
}

function showResumeDialog(config) {
  const focused = document.activeElement;
  const resumeAction = focused?.dataset?.resumeAction;
  closeResumeMenus();
  if (elements.dialog.open) {
    closeResumeDialog();
  }
  dialogReturnFocus = config.returnFocus
    || (["duplicate", "from-example"].includes(resumeAction) ? elements.addResume : null)
    || (["rename", "delete"].includes(resumeAction) ? elements.manageResume : null)
    || focused;

  dialogConfig = config;
  elements.dialogTitle.textContent = config.title;
  elements.dialogDescription.textContent = config.description || "";
  elements.dialogError.textContent = "";
  elements.dialogInputField.hidden = !config.input;
  elements.dialogInput.value = config.input?.value || "";
  elements.dialogExampleField.hidden = !config.example;
  elements.dialogExample.innerHTML = state.examples
    .map((example) => `<option value="${attr(example.id)}">${escapeHtml(example.label)}</option>`)
    .join("");
  if (config.example?.value) {
    elements.dialogExample.value = config.example.value;
  }
  elements.dialogActions.innerHTML = config.actions.map((action) => {
    const className = action.kind === "danger"
      ? "dialog-danger-button"
      : action.kind === "primary"
        ? "dialog-primary-button"
        : "dialog-secondary-button";
    return `<button class="${className}" type="button" data-dialog-action="${attr(action.id)}">${escapeHtml(action.label)}</button>`;
  }).join("");

  elements.dialog.showModal();
  queueMicrotask(() => {
    if (config.input) {
      elements.dialogInput.focus();
      elements.dialogInput.select();
      return;
    }
    elements.dialogActions.querySelector("button")?.focus();
  });

  return new Promise((resolve) => {
    resolveDialog = resolve;
  });
}

function completeDialogAction(action) {
  if (!dialogConfig) {
    return;
  }

  if (dialogConfig.input && dialogConfig.validatedActions?.includes(action)) {
    const validationError = resumeNameValidation(elements.dialogInput.value, dialogConfig.excludeId);
    if (validationError) {
      elements.dialogError.textContent = validationError;
      elements.dialogInput.focus();
      return;
    }
  }

  closeResumeDialog({
    action,
    name: elements.dialogInput.value.trim(),
    exampleId: elements.dialogExample.value
  });
}

function formatFileSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDataPackageDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "--");
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const recoveryInvalidLabels = {
  "invalid-data": "数据文件无效，无法恢复",
  "unsafe-tree": "存在不安全文件，无法恢复",
  "missing-data": "数据不完整，无法恢复"
};

function recoveryTypeLabel(type) {
  return type === "pre-import" ? "导入前备份" : "恢复前备份";
}

function selectedRecoverySnapshot() {
  return state.recoverySnapshots.find((snapshot) => (
    snapshot.valid && snapshot.id === state.selectedRecoverySnapshotId
  )) || null;
}

function recoveryInvalidLabel(code) {
  return recoveryInvalidLabels[code] || "数据不可用，无法恢复";
}

function renderRecoveryDetail(snapshot) {
  if (!snapshot) {
    return "";
  }
  return `
    <section class="recovery-snapshot-detail" aria-label="所选历史数据详情">
      <p><strong>${escapeHtml(recoveryTypeLabel(snapshot.type))}</strong>，包含 ${escapeHtml(snapshot.resumeCount)} 份简历</p>
      <ul class="data-resume-list">
        ${(snapshot.resumes || []).map((resume) => `
          <li><span>${escapeHtml(resume.name)}</span><span>${escapeHtml(resume.id)}</span></li>
        `).join("")}
      </ul>
    </section>
  `;
}

function safeRecoveryRequestError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("changed")) {
    return "所选恢复数据已发生变化，请重新读取后再试。";
  }
  if (message.includes("not found")) {
    return "所选恢复数据不存在，请重新读取后再试。";
  }
  if (message.includes("not valid") || message.includes("invalid")) {
    return "所选恢复数据不可用，请选择其他记录。";
  }
  if (message.includes("in progress") || message.includes("locked")) {
    return "当前有其他数据操作正在进行，请稍后重试。";
  }
  return "操作未完成，请稍后重试。";
}

function safeBackupName(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).at(-1) || "恢复前备份";
}

function renderDataDialog() {
  const mode = state.dataDialogMode;
  const file = state.selectedDataFile;
  const pending = state.pendingImport;
  elements.dataDialogError.textContent = state.dataDialogError;
  elements.dataDialogClose.disabled = state.dataDialogBusy;
  elements.dataDialogCancel.disabled = state.dataDialogBusy;
  elements.dataDialogPrimary.disabled = state.dataDialogBusy;
  elements.dataDialogPrimary.hidden = false;
  elements.dataDialog.setAttribute("aria-busy", String(state.dataDialogBusy));

  if (mode.startsWith("recovery-") || mode === "recovering") {
    const selected = selectedRecoverySnapshot();
    elements.dataDialogTitle.textContent = "恢复历史数据";

    if (mode === "recovery-loading") {
      elements.dataDialogBody.innerHTML = "<p class=\"data-dialog-status\">正在读取恢复历史...</p>";
      elements.dataDialogPrimary.textContent = "读取中";
      elements.dataDialogPrimary.disabled = true;
      return;
    }

    if (mode === "recovery-error") {
      elements.dataDialogBody.innerHTML = "<p>恢复历史暂时无法读取，当前已保存数据没有发生变化。</p>";
      elements.dataDialogPrimary.textContent = "重试";
      return;
    }

    if (mode === "recovery-list") {
      if (state.recoverySnapshots.length === 0) {
        elements.dataDialogBody.innerHTML = "<p class=\"recovery-empty-state\">暂无可恢复的历史数据。</p>";
        elements.dataDialogPrimary.hidden = true;
        return;
      }

      elements.dataDialogBody.innerHTML = `
        <p>选择一份历史数据查看其中的简历，再继续确认恢复。</p>
        <div class="recovery-snapshot-list" aria-label="恢复历史数据列表">
          ${state.recoverySnapshots.map((snapshot) => {
            const isValid = Boolean(snapshot.valid);
            const isSelected = isValid && snapshot.id === state.selectedRecoverySnapshotId;
            const summary = isValid
              ? `${snapshot.resumeCount} 份简历 · 当前：${snapshot.activeResumeName || snapshot.activeResumeId || "--"}`
              : recoveryInvalidLabel(snapshot.code);
            return `
              <button
                class="recovery-snapshot-row${isSelected ? " is-selected" : ""}${isValid ? "" : " is-invalid"}"
                type="button"
                data-snapshot-id="${attr(snapshot.id)}"
                aria-pressed="${isSelected}"
                ${isValid ? "" : "aria-disabled=\"true\" disabled"}
              >
                <span class="recovery-snapshot-heading">
                  <strong>${escapeHtml(recoveryTypeLabel(snapshot.type))}</strong>
                  <time>${escapeHtml(formatDataPackageDate(snapshot.createdAt))}</time>
                </span>
                <span class="recovery-snapshot-summary">${escapeHtml(summary)}</span>
              </button>
            `;
          }).join("")}
        </div>
        ${renderRecoveryDetail(selected)}
      `;
      elements.dataDialogPrimary.textContent = "继续";
      elements.dataDialogPrimary.disabled = !selected;
      return;
    }

    elements.dataDialogBody.innerHTML = `
      ${renderRecoveryDetail(selected)}
      <p class="data-privacy-note">确认后，全部已保存数据（简历、照片、备份和配置）将被所选历史数据替换。当前数据会自动保留为恢复前备份。</p>
      ${mode === "recovering" ? "<p class=\"data-dialog-status\">正在保留当前数据并恢复...</p>" : ""}
    `;
    elements.dataDialogPrimary.textContent = mode === "recovering" ? "正在恢复" : "确认恢复";
    elements.dataDialogPrimary.disabled = state.dataDialogBusy || !selected;
    return;
  }

  if (mode === "export") {
    elements.dataDialogTitle.textContent = "导出数据包";
    elements.dataDialogBody.innerHTML = `
      <p class="data-privacy-note">数据包包含个人信息、联系方式和照片，并且未加密。请只保存到可信位置。</p>
      <p>导出包含全部已保存简历、照片和备份，不包含可重新生成的 PDF、PNG 和 HTML。</p>
    `;
    elements.dataDialogPrimary.textContent = "确认导出";
    return;
  }

  elements.dataDialogTitle.textContent = "导入数据包";
  const fileSummary = file ? `
    <dl class="data-file-summary">
      <dt>文件</dt><dd>${escapeHtml(file.name)}</dd>
      <dt>大小</dt><dd>${escapeHtml(formatFileSize(file.size))}</dd>
    </dl>
  ` : "";

  if (mode === "inspecting") {
    elements.dataDialogBody.innerHTML = `
      ${fileSummary}
      <p class="data-dialog-status">正在检查数据包完整性...</p>
    `;
    elements.dataDialogPrimary.textContent = "检查中";
    elements.dataDialogPrimary.disabled = true;
    return;
  }

  if (mode === "import-error") {
    elements.dataDialogBody.innerHTML = `
      ${fileSummary}
      <p>数据包未通过检查，当前简历数据没有发生变化。</p>
    `;
    elements.dataDialogPrimary.textContent = "重新选择";
    return;
  }

  if (mode === "import-ready" || mode === "committing") {
    const summary = pending.summary;
    elements.dataDialogBody.innerHTML = `
      ${fileSummary}
      <dl class="data-file-summary">
        <dt>创建时间</dt><dd>${escapeHtml(formatDataPackageDate(summary.createdAt))}</dd>
        <dt>格式版本</dt><dd>V${escapeHtml(summary.formatVersion)}</dd>
        <dt>内容</dt><dd>${escapeHtml(summary.resumeCount)} 份简历</dd>
        <dt>活动简历</dt><dd>${escapeHtml(summary.activeResumeId)}</dd>
      </dl>
      <ul class="data-resume-list">
        ${summary.resumes.map((resume) => `
          <li><span>${escapeHtml(resume.name)}</span><span>${escapeHtml(resume.id)}</span></li>
        `).join("")}
      </ul>
      <p class="data-privacy-note">确认后将整套替换当前已保存数据。当前数据会自动保留为导入前备份。</p>
      ${mode === "committing" ? "<p class=\"data-dialog-status\">正在备份并导入...</p>" : ""}
    `;
    elements.dataDialogPrimary.textContent = mode === "committing" ? "正在导入" : "确认导入";
  }
}

function openDataDialog(mode) {
  closeResumeMenus();
  closeResumeSelectMenu();
  state.dataDialogMode = mode;
  state.dataDialogError = "";
  renderDataDialog();
  if (!elements.dataDialog.open) {
    elements.dataDialog.showModal();
  }
  queueMicrotask(() => elements.dataDialogPrimary.focus());
}

function closeDataDialog({ cancelPending = true } = {}) {
  if (state.dataDialogBusy) {
    return;
  }
  const token = cancelPending ? state.pendingImport?.token : "";
  state.pendingImport = null;
  state.selectedDataFile = null;
  state.recoverySnapshots = [];
  state.selectedRecoverySnapshotId = "";
  state.dataDialogMode = "";
  state.dataDialogError = "";
  elements.dataImportInput.value = "";
  if (elements.dataDialog.open) {
    elements.dataDialog.close();
  }
  if (token) {
    void requestJson(`/api/data/import/${encodeURIComponent(token)}`, {
      method: "DELETE"
    }).catch(() => {});
  }
  queueMicrotask(() => elements.dataManager.focus());
}

function beginDataExport() {
  const link = document.createElement("a");
  link.href = "/api/data/export";
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  closeDataDialog({ cancelPending: false });
  setMessage(`已开始导出 ${state.resumes.length} 份简历`, "ok");
}

function requestDataImport() {
  closeResumeMenus();
  if (state.dirty) {
    setMessage("导入前请先保存或撤销当前修改", "warning");
    elements.save.focus();
    return;
  }
  elements.dataImportInput.value = "";
  elements.dataImportInput.click();
}

async function requestDataRecovery() {
  closeResumeMenus();
  if (state.dirty) {
    setMessage("恢复前请先保存或撤销当前修改", "warning");
    elements.save.focus();
    return;
  }

  state.recoverySnapshots = [];
  state.selectedRecoverySnapshotId = "";
  openDataDialog("recovery-loading");
  try {
    const body = await requestJson("/api/data/recovery/snapshots");
    if (state.dataDialogMode !== "recovery-loading") {
      return;
    }
    state.recoverySnapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
    state.dataDialogMode = "recovery-list";
    state.dataDialogError = "";
  } catch (_error) {
    if (state.dataDialogMode !== "recovery-loading") {
      return;
    }
    state.dataDialogMode = "recovery-error";
    state.dataDialogError = "读取恢复历史失败，请稍后重试。";
  }
  renderDataDialog();
}

async function inspectDataImport(file) {
  if (!file || isBusy()) {
    return;
  }
  state.selectedDataFile = file;
  state.pendingImport = null;
  state.dataDialogBusy = true;
  openDataDialog("inspecting");
  renderDataDialog();
  setBusy("inspecting-import");
  try {
    const body = await requestJson("/api/data/import/inspect", {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file
    });
    state.pendingImport = body;
    state.dataDialogMode = "import-ready";
    state.dataDialogError = "";
  } catch (error) {
    state.dataDialogMode = "import-error";
    state.dataDialogError = `检查失败：${error.message}`;
  } finally {
    state.dataDialogBusy = false;
    setBusy("");
    renderDataDialog();
  }
}

async function commitDataImport() {
  if (!state.pendingImport || state.dataDialogBusy || isBusy()) {
    return;
  }
  state.dataDialogBusy = true;
  state.dataDialogMode = "committing";
  state.dataDialogError = "";
  renderDataDialog();
  setBusy("committing-import");
  try {
    const body = await requestJson("/api/data/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: state.pendingImport.token })
    });
    applyRegistry(body);
    state.pendingImport = null;
    state.dataDialogBusy = false;
    closeDataDialog({ cancelPending: false });
    const importMessage = `导入完成，旧数据已保留到 ${body.preImportBackup}`;
    state.pendingDraftPreviewMessage = importMessage;
    await loadSelectedResume({ draftOnly: true });
    setMessage(importMessage, "ok");
  } catch (error) {
    state.pendingDraftPreviewMessage = "";
    state.dataDialogMode = "import-ready";
    state.dataDialogError = `导入失败：${error.message}`;
  } finally {
    state.dataDialogBusy = false;
    setBusy("");
    if (elements.dataDialog.open) {
      renderDataDialog();
    }
  }
}

async function commitDataRecovery() {
  const snapshot = selectedRecoverySnapshot();
  if (state.dirty) {
    closeDataDialog({ cancelPending: false });
    setMessage("恢复前请先保存或撤销当前修改", "warning");
    queueMicrotask(() => elements.save.focus());
    return;
  }
  if (!snapshot || state.dataDialogBusy || isBusy()) {
    return;
  }

  state.dataDialogBusy = true;
  state.dataDialogMode = "recovering";
  state.dataDialogError = "";
  renderDataDialog();
  setBusy("recovering-data");
  try {
    const body = await requestJson("/api/data/recovery/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: snapshot.id })
    });
    applyRegistry(body);
    const recoveryMessage = `恢复完成，当前数据已保留到 ${safeBackupName(body.preRestoreBackup)}`;
    state.pendingDraftPreviewMessage = recoveryMessage;
    state.dataDialogBusy = false;
    closeDataDialog({ cancelPending: false });
    await loadSelectedResume({ draftOnly: true });
    setMessage(recoveryMessage, "ok");
  } catch (error) {
    state.pendingDraftPreviewMessage = "";
    state.dataDialogMode = "recovery-confirm";
    state.dataDialogError = `恢复失败：${safeRecoveryRequestError(error)}`;
  } finally {
    state.dataDialogBusy = false;
    setBusy("");
    if (elements.dataDialog.open) {
      renderDataDialog();
    }
  }
}

function setBusy(action) {
  state.busyAction = action;
  renderStatus();
  renderBackups();
}

async function withBusy(action, task) {
  if (isBusy()) {
    return null;
  }

  setBusy(action);
  try {
    return await task();
  } finally {
    setBusy("");
  }
}

function applyRegistry(body) {
  state.resumes = body.resumes || [];
  state.activeResumeId = body.activeId || state.activeResumeId;
}

async function loadResumes() {
  const body = await requestJson("/api/resumes");
  applyRegistry(body);
  renderResumeSelector();
}

async function loadResume() {
  const body = await requestJson(activeResumeUrl("/api/resume"));
  state.resume = ensureLayout(body.resume);
  state.dirty = false;
  state.saveState = "saved";
  state.generation = body.generatedPreviewAvailable === false ? "needs generate" : "loaded";
  renderAll();
  if (!warnIfPreviewNeedsRegeneration()) {
    setMessage(`已读取 ${activeResumeEntry()?.file || "简历"}`, "ok");
  }
}

async function loadExamples() {
  const body = await requestJson("/api/examples");
  state.examples = body.examples;
  elements.exampleSelect.innerHTML = state.examples
    .map((example) => `<option value="${attr(example.id)}">${escapeHtml(example.label)}</option>`)
    .join("");
}

function renderBackups() {
  const busy = isBusy();
  if (state.backups.length === 0) {
    elements.backupSelect.innerHTML = "<option value=\"\">暂无备份</option>";
    elements.restoreBackup.disabled = true;
    elements.backupSelect.disabled = busy;
    return;
  }

  elements.backupSelect.innerHTML = state.backups
    .map((backup) => `<option value="${attr(backup.file)}">${escapeHtml(backup.label)}</option>`)
    .join("");
  elements.restoreBackup.disabled = busy;
  elements.backupSelect.disabled = busy;
}

async function loadBackups() {
  const body = await requestJson(activeResumeUrl("/api/backups"));
  state.backups = body.backups || [];
  renderBackups();
}

function renderResumeSelector() {
  elements.resumeSelectMenu.innerHTML = state.resumes
    .map((resume) => {
      const isSelected = resume.id === state.activeResumeId;
      return `
        <button class="resume-select-option" type="button" role="option" data-resume-id="${attr(resume.id)}" aria-selected="${isSelected}">
          <span class="resume-select-option-check" aria-hidden="true">${isSelected ? "✓" : ""}</span>
          <span class="resume-select-option-label">${escapeHtml(resume.name)}</span>
        </button>
      `;
    })
    .join("");
  const current = activeResumeEntry();
  elements.resumeSelectLabel.textContent = current?.name || "暂无简历";
  elements.resumeSelectButton.dataset.value = state.activeResumeId;
  elements.currentFile.textContent = current?.file || "resumes/--.yaml";
  elements.resumeSelectButton.disabled = isBusy() || state.resumes.length === 0;
  if (elements.resumeSelectButton.disabled) {
    closeResumeSelectMenu();
  }
  elements.addResume.disabled = isBusy() || !state.activeResumeId;
  elements.manageResume.disabled = isBusy() || !state.activeResumeId;
  elements.dataManager.disabled = isBusy();
  if (elements.dataManager.disabled) {
    closeResumeMenus();
  }
}

function renderAll() {
  renderResumeSelector();
  renderTabs();
  renderForm();
  renderStatus();
  renderBackups();
}

function renderTabs() {
  elements.tabs.innerHTML = `
    <div class="area-button-grid">
      ${areas.map(([id, label]) => `
        <button class="area-button" type="button" data-area="${attr(id)}" aria-selected="${id === state.activeArea}">
          ${escapeHtml(label)}
        </button>
      `).join("")}
    </div>
    ${state.activeArea === "content" ? `
      <div class="module-group">
        <div class="module-group-title">内容模块</div>
        <div class="module-button-grid">
          ${contentModules.map(([id, label]) => `
            <button class="tab-button" type="button" data-module="${attr(id)}" aria-selected="${id === state.activeModule}">
              ${escapeHtml(label)}
            </button>
          `).join("")}
        </div>
      </div>
    ` : ""}
  `;
}

function renderStatus() {
  const busy = isBusy();
  const saveClass = state.dirty ? "is-dirty" : "is-ok";
  const draftLabels = {
    pending: "预览更新中",
    rendering: "预览更新中",
    loading: "预览更新中",
    ready: "草稿预览",
    overflow: "草稿超出 A4",
    error: "草稿预览失败"
  };
  const showingDraftState = state.dirty && draftLabels[state.draftPreview];
  const generationLabel = showingDraftState
    ? draftLabels[state.draftPreview]
    : generationLabels[state.generation] || state.generation;
  const generationClass = state.draftPreview === "error" || state.draftPreview === "overflow"
    ? "is-error"
    : state.dirty || state.generation === "needs generate"
      ? "is-warning"
    : state.generation === "generated" || state.generation === "loaded"
    ? "is-ok"
    : state.generation === "error"
      ? "is-error"
      : "";
  elements.status.innerHTML = [
    `<span>密度：${escapeHtml(state.density)}</span>`,
    "<span>A4 单页</span>",
    `<span class="${saveClass}">${state.dirty ? "未保存" : "已保存"}</span>`,
    `<span class="${generationClass}">${escapeHtml(generationLabel)}</span>`
  ].join("");
  elements.message.className = `message-line ${state.messageKind ? `is-${state.messageKind}` : ""}`;
  elements.message.textContent = state.message;
  elements.save.disabled = !state.resume || !state.dirty || busy;
  elements.save.textContent = state.busyAction === "saving" ? "保存中" : "保存";
  elements.generate.disabled = !state.resume || state.dirty || state.generation === "generating" || busy;
  elements.generate.textContent = state.dirty
    ? "保存后生成"
    : state.generation === "generated" || state.generation === "loaded"
      ? "重新生成预览"
      : state.generation === "generating"
        ? "生成中"
        : "生成 PDF";
  elements.loadExample.disabled = busy;
  elements.exampleSelect.disabled = busy;
  renderResumeSelector();
}

function field(path, label, value, options = {}) {
  const tag = options.multiline ? "textarea" : "input";
  const readonly = options.readonly ? " readonly" : "";
  const rows = options.multiline ? " rows=\"3\"" : "";
  const valueMarkup = options.multiline
    ? `${escapeHtml(value)}</textarea>`
    : ` value="${attr(value)}">`;
  return `
    <div class="field-row">
      <label>${escapeHtml(label)}</label>
      <${tag} data-path="${attr(path)}"${readonly}${rows}${options.multiline ? `>${valueMarkup}` : valueMarkup}
    </div>
  `;
}

function renderForm() {
  if (!state.resume) {
    elements.form.innerHTML = "";
    return;
  }

  if (state.activeArea === "layout") {
    elements.form.innerHTML = renderLayout();
    return;
  }

  const renderers = {
    profile: renderProfile,
    photo: renderPhoto,
    internships: () => renderExperiences("internships"),
    skills: renderSkills,
    projects: () => renderExperiences("projects")
  };

  elements.form.innerHTML = renderers[state.activeModule]();
}

function renderProfile() {
  const profile = state.resume.profile;
  return `
    <section class="form-section">
      <div class="section-heading"><h2>基本信息</h2></div>
      <div class="field-grid">
        ${field("profile.name", "姓名", profile.name)}
        ${field("profile.target", "求职意向", profile.target)}
        ${field("profile.school", "学校", profile.school)}
        ${field("profile.major", "专业", profile.major)}
        <div class="two-col">
          ${field("profile.phone", "电话", profile.phone)}
          ${field("profile.email", "邮箱", profile.email)}
        </div>
        ${field("profile.photo", "照片路径", profile.photo, { readonly: true })}
      </div>
    </section>
  `;
}

function renderPhoto() {
  const photo = state.resume.profile.photo;
  return `
    <section class="form-section">
      <div class="section-heading"><h2>照片</h2></div>
      <div class="photo-panel">
        <img class="photo-preview" src="/${attr(photo)}?ts=${Date.now()}" alt="当前照片">
        <div class="field-row">
          <label>当前路径</label>
          <input value="${attr(photo)}" readonly>
        </div>
        <div class="field-row">
          <label>替换照片</label>
          <input type="file" id="photoInput" accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml">
        </div>
      </div>
    </section>
  `;
}

function renderExperiences(key) {
  const isProject = key === "projects";
  const entries = state.resume[key] || [];
  return `
    <section class="form-section">
      <div class="section-heading">
        <h2>${escapeHtml(sectionLabels[key])}</h2>
        <button class="ghost-button" type="button" data-action="add-experience" data-key="${attr(key)}">新增</button>
      </div>
      ${entries.map((entry, index) => renderExperience(key, entry, index, isProject)).join("")}
    </section>
  `;
}

function renderExperience(key, entry, index, isProject) {
  const titlePath = isProject ? `${key}.${index}.name` : `${key}.${index}.organization`;
  const titleLabel = isProject ? "项目名称" : "公司";
  return `
    <article class="item-block" data-path="${attr(`${key}.${index}`)}">
      <div class="item-header">
        <h3 class="item-title">${escapeHtml(entry.name || entry.organization || `${sectionLabels[key]} ${index + 1}`)}</h3>
        ${rowActions("experience", key, index)}
      </div>
      ${deleteConfirmPanel("experience", key, index)}
      <div class="two-col">
        ${field(`${key}.${index}.start`, "开始", entry.start)}
        ${field(`${key}.${index}.end`, "结束", entry.end)}
      </div>
      ${field(titlePath, titleLabel, isProject ? entry.name : entry.organization)}
      ${field(`${key}.${index}.role`, "角色", entry.role)}
      ${field(`${key}.${index}.summary`, "概述", entry.summary, { multiline: true })}
      ${renderBullets(key, index, entry.items || [])}
      ${field(`${key}.${index}.linkLabel`, "链接文案", entry.linkLabel)}
      ${field(`${key}.${index}.link`, "链接地址", entry.link)}
    </article>
  `;
}

function renderSkills() {
  const groups = state.resume.skills || [];
  return `
    <section class="form-section">
      <div class="section-heading">
        <h2>专业技能</h2>
        <button class="ghost-button" type="button" data-action="add-skill">新增</button>
      </div>
      ${groups.map((group, index) => `
        <article class="item-block" data-path="${attr(`skills.${index}`)}">
          <div class="item-header">
            <h3 class="item-title">${escapeHtml(group.title || `技能组 ${index + 1}`)}</h3>
            ${rowActions("skill", "skills", index)}
          </div>
          ${deleteConfirmPanel("skill", "skills", index)}
          ${field(`skills.${index}.title`, "标题", group.title)}
          ${renderBullets("skills", index, group.items || [])}
        </article>
      `).join("")}
    </section>
  `;
}

function renderBullets(key, parentIndex, items) {
  return `
    <div class="field-grid">
      <div class="subsection-heading">
        <h3>要点</h3>
        <button class="ghost-button" type="button" data-action="add-bullet" data-key="${attr(key)}" data-index="${parentIndex}">新增要点</button>
      </div>
      <div class="bullet-list">
        ${items.map((item, itemIndex) => `
          <div class="bullet-item">
            <div class="bullet-row">
              <textarea data-path="${attr(`${key}.${parentIndex}.items.${itemIndex}`)}" rows="2">${escapeHtml(item)}</textarea>
              ${rowActions("bullet", key, parentIndex, itemIndex)}
            </div>
            ${deleteConfirmPanel("bullet", key, parentIndex, itemIndex)}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderLayout() {
  const order = state.resume.layout.sectionOrder || defaultOrder;
  return `
    <section class="form-section">
      <div class="section-heading"><h2>排版顺序</h2></div>
      ${order.map((section, index) => `
        <div class="layout-row">
          <strong>${escapeHtml(sectionLabels[section])}</strong>
          <div class="row-actions">
            <button class="row-action-button" type="button" data-action="move-layout" data-index="${index}" data-direction="-1" title="上移"><span aria-hidden="true">↑</span><span>上移</span></button>
            <button class="row-action-button" type="button" data-action="move-layout" data-index="${index}" data-direction="1" title="下移"><span aria-hidden="true">↓</span><span>下移</span></button>
          </div>
        </div>
      `).join("")}
    </section>
  `;
}

function rowActions(kind, key, index, itemIndex = "") {
  return `
    <div class="row-actions row-actions-${attr(kind)}">
      <button class="row-action-button" type="button" data-action="move-${kind}" data-key="${attr(key)}" data-index="${index}" data-item-index="${itemIndex}" data-direction="-1" title="上移"><span aria-hidden="true">↑</span><span>上移</span></button>
      <button class="row-action-button" type="button" data-action="move-${kind}" data-key="${attr(key)}" data-index="${index}" data-item-index="${itemIndex}" data-direction="1" title="下移"><span aria-hidden="true">↓</span><span>下移</span></button>
      <button class="row-action-button danger-button" type="button" data-action="delete-${kind}" data-key="${attr(key)}" data-index="${index}" data-item-index="${itemIndex}" title="删除"><span aria-hidden="true">×</span><span>删除</span></button>
    </div>
  `;
}

function deleteConfirmPanel(kind, key, index, itemIndex = "") {
  if (!isPendingDelete(kind, key, index, itemIndex)) {
    return "";
  }

  const itemIndexAttr = attr(itemIndex);
  const noun = kind === "bullet"
    ? "这条要点"
    : key === "skills"
      ? "这个技能组"
      : "这段经历";
  return `
    <div class="delete-confirm-panel">
      <span>确认删除${escapeHtml(noun)}？</span>
      <div class="delete-confirm-actions">
        <button class="danger-confirm-button" type="button" data-action="confirm-delete" data-kind="${attr(kind)}" data-key="${attr(key)}" data-index="${index}" data-item-index="${itemIndexAttr}">确认删除</button>
        <button class="quiet-button" type="button" data-action="cancel-delete" data-kind="${attr(kind)}" data-key="${attr(key)}" data-index="${index}" data-item-index="${itemIndexAttr}">取消</button>
      </div>
    </div>
  `;
}

function normalizedItemIndex(itemIndex) {
  return itemIndex === "" || Number.isNaN(itemIndex) ? "" : Number(itemIndex);
}

function isPendingDelete(kind, key, index, itemIndex = "") {
  const pending = state.pendingDelete;
  return Boolean(pending)
    && pending.kind === kind
    && pending.key === key
    && pending.index === Number(index)
    && String(pending.itemIndex) === String(normalizedItemIndex(itemIndex));
}

function setPendingDelete(kind, key, index, itemIndex = "") {
  state.pendingDelete = {
    kind,
    key,
    index: Number(index),
    itemIndex: normalizedItemIndex(itemIndex)
  };
  renderForm();
  focusFormControl(`[data-action="confirm-delete"][data-kind="${kind}"][data-key="${key}"][data-index="${index}"][data-item-index="${state.pendingDelete.itemIndex}"]`);
}

function focusFormControl(selector) {
  const target = elements.form.querySelector(selector);
  if (!target) {
    return false;
  }

  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.focus({ preventScroll: true });
  return true;
}

function setPath(path, value) {
  const parts = path.split(".");
  let current = state.resume;
  while (parts.length > 1) {
    const part = parts.shift();
    current = current[Number.isInteger(Number(part)) ? Number(part) : part];
  }
  const finalPart = parts[0];
  current[Number.isInteger(Number(finalPart)) ? Number(finalPart) : finalPart] = value;
}

function moveItem(array, index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= array.length) {
    return;
  }
  const [item] = array.splice(index, 1);
  array.splice(nextIndex, 0, item);
  state.pendingDelete = null;
  markDirty();
  renderForm();
}

function focusAddButtonForCollection(key) {
  const selector = key === "skills"
    ? '[data-action="add-skill"]'
    : `[data-action="add-experience"][data-key="${key}"]`;
  focusFormControl(selector);
}

function focusAfterCollectionDelete(key, index) {
  const entries = state.resume[key] || [];
  if (entries.length === 0) {
    focusAddButtonForCollection(key);
    return;
  }

  const nextIndex = Math.min(index, entries.length - 1);
  focusFormPath(`${key}.${nextIndex}`);
}

function focusAfterBulletDelete(key, index, itemIndex) {
  const items = state.resume[key]?.[index]?.items || [];
  if (items.length === 0) {
    focusFormControl(`[data-action="add-bullet"][data-key="${key}"][data-index="${index}"]`);
    return;
  }

  const nextItemIndex = Math.min(itemIndex, items.length - 1);
  focusFormPath(`${key}.${index}.items.${nextItemIndex}`);
}

function confirmDelete(pending) {
  if (!pending) {
    return;
  }

  state.pendingDelete = null;
  if (pending.kind === "bullet") {
    state.resume[pending.key][pending.index].items.splice(pending.itemIndex, 1);
    markDirty();
    renderForm();
    focusAfterBulletDelete(pending.key, pending.index, pending.itemIndex);
    return;
  }

  state.resume[pending.key].splice(pending.index, 1);
  markDirty();
  renderForm();
  focusAfterCollectionDelete(pending.key, pending.index);
}

function newExperience(key) {
  const entry = {
    start: "",
    end: "",
    role: "",
    summary: "",
    items: [""],
    linkLabel: "项目代码链接",
    link: ""
  };
  if (key === "projects") {
    entry.name = "";
  } else {
    entry.organization = "";
  }
  return entry;
}

function handleAction(button) {
  const action = button.dataset.action;
  const kind = button.dataset.kind || action.replace(/^delete-/, "");
  const key = button.dataset.key;
  const index = Number(button.dataset.index);
  const itemIndex = button.dataset.itemIndex === "" ? NaN : Number(button.dataset.itemIndex);
  const direction = Number(button.dataset.direction);

  if (action === "add-experience") {
    state.pendingDelete = null;
    const nextIndex = state.resume[key].length;
    state.resume[key].push(newExperience(key));
    markDirty();
    renderForm();
    focusFormPath(`${key}.${nextIndex}.start`);
    return;
  }

  if (action === "add-skill") {
    state.pendingDelete = null;
    const nextIndex = state.resume.skills.length;
    state.resume.skills.push({ title: "", items: [""] });
    markDirty();
    renderForm();
    focusFormPath(`skills.${nextIndex}.title`);
    return;
  }

  if (action === "add-bullet") {
    state.pendingDelete = null;
    state.resume[key][index].items ||= [];
    const nextItemIndex = state.resume[key][index].items.length;
    state.resume[key][index].items.push("");
    markDirty();
    renderForm();
    focusFormPath(`${key}.${index}.items.${nextItemIndex}`);
    return;
  }

  if (action === "cancel-delete") {
    state.pendingDelete = null;
    renderForm();
    return;
  }

  if (action === "confirm-delete") {
    confirmDelete(state.pendingDelete);
    return;
  }

  if (action === "move-experience" || action === "move-skill") {
    moveItem(state.resume[key], index, direction);
    return;
  }

  if (action === "delete-experience" || action === "delete-skill") {
    setPendingDelete(kind, key, index);
    return;
  }

  if (action === "move-bullet") {
    moveItem(state.resume[key][index].items, itemIndex, direction);
    return;
  }

  if (action === "delete-bullet") {
    setPendingDelete(kind, key, index, itemIndex);
    return;
  }

  if (action === "move-layout") {
    moveItem(state.resume.layout.sectionOrder, index, direction);
  }
}

async function saveResume() {
  if (!state.dirty) {
    return true;
  }

  const saved = await withBusy("saving", async () => {
    try {
      const body = await requestJson(activeResumeUrl("/api/resume"), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state.resume)
      });
      state.resume = ensureLayout(body.resume);
      state.dirty = false;
      state.saveState = "saved";
      state.generation = "needs generate";
      await loadBackups();
      setMessage(backupMessage("已保存，待生成", body.backup), "ok");
      renderAll();
      return true;
    } catch (error) {
      state.saveState = "error";
      setMessage(`保存失败：${error.message}`, "error");
      return false;
    }
  });

  return saved === true;
}

function resetResumeEditorState() {
  cancelDraftPreview();
  state.activeArea = "content";
  state.activeModule = "profile";
  state.resume = null;
  state.backups = [];
  state.dirty = false;
  state.saveState = "loading";
  state.generation = "needs generate";
  state.density = "--";
  state.selectedPreviewSection = "";
  state.selectedPreviewPath = "";
  state.previewSource = "generated";
  state.pendingDelete = null;
}

async function loadSelectedResume({ draftOnly = false } = {}) {
  resetResumeEditorState();
  renderAll();
  await Promise.all([loadResume(), loadBackups()]);

  if (draftOnly) {
    state.generation = "needs generate";
  }
  showLoadedPreview({ draftOnly });
  renderAll();
}

async function performResumeSwitch(targetId) {
  if (!targetId || targetId === state.activeResumeId) {
    renderResumeSelector();
    return true;
  }

  const switched = await withBusy("switching", async () => {
    try {
      const body = await requestJson(`/api/resumes/${encodeURIComponent(targetId)}/activate`, {
        method: "POST"
      });
      applyRegistry(body);
      await loadSelectedResume();
      setMessage(`已切换到 ${activeResumeEntry()?.name || targetId}`, "ok");
      return true;
    } catch (error) {
      setMessage(`切换失败：${error.message}`, "error");
      return false;
    }
  });

  renderResumeSelector();
  return switched === true;
}

async function requestResumeSwitch(targetId) {
  if (!targetId || targetId === state.activeResumeId) {
    renderResumeSelector();
    return;
  }

  renderResumeSelector();
  if (!state.dirty) {
    await performResumeSwitch(targetId);
    return;
  }

  const target = state.resumes.find((resume) => resume.id === targetId);
  const result = await showResumeDialog({
    title: "当前修改尚未保存",
    description: `切换到“${target?.name || targetId}”前，请选择如何处理当前草稿。`,
    actions: [
      { id: "cancel", label: "取消" },
      { id: "discard-switch", label: "放弃修改" },
      { id: "save-switch", label: "保存并切换", kind: "primary" }
    ]
  });

  if (result.action === "save-switch") {
    const saved = await saveResume();
    if (saved) {
      await performResumeSwitch(targetId);
    } else {
      renderResumeSelector();
    }
    return;
  }

  if (result.action === "discard-switch") {
    await performResumeSwitch(targetId);
    return;
  }

  renderResumeSelector();
}

async function applyCreatedResume(body) {
  applyRegistry(body);
  await loadSelectedResume({ draftOnly: true });
  setMessage(`已新建 ${activeResumeEntry()?.name || "简历"}，PDF 待生成`, "ok");
}

async function prepareForCreatedResumeSwitch() {
  if (!state.dirty) {
    return true;
  }

  const result = await showResumeDialog({
    title: "当前修改尚未保存",
    description: "新建完成后会自动切换，请先选择如何处理当前草稿。",
    actions: [
      { id: "cancel", label: "取消" },
      { id: "discard-create", label: "放弃修改" },
      { id: "save-create", label: "保存并继续", kind: "primary" }
    ]
  });

  if (result.action === "save-create") {
    return saveResume();
  }

  return result.action === "discard-create";
}

async function duplicateCurrentResume() {
  if (!await prepareForCreatedResumeSwitch()) {
    return;
  }

  const current = activeResumeEntry();
  const result = await showResumeDialog({
    title: "复制当前简历",
    description: "复制内容和排版顺序，不复制备份和已生成文件。",
    input: { value: `${current?.name || "简历"} 副本` },
    validatedActions: ["confirm-duplicate"],
    actions: [
      { id: "cancel", label: "取消" },
      { id: "confirm-duplicate", label: "复制并切换", kind: "primary" }
    ]
  });
  if (result.action !== "confirm-duplicate") {
    return;
  }

  await withBusy("creating-resume", async () => {
    try {
      const body = await requestJson("/api/resumes/duplicate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: state.activeResumeId, name: result.name })
      });
      await applyCreatedResume(body);
    } catch (error) {
      setMessage(`复制失败：${error.message}`, "error");
    }
  });
}

async function createResumeFromExample() {
  if (!await prepareForCreatedResumeSwitch()) {
    return;
  }

  const firstExample = state.examples[0];
  const result = await showResumeDialog({
    title: "从样例新建",
    description: "选择一个样例作为新简历的初始内容。",
    example: { value: firstExample?.id || "" },
    input: { value: firstExample ? `${firstExample.label} 简历` : "新简历" },
    validatedActions: ["confirm-example"],
    actions: [
      { id: "cancel", label: "取消" },
      { id: "confirm-example", label: "新建并切换", kind: "primary" }
    ]
  });
  if (result.action !== "confirm-example") {
    return;
  }

  await withBusy("creating-resume", async () => {
    try {
      const body = await requestJson("/api/resumes/from-example", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ exampleId: result.exampleId, name: result.name })
      });
      await applyCreatedResume(body);
    } catch (error) {
      setMessage(`新建失败：${error.message}`, "error");
    }
  });
}

async function renameCurrentResume() {
  const current = activeResumeEntry();
  const result = await showResumeDialog({
    title: "重命名简历",
    description: "只修改显示名称，不改变 YAML、备份或输出路径。",
    input: { value: current?.name || "" },
    excludeId: current?.id,
    validatedActions: ["confirm-rename"],
    actions: [
      { id: "cancel", label: "取消" },
      { id: "confirm-rename", label: "保存名称", kind: "primary" }
    ]
  });
  if (result.action !== "confirm-rename") {
    return;
  }

  await withBusy("renaming-resume", async () => {
    try {
      const body = await requestJson(`/api/resumes/${encodeURIComponent(state.activeResumeId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: result.name })
      });
      applyRegistry(body);
      renderAll();
      setMessage("简历名称已更新", "ok");
    } catch (error) {
      setMessage(`重命名失败：${error.message}`, "error");
    }
  });
}

async function deleteCurrentResume() {
  const current = activeResumeEntry();
  if (state.resumes.length <= 1) {
    setMessage("至少需要保留一份简历", "warning");
    return;
  }

  const result = await showResumeDialog({
    title: "删除简历",
    description: `确认删除“${current?.name || "当前简历"}”？对应 YAML、备份和输出会被删除，共享照片保留。`,
    actions: [
      { id: "cancel", label: "取消" },
      { id: "confirm-delete-resume", label: "确认删除", kind: "danger" }
    ]
  });
  if (result.action !== "confirm-delete-resume") {
    return;
  }

  await withBusy("deleting-resume", async () => {
    try {
      const body = await requestJson(`/api/resumes/${encodeURIComponent(state.activeResumeId)}`, {
        method: "DELETE"
      });
      applyRegistry(body);
      await loadSelectedResume();
      setMessage("简历已删除", "ok");
    } catch (error) {
      setMessage(`删除失败：${error.message}`, "error");
    }
  });
}

async function generateResume() {
  if (state.dirty) {
    setMessage("请先保存再生成 PDF", "error");
    return;
  }

  await withBusy("generating", async () => {
    try {
    state.generation = "generating";
    renderStatus();
    const body = await requestJson("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeId: state.activeResumeId })
    });
    state.density = body.density || "--";
    state.generation = "generated";
    refreshGeneratedPreview();
    setMessage(`预览已更新，PDF 已生成，内容高度 ${body.contentHeight}px`, "ok");
    } catch (error) {
      state.generation = "error";
      setMessage(`生成失败：${error.message}`, "error");
    }
  });
}

async function loadExample() {
  if (state.dirty && !confirm("当前有未保存修改，确认载入样例？当前选中简历会先备份。")) {
    return;
  }

  await withBusy("loading-example", async () => {
    try {
    const body = await requestJson("/api/load-example", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeId: state.activeResumeId, id: elements.exampleSelect.value })
    });
    state.resume = ensureLayout(body.resume);
    state.dirty = false;
    state.saveState = "saved";
    state.generation = "needs generate";
    await loadBackups();
    setMessage(backupMessage("已载入样例，待生成", body.backup), "ok");
    renderAll();
    refreshGeneratedPreview();
    } catch (error) {
      setMessage(`载入样例失败：${error.message}`, "error");
    }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function uploadPhoto(file) {
  if (!file) {
    return;
  }

  await withBusy("uploading-photo", async () => {
    try {
    const dataUrl = await readFileAsDataUrl(file);
    const body = await requestJson("/api/photo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeId: state.activeResumeId, filename: file.name, dataUrl })
    });
    state.resume = ensureLayout(body.resume);
    state.dirty = false;
    state.saveState = "saved";
    state.generation = "needs generate";
    await loadBackups();
    setMessage(backupMessage("已替换照片，待生成", body.backup), "ok");
    renderAll();
    refreshGeneratedPreview();
    } catch (error) {
      setMessage(`照片替换失败：${error.message}`, "error");
    }
  });
}

async function restoreBackup() {
  const file = elements.backupSelect.value;
  if (!file) {
    setMessage("没有可恢复的备份", "warning");
    return;
  }

  const label = elements.backupSelect.selectedOptions[0]?.textContent || file;
  if (!confirm(`确认恢复备份 ${label}？当前选中简历会先备份。`)) {
    return;
  }

  await withBusy("restoring-backup", async () => {
    try {
    const body = await requestJson("/api/restore-backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeId: state.activeResumeId, file })
    });
    state.resume = ensureLayout(body.resume);
    state.dirty = false;
    state.saveState = "saved";
    state.generation = "needs generate";
    state.pendingDelete = null;
    state.activeArea = "content";
    state.activeModule = "profile";
    state.selectedPreviewSection = "";
    state.selectedPreviewPath = "";
    await loadBackups();
    setMessage(backupMessage(`已恢复备份 ${label}，待生成`, body.backup), "ok");
    renderAll();
    refreshGeneratedPreview();
    } catch (error) {
      setMessage(`恢复备份失败：${error.message}`, "error");
    }
  });
}

elements.resumeSelectButton.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleResumeSelectMenu();
});

elements.resumeSelectButton.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowUp"].includes(event.key)) {
    return;
  }
  event.preventDefault();
  openResumeSelectMenu();
});

elements.resumeSelectMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-resume-id]");
  if (!option) {
    return;
  }
  closeResumeSelectMenu(true);
  void requestResumeSwitch(option.dataset.resumeId);
});

elements.resumeSelectMenu.addEventListener("keydown", (event) => {
  const options = Array.from(elements.resumeSelectMenu.querySelectorAll("[role='option']"));
  const currentIndex = options.indexOf(document.activeElement);

  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : Math.min(
          options.length - 1,
          Math.max(0, currentIndex + (event.key === "ArrowDown" ? 1 : -1))
        );
    options[nextIndex]?.focus();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeResumeSelectMenu(true);
  }
});

elements.addResume.addEventListener("click", (event) => {
  event.stopPropagation();
  closeResumeSelectMenu();
  toggleResumeMenu(elements.addResumeMenu);
});

elements.manageResume.addEventListener("click", (event) => {
  event.stopPropagation();
  closeResumeSelectMenu();
  const deleteButton = elements.manageResumeMenu.querySelector("[data-resume-action='delete']");
  const isFinalResume = state.resumes.length <= 1;
  deleteButton.setAttribute("aria-disabled", String(isFinalResume));
  deleteButton.title = isFinalResume ? "至少保留一份简历" : "删除当前简历";
  elements.deleteResumeHint.hidden = !isFinalResume;
  toggleResumeMenu(elements.manageResumeMenu);
});

elements.dataManager.addEventListener("click", (event) => {
  event.stopPropagation();
  closeResumeSelectMenu();
  toggleResumeMenu(elements.dataManagerMenu);
});

elements.exportData.addEventListener("click", () => {
  openDataDialog("export");
});

elements.importData.addEventListener("click", requestDataImport);
elements.recoverData.addEventListener("click", () => {
  void requestDataRecovery();
});
elements.dataImportInput.addEventListener("change", () => {
  void inspectDataImport(elements.dataImportInput.files[0]);
});

document.querySelector(".resume-switcher").addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-resume-action]");
  const action = actionButton?.dataset.resumeAction;
  if (!action) {
    return;
  }

  if (actionButton.getAttribute("aria-disabled") === "true") {
    setMessage("至少需要保留一份简历", "warning");
    return;
  }

  closeResumeMenus();
  const handlers = {
    duplicate: duplicateCurrentResume,
    "from-example": createResumeFromExample,
    rename: renameCurrentResume,
    delete: deleteCurrentResume
  };
  void handlers[action]?.();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".resume-switcher") && !event.target.closest(".data-manager")) {
    closeResumeMenus();
    closeResumeSelectMenu();
  }
});

elements.dataDialogPrimary.addEventListener("click", () => {
  if (state.dataDialogMode === "export") {
    beginDataExport();
    return;
  }
  if (state.dataDialogMode === "import-ready") {
    void commitDataImport();
    return;
  }
  if (state.dataDialogMode === "import-error") {
    closeDataDialog({ cancelPending: false });
    elements.dataImportInput.click();
    return;
  }
  if (state.dataDialogMode === "recovery-list" && selectedRecoverySnapshot()) {
    state.dataDialogMode = "recovery-confirm";
    state.dataDialogError = "";
    renderDataDialog();
    elements.dataDialogPrimary.focus();
    return;
  }
  if (state.dataDialogMode === "recovery-confirm") {
    void commitDataRecovery();
    return;
  }
  if (state.dataDialogMode === "recovery-error") {
    void requestDataRecovery();
  }
});
elements.dataDialogBody.addEventListener("click", (event) => {
  const snapshotButton = event.target.closest("button[data-snapshot-id]");
  if (!snapshotButton || snapshotButton.disabled || state.dataDialogMode !== "recovery-list") {
    return;
  }
  const snapshot = state.recoverySnapshots.find((entry) => (
    entry.valid && entry.id === snapshotButton.dataset.snapshotId
  ));
  if (!snapshot) {
    return;
  }
  state.selectedRecoverySnapshotId = snapshot.id;
  state.dataDialogError = "";
  renderDataDialog();
  elements.dataDialogBody.querySelector(`[data-snapshot-id="${CSS.escape(snapshot.id)}"]`)?.focus();
});
elements.dataDialogCancel.addEventListener("click", () => closeDataDialog());
elements.dataDialogClose.addEventListener("click", () => closeDataDialog());
elements.dataDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDataDialog();
});

elements.dialogActions.addEventListener("click", (event) => {
  const action = event.target.closest("[data-dialog-action]")?.dataset.dialogAction;
  if (action) {
    completeDialogAction(action);
  }
});

elements.dialogClose.addEventListener("click", () => closeResumeDialog());
elements.dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeResumeDialog();
});
elements.dialogInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  const primary = dialogConfig?.validatedActions?.[0];
  if (primary) {
    completeDialogAction(primary);
  }
});

elements.tabs.addEventListener("click", (event) => {
  const areaButton = event.target.closest("[data-area]");
  if (areaButton) {
    state.activeArea = areaButton.dataset.area;
    renderAll();
    return;
  }

  const button = event.target.closest("[data-module]");
  if (!button) {
    return;
  }
  state.activeArea = "content";
  state.activeModule = button.dataset.module;
  renderAll();
});

elements.form.addEventListener("input", (event) => {
  const control = event.target.closest("[data-path]");
  if (!control || control.readOnly) {
    return;
  }
  setPath(control.dataset.path, control.value);
  markDirty();
});

elements.form.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) {
    handleAction(button);
  }
});

elements.form.addEventListener("change", (event) => {
  if (event.target.id === "photoInput") {
    uploadPhoto(event.target.files[0]);
  }
});

elements.save.addEventListener("click", saveResume);
elements.generate.addEventListener("click", generateResume);
elements.refreshPreview.addEventListener("click", refreshPreview);
elements.openPdf.addEventListener("click", () => {
  window.open(generatedPdfUrl(), "_blank", "noopener");
});
elements.loadExample.addEventListener("click", loadExample);
elements.restoreBackup.addEventListener("click", restoreBackup);
document.addEventListener("keydown", (event) => {
  const isSaveShortcut = (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && event.key.toLowerCase() === "s";
  if (!isSaveShortcut) {
    return;
  }

  event.preventDefault();
  void saveResume();
});
window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
});
elements.preview.addEventListener("load", async () => {
  fitPreviewFrame();
  markPreviewSelection();
  if (state.previewSource === "draft") {
    const selected = await selectDraftDensity();
    if (!selected || state.previewSource !== "draft") {
      return;
    }

    const pendingMessage = state.pendingDraftPreviewMessage;
    state.pendingDraftPreviewMessage = "";
    state.density = selected.density;
    if (selected.overflow > fitTolerancePx) {
      state.draftPreview = "overflow";
      const overflowMessage = `草稿预览在 tight 档仍超出 ${selected.overflow}px，请缩短最长模块或减少 1-2 条要点。`;
      setMessage(pendingMessage ? `${pendingMessage}；${overflowMessage}` : overflowMessage, "error");
      return;
    }

    state.draftPreview = "ready";
    if (pendingMessage) {
      setMessage(`${pendingMessage}；草稿预览已更新，PDF 待生成`, "ok");
    } else {
      setMessage(state.dirty ? "草稿预览已更新，内容尚未保存" : "草稿预览已更新，PDF 待生成", "warning");
    }
    markPreviewSelection();
    return;
  }

  if (!previewDocument()?.querySelector("#resume-page") && state.resume) {
    state.generation = "needs generate";
    scheduleDraftPreview(0);
    return;
  }
  warnIfPreviewNeedsRegeneration();
});
new ResizeObserver(fitPreviewFrame).observe(elements.previewStage);

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) {
    return;
  }

  if (event.data?.type === "resume-preview-section") {
    selectPreviewTarget(event.data.section, event.data.path || "");
  }
});

async function initialize() {
  await Promise.all([loadExamples(), loadResumes()]);
  await Promise.all([loadResume(), loadBackups()]);
  showLoadedPreview();
}

initialize().catch((error) => {
  setMessage(`初始化失败：${error.message}`, "error");
});
