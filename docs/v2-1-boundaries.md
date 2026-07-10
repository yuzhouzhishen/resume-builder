# Resume Builder V2.1A Boundaries

Date: 2026-07-10

## Goal

V2.1A 将程序代码与本地个人简历数据分离。编辑器、命令行生成器和迁移器共用同一个外部 `dataRoot`，代码仓库只保留程序、模板、脱敏样例和测试。

## Data Location

`dataRoot` 按以下优先级解析：

1. `RESUME_BUILDER_DATA_DIR` 进程环境变量。
2. 项目根目录中被 Git 忽略的 `.env.local`。
3. `~/Documents/Resume Builder`。

`dataRoot` 必须是代码仓库之外的绝对路径。真实目录结构为：

```text
resumes.json
resumes/
assets/
backups/
output/
resume.backup.yaml  # 仅为旧版迁移保险，可选
.migration.json
```

模板和编辑器静态文件只从 `projectRoot` 读取。注册表、YAML、个人照片、备份和生成结果只从 `dataRoot` 读写。

## Migration Boundary

- 目标不存在且项目内有旧数据时，程序复制旧数据到同级临时目录。
- 临时目录通过注册表、全部 YAML 和照片引用校验后才原子发布。
- 复制前后会核对旧数据指纹；迁移期间源数据变化时中止并提示关闭旧编辑器后重试。
- 发布后的目标在移除 `.migration-in-progress` 前不可使用；其他进程只等待，不读取半完成数据。
- 发布进程崩溃后，下一次启动会根据标记中的 PID、来源目录和源/目标指纹自动完成安全恢复；无法确认一致时保留现场并停止。
- 发布后复核失败时，目标会原子退回迁移工作目录并完整保留，不递归删除正式路径。
- 项目内旧文件不会被删除，并被 Git 忽略。
- 目标已存在时只校验并使用，不自动覆盖或合并。
- 目标无效、迁移源无效或数据目录不可写时停止启动。
- 两个首次启动进程竞争时只保留一个有效目标，失败方清理自己的临时目录。
- 数据目录、注册 YAML 与静态文件会按真实路径校验，符号链接不能绕过目录边界。
- 首次迁移的前置条件是关闭仍写入旧项目目录的旧版编辑器或生成命令；不配合迁移协议的旧进程无法由 Node 进程强制锁定。

## Repository Boundary

当前 Git 版本不再跟踪真实 `resumes.json`、`resumes/*.yaml` 和个人照片。公开样例、测试夹具和早期计划中的个人内容已替换为虚构数据。

这只清理当前及未来版本。Gitee 已有提交历史仍可能包含旧个人数据；迁移 GitHub 前需要在独立克隆中清理历史，V2.1A 不自动改写远程历史。

## Runtime Boundary

- 网页 API 和 URL 保持不变。
- 保存、备份、恢复、照片上传和生成只操作当前 `dataRoot`。
- 正式 `preview.html` 内联简历 CSS，可脱离代码仓库单独查看。
- 启动日志必须显示编辑器 URL、实际数据目录和准备状态。
- `rootDir` 仅作为现有程序化测试的兼容入口，正式 CLI 使用 `projectRoot/dataRoot`。

## Explicit Non-Goals

V2.1A 不做：

- 可视化或 ZIP 数据导入导出。
- 云同步、账号或多人协作。
- 自动删除迁移前旧文件。
- 自动合并两个已有数据目录。
- 自动清理未引用照片。
- Gitee 历史重写。
- 模板市场、AI 改写或可视化排版参数。
