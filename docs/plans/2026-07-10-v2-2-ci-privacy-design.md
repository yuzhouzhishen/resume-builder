# Resume Builder V2.2 CI And Privacy Design

Date: 2026-07-10

## Goal

V2.2 第一阶段为公开 GitHub 仓库增加自动化质量门禁，不改变简历编辑器、数据格式、排版或生成行为。每次本地验证、push 和 pull request 都应检查隐私边界，并运行现有完整测试。

## Privacy Boundary

仓库只允许代码、文档、虚构示例和矢量占位头像。扫描器检查当前索引和所有可达 Git 历史，拒绝真实运行数据路径、备份、生成文件、简历文档、照片及压缩包。文本扫描拒绝常见私钥和令牌格式、非测试用户的绝对主目录、非 `example.com`/GitHub noreply 邮箱以及中国大陆手机号。提交元数据中的邮箱也只能使用示例地址或 GitHub noreply 地址。

扫描器使用 Node.js 标准库和 Git CLI，不新增运行依赖。当前内容以 Git index blob 为准，避免暂存内容与工作树不一致时漏检；历史路径与唯一 blob 分别扫描，blob 通过 `git cat-file --batch` 批量读取。任何二进制 blob 或超过 2MB 的跟踪 blob 都直接拒绝。错误输出只报告规则、提交或文件路径和行号，不回显完整敏感内容。

## CI Workflow

GitHub Actions 在 `push` 和 `pull_request` 上运行一个只读 job：checkout 完整历史、安装 Node 22 和 npm 依赖、安装 Chromium 与中文字体，然后执行 `npm run ci`。workflow 使用最小 `contents: read` 权限、超时和并发取消，避免无边界运行。

`npm test` 先执行仓库隐私检查，再运行扫描器测试和现有 156 项测试。这样本地开发和 CI 使用同一个入口，不会出现只在云端生效的隐藏规则。

## Testing

扫描器测试覆盖允许的虚构示例、禁止路径、邮箱、手机号、绝对路径和令牌；集成测试在临时 Git 仓库中创建后删除敏感文件，确认完整历史扫描仍会失败。CI workflow 另有结构测试，保证完整历史、只读权限、Node 版本、Chromium 安装和统一命令不会被误删。

V2.2 不自动修改 GitHub 仓库设置。首次 workflow 成功后，再人工将 `main` 设置为需要通过该状态检查的受保护分支。
