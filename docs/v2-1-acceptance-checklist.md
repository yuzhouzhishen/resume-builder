# Resume Builder V2.1A Acceptance Checklist

Date: 2026-07-10

V2.1A 继续执行全部 V2 多简历、一页 A4、实时草稿、备份与点击定位检查，并增加数据目录隔离和迁移验证。

## Automated Verification

```bash
npm test
npm run generate
```

2026-07-10 验证结果：

- `npm test`：133 项通过，0 项失败。
- 路径解析、迁移一致性、并发发布、符号链接逃逸、越界照片、双根静态映射和样例资源复制均有自动化覆盖。
- 活动简历生成选择 `tight`，PDF 为 1 页标准 A4。
- 正式 HTML 预览内联 CSS，不依赖数据目录之外的相对模板路径。

## Real Migration

- 迁移前后 `resumes.json`、全部 YAML 和照片 SHA-256 完全一致。
- 迁移前后备份文件和已有输出文件清单一致。
- 旧版根级 `resume.backup.yaml` 已补入外部数据目录，源、目标 SHA-256 一致。
- `.migration.json` 记录 `version: 1`、`type: legacy-copy` 和旧项目来源。
- 活动 ID 和全部注册表条目保持一致。
- 项目内旧数据继续存在，但已被 Git 忽略。

## Browser And Output

- 编辑器启动日志显示外部数据目录状态为 `existing`。
- 左侧选择器显示全部迁移简历，活动项和右侧表单一致。
- 活动简历的正式 HTML 正常显示照片和完整 A4。
- 浏览器控制台无错误。
- 新生成的活动简历 PDF 为标准 A4，共 1 页。

## Git And Privacy

- `git ls-files` 不再包含真实 `resumes.json`、`resumes/*.yaml`、个人照片或 `.env.local`。
- 公开样例、测试夹具和早期计划使用虚构内容与占位照片。
- 编辑、保存和生成不会让代码仓库因个人数据变化而变脏。
- Gitee 历史尚未重写；迁移 GitHub 前仍需执行历史脱敏。

## New Computer Boundary

V2.1A 不自动跨设备同步。换电脑时先复制整个数据目录，再在新电脑配置 `.env.local`。自动导出与导入属于后续 V2.1B。
