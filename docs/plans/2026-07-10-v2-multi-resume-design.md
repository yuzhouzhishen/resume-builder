# V2 多份简历管理设计

日期：2026-07-10

实施状态：V2 第一阶段已完成。当前实现包含多简历清单、隔离 API、左侧工具栏管理、未保存切换保护、独立备份与输出，以及 102 项自动化测试。具体边界和验收结果见 `docs/v2-boundaries.md` 与 `docs/v2-acceptance-checklist.md`。

## 目标

在保留现有一页 A4、实时草稿预览、显式保存、备份和 PDF 生成边界的前提下，让 C++、AI Agent、实习优先等定向简历可以同时存在、独立编辑和独立生成。

## 非目标

V2 第一阶段不做：

- 空白简历创建。
- 在线账号、云同步或多人协作。
- AI 改写。
- 模板市场。
- 多页简历。
- 可视化字号、边距和间距控制。
- 自动保存或输入时自动生成 PDF。

## 文件模型

每份简历继续使用现有 YAML 结构，不向 YAML 增加名称、ID 等管理字段。管理信息放在根目录 `resumes.json`：

```json
{
  "activeId": "cpp",
  "items": [
    {
      "id": "cpp",
      "name": "C++ 应届生",
      "file": "resumes/cpp.yaml"
    }
  ]
}
```

目录结构：

```text
resumes/
  cpp.yaml
  ai-agent.yaml
resumes.json
assets/
  cpp-photo.png
  ai-agent-photo.png
backups/
  cpp/
  ai-agent/
output/
  cpp/
    preview.html
    resume.pdf
    resume.png
  ai-agent/
    preview.html
    resume.pdf
    resume.png
```

`id` 是稳定内部标识。重命名只修改显示名称，不移动 YAML、备份或输出。新 ID 优先由英文名称生成安全 slug；无法生成时使用 `resume-N`，并保证不重复。

`assets/` 是共享目录，但照片上传文件名必须包含当前简历 ID。删除简历不自动删除照片，避免误删其他简历仍在引用的共享资源。

## 迁移

实施时通过 Git 将当前 `resume.yaml` 移动为 `resumes/cpp.yaml`，原内容和历史不变，并创建只包含这一份简历的 `resumes.json`。

当前根目录的旧备份保留，不自动删除或搬移，作为迁移保险。V2 之后的新备份写入 `backups/<resumeId>/`。根目录旧输出不再更新，新输出写入 `output/<resumeId>/`。

迁移完成后，README 明确新的文件位置和命令。服务启动时若清单或当前 YAML 缺失，应给出清晰错误，不静默创建空内容。

## 服务端边界

新增简历清单模块，集中负责：

- 读取和验证 `resumes.json`。
- 根据 allowlist 解析 `resumeId`，禁止客户端传入任意路径。
- 获取当前简历 YAML、备份目录和输出目录。
- 创建稳定且不重复的 ID。
- 原子写入清单，避免写到一半破坏所有简历入口。

API 设计：

- `GET /api/resumes`：返回清单和 `activeId`。
- `POST /api/resumes/duplicate`：复制当前或指定简历并切换。
- `POST /api/resumes/from-example`：从 allowlist 样例创建并切换。
- `PATCH /api/resumes/:id`：重命名。
- `DELETE /api/resumes/:id`：删除简历数据，禁止删除最后一份。
- `POST /api/resumes/:id/activate`：切换 `activeId`。
- 现有 resume、preview、generate、backup、photo API 接收 `resumeId`，并只操作对应目录。

名称 trim 后不能为空，且大小写不敏感地保持唯一。非法 ID、未知 ID、路径穿越、重复名称和删除最后一份都返回明确的 `400` 错误。

## 生成与命令行

网页生成当前选中的简历，输出到 `output/<resumeId>/`。左侧 iframe 和“打开 PDF”始终使用当前 ID 的 URL。

命令行：

```bash
npm run generate
npm run generate -- --resume cpp
```

不带参数时读取 `resumes.json.activeId`。指定未知 ID 时失败并列出可用 ID。三档密度和一页 A4 规则保持不变。

## UI 布局

多简历入口放在左侧预览工具栏，而不是右侧编辑器：

```text
[C++ 应届生 ▾] [+] […]   [密度][A4][未保存][草稿预览]   [刷新预览][打开 PDF]
```

- 选择器切换当前简历。
- `+` 菜单提供“复制当前简历”和“从样例新建”。
- `…` 菜单提供“重命名”和“删除”。
- 图标按钮提供 tooltip 和 `aria-label`。
- 宽屏保持单行；预览区域较窄时状态标签进入第二行。
- 右侧内容编辑、排版顺序和保存按钮位置不变。

删除和重命名使用居中对话框。只剩一份简历时删除项禁用，并解释原因。

## 切换与未保存状态

当前草稿未保存时切换简历，显示三选项对话框：

- `保存并切换`：先保存，成功后激活目标简历。
- `放弃修改`：丢弃内存草稿，直接激活目标简历。
- `取消`：关闭对话框，保留当前状态。

保存失败时不得切换。切换成功后同时刷新右侧表单、备份列表、生成状态、预览 URL 和打开 PDF 地址。

新创建的简历状态为 `PDF 待生成`，不会自动生成。若没有磁盘预览，左侧立即使用当前 YAML 渲染草稿 `srcdoc`，避免空白或继续显示上一份简历。

## 创建、重命名与删除

复制当前简历时复制 YAML 和排版顺序，不复制备份或输出。用户先输入新名称，创建成功后自动切换。

从样例新建复用现有样例 allowlist，写入新的 YAML，不覆盖当前简历。V2 第一阶段不提供完全空白简历。

重命名只修改清单。删除时使用居中确认对话框，明确展示名称，并删除对应 YAML、备份目录和输出目录；共享照片保留。删除当前简历后激活清单中的相邻简历。

## 测试与验收

自动测试覆盖：

- 清单解析、验证、原子保存和安全 ID 生成。
- 当前 `resume.yaml` 到 `resumes/cpp.yaml` 的迁移结果。
- 复制、样例新建、重命名、激活和删除。
- 禁止删除最后一份、重复名称、未知 ID 和路径穿越。
- 每份简历的保存、备份、恢复、照片和输出隔离。
- 命令行默认生成当前简历和 `--resume` 指定生成。
- 未保存切换的保存、放弃和取消三条路径。
- 切换后预览、表单、备份和 PDF 地址同步。
- 宽屏和窄屏工具栏布局无裁切、无重叠。
- 全部 V1.1 一页 A4、实时预览和点击定位测试继续通过。

人工验收至少使用两份内容明显不同的简历，确认任何保存、生成、恢复或照片操作都不会改变另一份简历。
