# V2.1A 本地数据隔离设计

日期：2026-07-10

状态：V2.1A 已实施。代码与真实数据已分离，当前自动化测试 133 项通过；真实迁移、三简历浏览器检查和一页 A4 生成均已完成。

## 目标

将真实简历、照片、备份和生成结果从代码仓库中分离，使编辑器日常使用不再污染 Git 工作区，也避免后续迁移到公开 GitHub 时继续提交个人信息。

V2.1 分为两个阶段：

- V2.1A：数据目录隔离、无损迁移和公开仓库脱敏。
- V2.1B：整套简历数据的导入与导出。

本文只定义 V2.1A。

## 已确认决策

- 代码仓库和用户数据使用两个独立根目录。
- 用户本机数据目录由私有 `.env.local` 指向已确认的个人信息目录，绝对路径不进入 Git。
- 用户特定绝对路径不写入 Git，由 `.env.local` 配置。
- 程序提供跨机器默认目录 `~/Documents/Resume Builder`。
- 首次启动自动执行复制式迁移，不移动或删除旧数据。
- 首次迁移前关闭仍使用旧项目目录的编辑器或生成命令。
- 迁移在临时目录完成，完整校验后再原子启用。
- V2.1A 不重写 Gitee 已有历史；历史脱敏在迁移 GitHub 前单独处理。

## 根目录模型

程序明确区分：

```text
projectRoot = <repository-root>
dataRoot    = $RESUME_BUILDER_DATA_DIR
```

`projectRoot` 保存：

```text
editor/
examples/
scripts/
templates/
docs/
package.json
```

`dataRoot` 保存：

```text
resumes.json
resumes/
assets/
backups/
output/
resume.backup.yaml  # 仅为旧版迁移保险，可选
.migration.json
```

简历 YAML schema 和 `resumes.json` schema 保持不变。模板、编辑器代码和通用样例从 `projectRoot` 读取；注册表、真实 YAML、照片、备份及生成结果只从 `dataRoot` 读写。

## 配置解析

新增统一的应用路径模块，编辑器、生成器和迁移器必须共用。`dataRoot` 优先级为：

1. 当前进程的 `RESUME_BUILDER_DATA_DIR`。
2. `projectRoot/.env.local` 中的 `RESUME_BUILDER_DATA_DIR`。
3. `~/Documents/Resume Builder`。

当前机器的 `.env.local` 使用以下格式，真实值只保存在本机：

```dotenv
RESUME_BUILDER_DATA_DIR="/absolute/private/path/resume-builder-data"
```

`.env.local` 必须加入 `.gitignore`。仓库只提交不含私有路径的 `.env.example`。相对路径、空值和无法解析的配置应被拒绝；`dataRoot` 等于或位于 `projectRoot` 内部时也必须拒绝，否则无法实现 Git 隔离。日志中输出最终生效的绝对 `dataRoot`，避免编辑器和命令行使用不同目录却不易察觉。

## 运行时路径边界

现有代码把 `rootDir` 同时当作模板目录和数据目录。V2.1A 改为显式传递应用路径：

```js
{
  projectRoot,
  dataRoot
}
```

- `resume-registry.mjs` 只接收 `dataRoot`，并从中解析 YAML、备份和输出路径。
- `validateResume()` 使用 `dataRoot` 校验 `profile.photo`。
- `generateResume()` 从 `projectRoot/templates` 读取模板和 CSS，从 `dataRoot` 读取内容与照片并写入输出。
- `editor-server.mjs` 从 `projectRoot/editor` 和 `projectRoot/templates` 提供静态代码，从 `dataRoot/output` 和 `dataRoot/assets` 提供用户文件。
- 样例仍由服务端 allowlist 从 `projectRoot/examples` 读取，不能由客户端提交任意路径。

网页 API、iframe URL 和用户操作方式保持不变。`/output/<id>/...` 与 `/assets/...` 只是 HTTP 路径，服务端实际映射到 `dataRoot`。

正式生成的 `output/<id>/preview.html` 必须继续支持脱离编辑器单独查看。由于它不再与 `projectRoot/templates` 位于同一目录，生成时应内联简历 CSS，不能保留依赖旧相对文件结构的样式链接。

## 自动迁移

编辑器和命令行在访问数据前调用同一个 `ensureDataRoot()`。处理顺序如下：

### 目标目录已经存在

- 校验 `resumes.json`、活动 ID、全部注册 YAML 及照片引用。
- 有效时直接使用，不重复迁移。
- 无效时停止启动，绝不合并、覆盖或回退到旧目录。

### 目标目录不存在且项目内存在旧数据

