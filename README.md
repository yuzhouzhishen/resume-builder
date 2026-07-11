# Resume Builder

本地一页 A4 简历生成器。程序代码与真实简历数据相互独立；每份简历保存在数据目录的 `resumes/<id>.yaml`，正式输出写入同一数据目录的 `output/<id>/`。

当前推荐工作方式是：打开本地网页编辑器，右侧改内容，左侧自动显示实时 A4 草稿，确认后保存并生成正式 PDF。

## 快速开始

```bash
cd ~/Downloads/resume-builder
npm install
npm run editor
```

终端会输出类似：

```text
Resume editor running at http://127.0.0.1:4321
Resume data: /absolute/path/to/resume-builder-data (existing)
```

浏览器打开这个地址。端口 `4321` 被占用时会自动尝试 `4322` 到 `4330`。

日常编辑流程：

1. 在左侧工具栏选择要编辑的简历；`+` 可复制当前简历或从样例新建，`…` 可重命名或删除。
2. 在右侧 `内容编辑` 里修改基本信息、照片、实习经历、专业技能、项目经历。
3. 在 `排版顺序` 里调整实习经历、专业技能、项目经历的显示顺序。
4. 停止输入约 300ms 后，左侧自动更新草稿预览。
5. 点 `保存`，或按 `Cmd/Ctrl + S`，内容写回数据目录中的当前 YAML 并创建独立备份。
6. 点 `生成 PDF`，在数据目录中重新生成当前简历的 PDF、PNG 和独立 HTML 预览。

左侧顶部工具栏中，简历选择器旁的 `数据管理` 用于导出、导入或恢复整套简历数据。

切换简历时若存在未保存草稿，编辑器会提供 `保存并切换`、`放弃修改` 和 `取消`。保存失败时不会切换。

左侧预览可以点击定位：

- 点击姓名、求职意向、学校、专业、电话、邮箱，右侧切到 `基本信息` 并聚焦对应输入框。
- 点击照片，右侧切到 `照片`。
- 点击某一段实习经历、某个技能组、某个项目经历，右侧切到对应内容模块并定位到对应卡片。
- 点击公司、时间、角色、概述、技能标题或 bullet 文本，右侧会定位到对应输入框。

## 当前文档

- [V2.3 数据恢复边界](docs/v2-3-boundaries.md)
- [V2.3 验收清单](docs/v2-3-acceptance-checklist.md)
- [V2.3 数据恢复设计](docs/plans/2026-07-11-v2-3-data-recovery-design.md)
- [V2.3 数据恢复实施计划](docs/plans/2026-07-11-v2-3-data-recovery.md)
- [V2.2 CI 与隐私边界](docs/v2-2-boundaries.md)
- [V2.2 CI 与隐私设计](docs/plans/2026-07-10-v2-2-ci-privacy-design.md)
- [V2.2 CI 与隐私实施计划](docs/plans/2026-07-10-v2-2-ci-privacy.md)
- [V2.1B 当前边界](docs/v2-1b-boundaries.md)
- [V2.1B 验收清单](docs/v2-1b-acceptance-checklist.md)
- [V2.1B 导入导出设计](docs/plans/2026-07-10-v2-1-backup-import-export-design.md)
- [V2.1B 导入导出实施计划](docs/plans/2026-07-10-v2-1-backup-import-export.md)
- [V2.1A 当前边界](docs/v2-1-boundaries.md)
- [V2.1A 验收清单](docs/v2-1-acceptance-checklist.md)
- [V2.1A 数据隔离设计](docs/plans/2026-07-10-v2-1-data-isolation-design.md)
- [V2.1A 数据隔离实施计划](docs/plans/2026-07-10-v2-1-data-isolation.md)
- [V2 当前边界](docs/v2-boundaries.md)
- [V2 人工验收清单](docs/v2-acceptance-checklist.md)
- [V1.1 历史边界](docs/v1-boundaries.md)
- [V0 历史边界](docs/v0-boundaries.md)

## 首次安装

```bash
npm install
```

如果提示 Chromium 缺失：

```bash
npx playwright install chromium
```

如果提示 Poppler 缺失：

```bash
brew install poppler
```

