# Resume Builder V2.2 CI And Privacy Boundaries

Date: 2026-07-10

## Goal

V2.2 第一阶段为公开代码仓库增加自动测试和隐私门禁。它不改变简历编辑、保存、备份、数据导入导出或 PDF 生成行为。

## Local Gate

开发者在提交前运行：

```bash
npm run ci
```

`npm run ci` 与 `npm test` 使用同一入口，依次执行：

1. 检查当前 Git 索引和完整可达历史。
2. 运行隐私扫描器及 workflow 结构测试。
3. 运行数据、路径、编辑器 API、浏览器交互和渲染生成测试。

## Rejected Repository Data

扫描器拒绝：

- `.env.local`、真实注册表、真实简历 YAML 和仓库内运行数据目录。
- 备份、正式 HTML/PDF/PNG 输出和数据导出压缩包。
- 栅格照片、简历文档及内部 UI 审核截图目录。
- 常见私钥、访问令牌、非示例邮箱、中国大陆手机号和非测试用户的绝对主目录。
- 非 `example.com` 或 GitHub noreply 的 Git 提交邮箱。

仓库允许源代码、文档、虚构 YAML 样例、`.env.example`、`output/.gitkeep` 和 `assets/photo.svg` 矢量占位头像。

## GitHub Actions

CI 在 push 和 pull request 上运行，使用完整 Git 历史、只读仓库权限、Node 22、Chromium 和中文字体。job 超时为 20 分钟，同一分支的新运行会取消旧运行。

首次 CI 成功后，在 GitHub 仓库设置中为 `main` 添加 ruleset 或 branch protection：

1. 要求分支更新前状态检查通过。
2. 选择 `test-and-privacy` 状态检查。
3. 禁止 force push 和分支删除。

个人仓库可继续允许直接 push；状态检查用于阻止未通过门禁的更新。需要更严格流程时，再增加必须通过 pull request 的规则。

## Explicit Non-Goals

V2.2 第一阶段不做：

- 加密真实简历数据或导出 ZIP。
- 自动撤回已经推送的敏感内容。
- 云端保存简历、自动同步或账号系统。
- 自动修改 GitHub 仓库可见性、成员权限或分支保护。
- 改动 UI、模板、排版或数据格式。

CI 只能降低误提交风险，不能替代仓库外数据隔离、私有备份和提交前人工检查。
