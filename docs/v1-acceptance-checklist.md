# Resume Builder V1.1 Acceptance Checklist

Date: 2026-07-10

V1.1 继续执行全部 [V0 验收项](v0-acceptance-checklist.md) 和 V1 实时预览检查，并增加编辑安全检查。

## Automated Check

运行：

```bash
npm test
```

期望：

- 所有测试通过。
- 当前测试数量为 62。

2026-07-10 验证结果：

- `npm test`：62 项通过，0 项失败。
- `npm run generate`：选择 `tight`，成功生成 HTML、PDF 和 PNG。
- `pdfinfo output/resume.pdf`：1 页，`595.92 x 842.88 pts (A4)`。
- `1440x900` 与 `1024x900`：整张 A4、右侧底部操作栏和状态提示均保持在视口内，页面无横向或纵向溢出。
- 两档视口中的草稿预览均正常更新，浏览器控制台无错误。

V1.1 验证结果：

- `npm test`：62 项通过，0 项失败。
- 浏览器工作流测试同时覆盖干净页面离开、未保存离开、保存后离开、`Cmd + S`、`Ctrl + S` 和正式生成。
- 快捷键每次只触发一次保存请求，保存后状态为 `已保存` 和 `PDF 待生成`。

## Unsaved Exit Guard

1. 打开编辑器但不修改内容，刷新页面。
2. 修改姓名或任意 bullet，不保存，然后刷新或关闭页面。
3. 选择留在页面并点击保存，再次刷新。

期望：

- 未修改时不会弹出离开确认。
- 有未保存草稿时浏览器提示可能丢失修改。
- 保存成功后不再提示。
- 保存失败或仍在保存时继续提示。

## Keyboard Save

1. 修改任意内容。
2. macOS 按 `Cmd + S`，Windows/Linux 按 `Ctrl + S`。

期望：

- 浏览器不会打开“保存网页”对话框。
- 只发起一次保存请求。
- 状态从 `未保存` 变为 `已保存` 和 `PDF 待生成`。
- `resume.yaml` 已更新并创建备份。
- PDF 不会自动生成。

## Live Text Preview

1. 修改姓名或任意 bullet，但不要点击保存。
2. 停止输入约 300ms。

期望：

- 左侧出现最新内容。
- 状态显示 `未保存` 和 `草稿预览`。
- `生成 PDF` 按钮显示 `保存后生成` 且不可点击。
- `resume.yaml` 和 `output/preview.html` 尚未改变。

## Draft Linking

1. 在未保存草稿预览中点击姓名、公司、项目、技能标题或 bullet。

期望：

- 右侧切换并聚焦对应输入框。
- 底部提示包含 `当前为未保存草稿`。

## Rapid Editing

1. 连续快速修改同一个字段多次。

期望：

- 左侧最终只显示最后一次内容。
- 较慢的旧草稿请求不会覆盖最新预览。

## Structural Editing

1. 新增或删除经历、技能组、bullet。
2. 调整 section 顺序。

期望：

- 左侧自动更新结构与顺序。
- 未点击保存前，YAML 保持不变。

## Save And Generate

1. 修改内容并等待草稿预览。
2. 点击 `保存`。
3. 点击 `生成 PDF`。

期望：

- 保存后左侧草稿保持可见，状态显示 `PDF 待生成`。
- 正式生成后 iframe 退出 `srcdoc`，重新加载 `output/preview.html`。
- 状态显示 `预览已更新`。
- PDF、PNG 和 HTML 与保存内容一致。

## Draft Replacement

1. 创建未保存草稿。
2. 恢复备份、载入样例或替换照片。

期望：

- 操作前草稿不再显示。
- iframe 回到磁盘预览。
- 状态显示 `PDF 待生成`，等待正式生成。