## 数据目录

编辑器、命令行生成器和迁移器共用同一个数据目录。解析顺序是：

1. 进程环境变量 `RESUME_BUILDER_DATA_DIR`。
2. 项目内不会提交 Git 的 `.env.local`。
3. 默认目录 `~/Documents/Resume Builder`。

自定义目录时，在项目根目录创建 `.env.local`：

```dotenv
RESUME_BUILDER_DATA_DIR="/absolute/private/path/resume-builder-data"
```

数据目录必须是代码仓库之外的绝对路径。启动日志会显示最终使用的位置和状态：`existing`、`migrated` 或 `initialized`。

第一次使用新版时，先关闭仍在使用旧项目目录的编辑器或生成命令。如果目标目录不存在但仓库中存在旧版数据，程序会先复制到临时目录，完整校验后原子启用；旧文件不会删除。目标目录已经存在时只校验并读取，绝不自动覆盖或合并。干净克隆且没有旧数据时，会从脱敏样例初始化一份可用简历。

## 数据导出、导入、恢复与换电脑

在左侧预览顶部点击 `数据管理`：

- `导出数据包` 会下载 `resume-builder-backup-YYYYMMDD-HHMMSS.zip`。
- ZIP 包含全部已保存简历、照片和简历备份。
- ZIP 不包含可重新生成的 `output/`、本机 `.env.local` 或迁移状态文件。
- ZIP 未加密，并包含姓名、联系方式和照片，只应保存到可信位置。

导入采用“检查后确认”。检查阶段只在数据目录旁建立临时目录，不修改正式数据；确认后会整套替换当前已保存数据，不会按简历合并。替换前，旧数据目录会完整保留为：

```text
<dataRoot>.pre-import-YYYYMMDD-HHMMSS
```

如果当前有未保存草稿，编辑器会阻止导入。导入包不包含正式输出，因此导入完成后需要重新点击 `生成 PDF`。

`数据管理 -> 恢复历史数据` 用于恢复本机整套历史数据：

- 恢复中心只读取当前数据目录旁、由导入或恢复自动留下的 `pre-import` 和 `pre-restore` 快照，不扫描其他位置。
- 选择的源快照不会被删除或移动，可以重复恢复；提交前的当前完整数据会自动保存为新的 `pre-restore` 快照。
- 当前有未保存草稿时不能恢复，必须先保存或撤销修改。
- 同一个 `dataRoot` 只支持运行一个编辑器进程。恢复前应关闭仍指向该目录的其他 `npm run editor` 进程；V2.3 不创建跨进程锁文件，也没有过期锁或手动清锁流程。
- 恢复成功后会重新载入活动简历和该简历备份，再由现有预览流程异步渲染草稿。草稿预览失败按普通预览错误处理，不会重新执行恢复。快照可能同时带回旧 PDF、PNG 或 HTML，但界面不会把它们视为当前输出，也不会自动生成；确认内容后需要点击 `生成 PDF`。
- 未发布的失败 staging 会保留在数据目录旁以避免误删，可能随失败重试累积；程序不会递归自动清理这些目录。
- 这些历史快照位于活动数据目录之外，不会包含在 ZIP 导出中，也不会随换电脑流程自动转移。

恢复中心与页面底部的 `最近备份` 用途不同：恢复中心替换注册表、全部简历、照片和备份等整套数据；`最近备份` 只恢复当前单份简历的一份 YAML。完整安全边界见 [V2.3 数据恢复边界](docs/v2-3-boundaries.md)。

换电脑推荐流程：

1. 在旧电脑通过 `数据管理 -> 导出数据包` 下载 ZIP，并妥善转移到新电脑。
2. 在新电脑克隆代码，执行 `npm install`；需要自定义数据位置时先配置 `.env.local`。
3. 执行 `npm run editor`，通过 `数据管理 -> 导入数据包` 选择 ZIP。
4. 核对创建时间、简历数量、活动简历和名称列表，再确认整套替换。
5. 导入后逐份检查内容，并按需重新生成 PDF。

仍可以手动复制整个数据目录；可视化导入导出不提供云同步，也不导入 PDF、Word 或第三方简历文件。

## 推荐用法：本地编辑器

