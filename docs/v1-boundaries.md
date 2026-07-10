# Resume Builder V1.1 Boundaries

Date: 2026-07-10

## Goal

V1 第一阶段在 V0 的本地一页 A4 简历生成能力上增加实时草稿预览。V1.1 增加未保存离开提醒和快捷保存，同时继续保持保存和正式 PDF 生成的明确边界。

## Live Draft Preview

- 输入停止约 300ms 后自动请求草稿 HTML。
- 草稿通过 iframe `srcdoc` 显示，不覆盖 `output/preview.html`。
- 新增、删除、移动经历、技能组、bullet 和 section 顺序也会触发草稿预览。
- 快速连续修改只采用最后一次请求结果，较慢的旧响应不会覆盖新内容。
- 点击草稿中的字段仍会定位右侧对应输入框。

## Persistence Boundary

实时草稿预览不会：

- 写入 `resume.yaml`。
- 创建 `resume.backup.yaml` 或时间戳备份。
- 写入 `output/preview.html`。
- 生成 PDF 或 PNG。

只有点击 `保存` 才会写入 YAML 和创建备份。只有点击 `生成 PDF` 才会正式选择密度，并更新 PDF、PNG 和磁盘 HTML 预览。

## Editing Safety

- `Cmd + S`（macOS）和 `Ctrl + S`（Windows/Linux）调用与保存按钮完全相同的保存流程。
- 快捷键会阻止浏览器原本的“保存网页”行为。
- 只有 `state.dirty` 为真时，刷新、关闭页面或离开编辑器才触发浏览器确认提示。
- 保存成功、载入样例、恢复备份或替换照片后，内存状态与 YAML 一致，不再触发未保存提示。
- 保存请求尚未成功时仍视为未保存，避免网络或校验失败时误放行离开。

## Density Boundary

草稿 iframe 在浏览器中依次测量：

- `normal`
- `compact`
- `tight`

状态栏显示草稿当前采用的密度。若 `tight` 仍然溢出，界面提示超出像素和缩短内容建议。正式生成仍使用 Playwright 独立测量，浏览器草稿结果不是 PDF 导出承诺。

## Status Semantics

- `预览更新中`：草稿请求或 iframe 布局尚未完成。
- `草稿预览`：左侧显示当前未保存内容。
- `草稿预览失败`：草稿验证或请求失败，左侧保留上一次可用预览。
- `草稿超出 A4`：最紧密档位仍无法放入一页。
- `PDF 待生成`：内容已经保存，但正式输出尚未更新。
- `预览已更新`：正式 HTML、PDF 和 PNG 已生成。

恢复备份、载入样例或替换照片会退出之前的 `srcdoc` 草稿，回到磁盘预览，避免继续显示操作前内容。

## Explicit Non-Goals

V1.1 仍不做：

- 自动保存。
- 输入时自动生成 PDF。
- Word 导出。
- 多页简历。
- 多模板市场。
- 多份简历管理。
- AI 改写。
- 可视化字号、间距和边距控制。
- 预览缩放模式切换。
