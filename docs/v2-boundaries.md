# Resume Builder V2 Boundaries

Date: 2026-07-10

## Goal

V2 在 V1.1 的一页 A4、实时草稿、显式保存、备份和点击定位基础上，增加本地多份简历管理。不同投递方向可以同时存在，并拥有独立 YAML、备份和正式输出。

## Storage Boundary

- `resumes.json` 只保存稳定 ID、显示名称、YAML 相对路径和 `activeId`。
- 简历内容继续使用原 YAML schema，存放在 `resumes/<id>.yaml`。
- 新备份写入 `backups/<id>/`，正式输出写入 `output/<id>/`。
- `assets/` 是共享目录；网页上传的照片使用 `<id>-photo.<ext>` 文件名。
- 删除简历不会删除共享照片，避免影响其他仍引用该文件的简历。
- V1.1 根目录旧备份保持原样，V2 不再写入。

所有服务端文件路径都由 `resumes.json` 中已验证的 ID 推导。客户端不能提交任意 YAML、备份或输出路径。

## Resume Lifecycle

- `+` 提供复制当前简历和从 allowlist 样例新建。
- V2 不创建完全空白的简历。
- 新建成功后自动切换，但不会自动生成 PDF；左侧先显示 `srcdoc` 草稿。
- 重命名只修改显示名称，稳定 ID 和文件路径不变。
- 名称 trim 后不能为空，并按 Unicode 规范化和大小写不敏感规则保持唯一。
- 删除会移除对应 YAML、备份和输出；最后一份简历不能删除。

## Switching Safety

有未保存草稿时切换简历，必须选择：

- `保存并切换`：保存成功后才激活目标简历。
- `放弃修改`：不保存当前内存草稿，直接切换。
- `取消`：保持当前简历和草稿。

保存失败、目标 ID 不存在或接口失败时，当前 ID 不变。切换成功后同步更新表单、备份列表、预览路径、PDF 路径和状态。

## Persistence And Generation

- 输入时只生成内存草稿 HTML，不写 YAML、备份、PDF、PNG 或磁盘预览。
- `保存` 只写当前 ID 的 YAML 和备份。
- `生成 PDF` 只更新当前 ID 的 `output/<id>/`。
- `npm run generate` 生成 `activeId`；`npm run generate -- --resume <id>` 显式选择简历。
- 每份简历继续执行 `normal -> compact -> tight` 和一页标准 A4 约束。

## Explicit Non-Goals

V2 第一阶段仍不做：

- 在线账号、云同步或多人协作。
- Word 导出。
- 多页简历。
- 多模板市场。
- AI 改写。
- 自动保存或输入时自动生成 PDF。
- 可视化字号、间距和边距控制。
- 自动清理未引用照片。