启动：

```bash
npm run editor
```

左侧预览分成两种来源：

- 修改内容后显示实时草稿 HTML，不写文件，也不会启动 Playwright 或 Poppler。
- 点击 `生成 PDF` 后切回当前简历正式的 `output/<id>/preview.html`。

草稿请求有约 300ms 防抖，并且只采用最后一次结果。这样可以实时观察排版，又不会在每次输入时生成 PDF。

存在未保存草稿时，刷新、关闭页面或离开编辑器会触发浏览器确认提示。保存成功后不再提示。

预览默认按左侧区域的可用宽度和高度缩放，完整显示一张 A4。浏览器外层页面不会纵向滚动；右侧顶部导航和底部操作区保持可见，只有中间表单区域滚动。

右侧编辑器分成两层：

- `内容编辑`：基本信息、照片、实习经历、专业技能、项目经历。
- `排版顺序`：调整简历 section 的输出顺序。

## 多简历文件模型

```text
$RESUME_BUILDER_DATA_DIR/
  resumes.json
  resumes/<id>.yaml
  backups/<id>/
  output/<id>/
  assets/<id>-photo.png
```

`resumes.json` 保存稳定 ID、显示名称和当前选中 ID。重命名只改变显示名称，不移动 YAML、备份或输出。删除简历会删除对应 YAML、备份和输出，但不会自动删除 `assets/` 中的共享照片；最后一份简历不能删除。

V2.1A 之后，代码仓库不再跟踪真实 `resumes.json`、YAML 或个人照片。本机项目内的旧副本保持忽略状态，只作为迁移保险；日常操作只读写外部数据目录。

## 备份机制

每次覆盖当前简历 YAML 前，服务端会先把旧版本复制为：

```text
$RESUME_BUILDER_DATA_DIR/backups/<id>/resume.backup.yaml
$RESUME_BUILDER_DATA_DIR/backups/<id>/resume-YYYYMMDD-HHMMSS.yaml
```

触发备份的操作包括：

- `保存`
- `载入样例`
- `替换照片`
- `恢复备份`

每份简历的 `resume.backup.yaml` 都是该简历最近一次覆盖前的版本；时间戳备份也按 ID 隔离。迁移前项目目录中的旧备份继续保留，但 V2.1A 不再写入它们。

如果误操作，优先在网页底部的 `最近备份` 下拉框选择一份备份，点击 `恢复备份`。恢复后需要重新点击 `生成 PDF` 才会更新左侧预览和输出文件。

## 命令行生成

不使用网页编辑器时，也可以直接生成：

```bash
npm run generate
```

不带参数时生成 `resumes.json.activeId` 指向的简历。也可以指定 ID：

```bash
npm run generate -- --resume cpp
```

或者：

```bash
./generate
```

输出文件：

- `$RESUME_BUILDER_DATA_DIR/output/<id>/resume.pdf`
- `$RESUME_BUILDER_DATA_DIR/output/<id>/resume.png`
- `$RESUME_BUILDER_DATA_DIR/output/<id>/preview.html`

## 内容结构

数据目录中的每个 `resumes/<id>.yaml` 继续使用原来的内容结构：

```yaml
profile: {}
layout:
  sectionOrder:
    - internships
    - skills
    - projects
skills: []
internships: []
projects: []
```

`layout.sectionOrder` 控制简历 section 顺序。允许的 key 只有：

- `internships`
- `skills`
- `projects`

每个 key 必须出现一次。

## 照片

网页里可以直接替换照片。上传文件使用数据目录中的 `assets/<id>-photo.<ext>`，避免不同简历覆盖彼此的照片。支持格式：

- `.png`
- `.jpg`
- `.jpeg`
- `.webp`
- `.svg`

照片上传通过 JSON data URL 传输，服务端限制请求体和解码后图片大小，默认上限是 `5MB`。

## 样例

内置样例：

- `examples/cpp.yaml`
- `examples/ai-agent.yaml`

在左侧 `+` 菜单使用 `从样例新建` 会创建一份新简历，不覆盖当前内容。网页底部的 `载入样例` 仍用于覆盖当前选中简历，覆盖前会写入该 ID 的备份目录。