1. 在 `dataRoot` 的同级目录创建唯一临时目录。
2. 复制 `resumes.json`、注册的 `resumes/*.yaml`、`assets/`、`backups/` 和 `output/`。
3. 保留旧版根级备份文件，即使当前 UI 不再展示它们。
4. 对比复制前后的源数据指纹及目标指纹；源数据变化时中止并要求关闭旧编辑器后重试。
5. 校验注册表、全部 YAML、引用照片、可写性和真实路径目录边界。
6. 写入 `.migration.json` 和临时 `.migration-in-progress` 发布标记。
7. 使用同文件系统内的重命名将临时目录原子切换为 `dataRoot`。
8. 再次校验正式路径和源、目标指纹，最后移除发布标记；其他进程在标记存在时等待。

发布前失败会清理当前进程的临时目录。发布后复核失败会把整个目标原子退回原迁移工作目录并保留全部内容，不递归删除可能已被其他进程写入的正式路径，也不删除项目内旧数据。

发布标记记录迁移 PID、时间、类型和来源目录。发布者崩溃后，后续启动只在确认原进程已退出、目标有效且源/目标指纹一致时自动移除标记；否则保留现场并停止，避免把不完整目录当成正式数据。

若编辑器和生成器在首次启动时同时迁移，两者使用不同临时目录；只允许一个进程发布正式目录。另一个进程发现目标已由竞争者创建后，必须清理自己的临时目录、重新校验正式目录并继续使用，不能覆盖或把正常竞争当作损坏数据。

### 两边都没有数据

从脱敏后的公开样例初始化一份简历，复制占位照片，创建合法的 `resumes.json`。程序不能生成字段缺失的空 YAML。

## 公开仓库脱敏

实施前仓库中的以下范围含真实个人信息或其测试副本：

- `resumes.json`
- `resumes/cpp.yaml`
- `examples/cpp.yaml`
- `examples/ai-agent.yaml`
- `assets/photo.png`
- `scripts/editor-server.test.mjs`
- `scripts/render.test.mjs`
- 早期计划文档中的源 PDF 路径和示例内容

V2.1A 必须先完成并验证外部数据迁移，再停止跟踪真实注册表和简历文件。项目内旧数据可以保留为本机忽略文件，满足短期回滚需求，但不能继续进入后续提交。

公开样例改为虚构姓名、联系方式、学校和经历，照片改用现有 `assets/photo.svg` 或新的通用占位图。样例仍需覆盖完整 schema、多 section、链接和排版顺序，确保测试价值不因脱敏下降。

此操作只清理后续提交。Gitee 历史中的旧内容不会自动消失。迁移 GitHub 前应在独立克隆中使用 `git filter-repo` 清理个人文件历史，再推送经过检查的仓库；不在当前阶段强制改写 Gitee 远程历史。

## 写入与错误处理

- 保存、备份、照片上传、恢复和注册表更新继续使用原子写入或先备份后覆盖。
- 所有数据路径必须从已验证 ID 和相对路径推导，不接受客户端绝对路径。
- `dataRoot` 不可写时，启动阶段立即失败并显示实际目录及系统错误。
- 目标目录非空但缺少合法注册表时，禁止自动初始化。
- 迁移源无效时，禁止复制一部分后继续运行。
- 迁移成功后，运行时禁止静默读取 `projectRoot` 中的旧简历。
- 终端至少输出编辑器 URL、当前数据目录以及本次是“已有数据”“迁移完成”还是“样例初始化”。

## 测试策略

自动测试只使用 `mkdtempSync()` 创建的临时目录，不访问真实用户数据目录。

覆盖范围：

- 环境变量、`.env.local` 和默认目录的优先级。
- 带空格路径、`~` 展开、空值和相对路径拒绝。
- 拒绝将 `dataRoot` 配置为 `projectRoot` 或其子目录。
- 拒绝通过符号链接把 `dataRoot`、注册 YAML 或静态文件指向允许目录之外。
- 无旧数据初始化、旧数据迁移、已有有效数据复用。
- 已有无效目标、不可写目标、无效源 YAML、缺照片、复制期间源变化和迁移中断。
- 临时目录校验失败时目标目录不出现。
- 两个首次启动进程竞争时只发布一个有效目标，且无临时目录残留。
- 注册表、编辑器 API、静态资源和生成器分别使用正确根目录。
- 外部 `dataRoot` 中的正式 HTML 预览仍可独立加载完整样式。
- 保存、备份、上传、恢复和输出只改变 `dataRoot`。
- 全部 V2 多简历、实时预览、一页 A4 和点击定位测试继续通过。
- 脱敏样例不包含当前用户的姓名、电话、邮箱或真实照片。

真实迁移前后记录 `resumes.json`、全部 YAML 和照片的 SHA-256，并比较备份与输出文件数量。迁移后人工测试所有简历的切换、编辑、保存、备份和生成，最后确认这些操作不会让代码仓库产生新的数据改动。

## 非目标

V2.1A 不做：

- ZIP 或其他导入导出协议。
- 编辑器中的数据目录选择器。
- 云同步、多设备同步或账号系统。
- 自动清理旧项目数据。
- 自动清理未引用照片。
- Gitee 远程历史重写。
- 模板市场、AI 改写或可视化排版参数。
