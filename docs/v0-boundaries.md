# Resume Builder Current Boundaries

Date: 2026-07-09

## Goal

当前版本是一个本地一页 A4 简历生成器。目标是让用户只维护结构化内容，系统负责稳定生成可投递的 PDF。

主要输入：

- `resume.yaml`
- `assets/photo.png`

主要输出：

- `output/resume.pdf`
- `output/resume.png`
- `output/preview.html`

## Supported Workflow

推荐使用本地网页编辑器：

1. 运行 `npm run editor`。
2. 打开 `http://127.0.0.1:4321`，如果端口被占用则使用终端输出的新端口。
3. 在右侧 `内容编辑` 修改简历内容。
4. 在 `排版顺序` 调整 section 顺序。
5. 点击 `保存` 写回 `resume.yaml`。
6. 点击 `生成 PDF` 输出 `output/resume.pdf` 和 `output/resume.png`。

也可以直接运行：

```bash
npm run generate
```

## Content Scope

当前支持的内容模块：

- 基本信息
- 照片
- 实习经历
- 专业技能
- 项目经历

`layout.sectionOrder` 只控制这三个 section 的显示顺序：

- `internships`
- `skills`
- `projects`

基本信息和照片固定在页首，不参与 `sectionOrder` 排序。

## Rendering Scope

当前固定输出标准 A4，一页：

- CSS 使用标准 A4。
- PDF 导出使用 Playwright 的 A4 格式。
- 生成成功时应只有 1 页。

自动适配使用三档离散密度：

- `normal`
- `compact`
- `tight`

如果 `tight` 仍然放不下，生成失败并提示 overflow。当前版本不会为了硬塞内容而无限缩小字体，也不会自动删减或改写内容。

## Editor Scope

右侧编辑器当前分成两层：

- `内容编辑`：基本信息、照片、实习经历、专业技能、项目经历。
- `排版顺序`：调整简历 section 的输出顺序。

左侧预览当前是 `output/preview.html` iframe，不是实时编辑画布。因此：

- 默认按预览区真实可用宽度和高度缩放，完整显示一张 A4。
- 浏览器外层页面不滚动；右侧只有中间表单区域滚动，顶部导航和底部操作区保持可见。
- 修改内容后需要先 `保存`，再 `生成 PDF`，左侧才会更新。
- `预览未更新` 表示右侧内容有未保存修改。
- `待生成` 表示内容已保存，但输出文件还没有重新生成。
- `预览已更新` 表示最近一次生成已完成。
- 点击左侧预览里的基本信息字段会跳转到右侧对应输入框。
- 点击照片会跳转到照片编辑模块。
- 点击某一段实习经历、某个技能组、某个项目经历，会跳转到右侧对应卡片。
- 点击经历字段、项目字段、技能标题或 bullet，会跳转到右侧对应输入框。
- 左侧预览不支持拖拽模块或直接编辑。
- 如果预览缺少当前版本需要的字段定位标记，编辑器会提示重新生成 PDF/预览。

## Safety Scope

覆盖 `resume.yaml` 前会备份旧版本到：

```text
resume.backup.yaml
backups/resume-YYYYMMDD-HHMMSS.yaml
```

会触发备份的操作：

- 保存
- 载入样例
- 替换照片
- 恢复备份

网页底部提供最近备份恢复入口。恢复后仍需要重新生成 PDF/预览。

保存、生成、载入样例、替换照片、恢复备份进行中时，相关操作按钮会临时禁用，避免重复提交。

如果前端和后端接口不匹配，网页会提示重新运行 `npm run editor`。

照片上传限制：

- 支持 `.png`、`.jpg`、`.jpeg`、`.webp`、`.svg`
- 默认大小上限是 `5MB`

## Explicit Non-Goals

当前版本不做：

- Word 导出
- 多页简历
- 多模板市场
- AI 改写内容
- 在线部署或账号系统
- 复杂版本管理、版本对比或版本合并
- 拖拽排序经历、项目或 bullet
- 精确定位 overflow 到某一条 bullet

## Known Tradeoffs

- 左侧 HTML iframe 预览支持模块选择，但仍不是所见即所得编辑器。
- 三档密度简单可控，但不能像连续缩放那样精细。
- YAML 仍然是内容源，本地编辑器只是更方便的编辑入口。
- 当前 UI 以实用为先，暂不追求模板站那种完整产品化工作台。

## Likely v1 Candidates

下一阶段可以考虑：

- 排版设置增加密度、边距、字号策略等可视化控制。
- 内容编辑卡片支持折叠、拖拽排序、快速新增。
- 多份简历或版本管理。
- 更完整的视觉设计系统。
