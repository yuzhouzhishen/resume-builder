# Resume Builder V2.1B Boundaries

Date: 2026-07-10

## Goal

V2.1B 在本地编辑器中增加整套简历数据的 ZIP 导出和两阶段导入。它用于手动备份和换电脑迁移，不改变现有一页 A4、多简历、实时草稿、显式保存与正式 PDF 生成流程。

## User Workflow

- 入口位于左侧预览顶部工具栏的简历选择器旁，名称为 `数据管理`。
- 导出前必须确认 ZIP 包含未加密的个人信息。
- 导入先检查文件，再展示创建时间、格式版本、活动简历和简历列表。
- 确认导入会整套替换当前已保存数据，不合并简历。
- 当前有未保存草稿时禁止导入。
- 导入完成后先显示实时 HTML 草稿，正式 PDF 状态为待生成。

## Package Boundary

导出 ZIP 固定包含：

```text
manifest.json
resumes.json
resumes/
assets/
backups/
```

导出不包含：

- `output/` 中的 PDF、PNG 和 HTML。
- `.env.local`、本机绝对路径和代码仓库内容。
- `.migration.json`、`.migration-in-progress` 和临时导入目录。
- 旧版根级 `resume.backup.yaml`。

ZIP 是普通未加密文件，任何获得文件的人都可能读取其中的姓名、联系方式、简历正文、照片和历史备份。

## Validation Boundary

- 格式为 `resume-builder-backup`，当前只接受 `formatVersion: 1`。
- `manifest.json` 列出每个数据文件的相对路径、字节数和 SHA-256。
- ZIP 文件集合必须与 manifest 完全一致；缺失、多余、重复、大小或哈希不符都会被拒绝。
- 导入拒绝绝对路径、`..`、反斜杠路径、未知顶层路径、符号链接和特殊文件。
- 解压后的临时目录必须通过现有注册表、YAML、照片引用和真实路径边界校验。
- 默认限制为 ZIP 50MB、解压总量 100MB、单文件 20MB、最多 2000 个文件。
- 待确认 token 默认 15 分钟失效；同一服务器只保留一个待确认导入。

## Replacement And Recovery

确认导入时，服务端在同一父目录内执行原子重命名：

```text
<dataRoot>
-> <dataRoot>.pre-import-YYYYMMDD-HHMMSS

.resume-import-<token>
-> <dataRoot>
```

- 旧数据目录完整保留，不自动删除，也不会被后续同名备份覆盖。
- 导入提交请求到达后，保存、生成、照片上传、恢复和简历管理等新写操作被锁定。
- 已有写操作尚未结束时，导入提交返回 HTTP 423，保留 token 供用户稍后重试；客户端断开不会提前释放后台写操作的门禁。
- 第二次重命名失败时恢复旧目录。
- 新数据发布后会再次校验；校验失败时隔离失败目录并恢复旧数据。
- 导入测试不得把真实 `dataRoot` 作为提交目标。

## Explicit Non-Goals

V2.1B 不做：

- 云同步、自动跨设备发现、账号或多人协作。
- ZIP 密码加密、密钥托管或自动上传网盘。
- 单份简历导入、按 ID 合并或冲突解决。
- 导入 PDF、Word、PNG 或第三方简历格式。
- 导出或恢复 `output/` 正式生成文件。
- 在界面中管理、删除或一键恢复 `.pre-import-*` 目录。
- 自动清理未引用照片和历史备份。