## 开发与提交安全

提交或推送代码前运行：

```bash
npm run ci
```

该命令会先检查当前 Git 索引和完整历史中的隐私风险，再运行全部测试。GitHub Actions 会在每次 push 和 pull request 上执行同一个入口。

真实简历 YAML、注册表、照片、备份、生成文件、数据导出 ZIP、`.env.local` 和本机绝对路径不得进入代码仓库。真实数据应始终保存在 `RESUME_BUILDER_DATA_DIR` 指向的仓库外目录。

隐私扫描是提交错误的检测层，不是加密工具，也不能撤回已经推送到远端的内容。发现误提交时应立即停止推送并清理 Git 历史。

## 常见问题

### 为什么改了右侧内容，左侧没有立刻变化？

草稿预览会在停止输入约 300ms 后更新。如果持续不更新，查看底部是否显示字段验证错误，或者确认本地编辑器服务仍在运行。

状态含义：

- `预览更新中`：正在验证和渲染当前草稿。
- `草稿预览`：左侧显示当前未保存内容，尚未写入 YAML。
- `草稿预览失败`：当前草稿暂时无法渲染，左侧保留上一次可用预览。
- `PDF 待生成`：内容已经保存到当前 YAML，但还没有重新生成正式输出。
- `预览已更新`：当前预览和最近一次生成结果一致。
- `保存中`：正在写入数据目录中的当前 YAML，操作按钮会临时禁用，避免重复点击。

### 如何快速保存？

macOS 使用 `Cmd + S`，Windows/Linux 使用 `Ctrl + S`。快捷键调用的仍是页面上的显式保存流程，会写入当前 YAML 并创建该 ID 的备份，不会自动生成 PDF。

### 为什么关闭或刷新页面时出现确认提示？

说明当前还有未保存草稿。选择留在页面后可以继续编辑或保存；保存成功后再次离开不会提示。切换到另一份简历时会使用编辑器内的三选项对话框处理草稿。

### 左侧预览可以直接改内容吗？

不可以。左侧预览只负责查看和选择内容。点击字段后，右侧会切到对应编辑区并聚焦输入框，内容仍然在右侧表单里修改。

### 生成失败，提示一页放不下怎么办？

当前固定一页标准 A4。生成器会依次尝试 `normal -> compact -> tight` 三档密度。如果 `tight` 仍放不下，会报 overflow。通常需要缩短最长 section，或者减少 1-2 条 bullet。

### bullet 里有冒号会不会坏？

YAML 对英文冒号加空格比较敏感，例如：

```yaml
- 技术栈: C++、哈希表、位图、多线程编程。
```

读取层已经会把常见的单键对象误解析恢复成普通文本。手写 YAML 时仍建议加引号：

```yaml
- "技术栈: C++、哈希表、位图、多线程编程。"
```

### 照片上传失败怎么办？

检查格式和大小。只支持上面列出的图片格式，默认最大 `5MB`。

### 端口打不开怎么办？

确认 `npm run editor` 还在运行。`npm run generate` 只生成文件，不会启动网站。如果浏览器显示 `ERR_CONNECTION_REFUSED`，通常是本地编辑器服务没有启动或已经退出。

### 提示前端和后端版本不一致怎么办？

这通常是改了代码后浏览器加载到新版前端，但终端里的旧 `npm run editor` 进程还没重启。回到终端按 `Ctrl+C` 停止，然后重新运行：

```bash
npm run editor
```

### 为什么预览点击定位和蓝色高亮突然没有了？

旧版本生成的 HTML 预览可能缺少字段定位标记。编辑器检测到这种情况时会显示“当前预览由旧版本生成”，点击 `生成 PDF` 重新生成当前 ID 的输出后即可恢复。单独点击 `刷新预览` 只会重新加载现有文件，不会重建定位标记。

## 边界

- 固定输出一页标准 A4。
- 不导出 Word。
- 不支持多模板。
- 不做 AI 改写。
- 自动适配只调整密度，不会删除或重写内容。
- 实时草稿预览不自动保存，也不自动生成 PDF。

更完整的边界说明见 [docs/v2-boundaries.md](docs/v2-boundaries.md)。
