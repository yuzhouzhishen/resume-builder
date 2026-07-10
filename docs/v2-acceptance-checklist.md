# Resume Builder V2 Acceptance Checklist

Date: 2026-07-10

V2 继续执行 [V1.1 验收项](v1-acceptance-checklist.md)，并增加多简历管理和数据隔离检查。

## Automated Check

```bash
npm test
npm run generate
npm run generate -- --resume cpp
pdfinfo output/cpp/resume.pdf
```

2026-07-10 验证结果：

- `npm test`：102 项通过，0 项失败。
- 真实生成选择 `tight`，写入 `output/cpp/preview.html`、PDF 和 PNG。
- `pdfinfo`：1 页，`595.92 x 842.88 pts (A4)`。
- 原 `resume.yaml` 与迁移后的 `resumes/cpp.yaml` SHA-256 一致。
- 1440x900 和 1024x900 下页面、工具栏、完整 A4 和右侧底栏均无横向或纵向溢出。
- 重命名弹窗在 1024x900 居中显示，无字段误显、裁切或重叠。
- 浏览器控制台无页面错误。

## Resume Selector

1. 左侧选择器显示 `resumes.json` 中全部简历。
2. 切换一份没有未保存修改的简历。

期望：

- 右侧表单、文件标签和备份列表切换到目标 ID。
- 左侧磁盘预览和“打开 PDF”使用 `output/<id>/`。
- 上一份简历内容不会残留。
- 无论当前选中第几份简历，选择菜单都从触发控件下方向下展开，不随选中项向上偏移。

## Dirty Switching

修改字段但不保存，然后切换简历，分别测试三种操作。

期望：

- `取消` 保留当前 ID 和草稿。
- `放弃修改` 切换到目标 ID，磁盘 YAML 不变。
- `保存并切换` 先保存当前 YAML，再激活目标。
- 模拟保存失败时不调用激活接口，当前 ID 和草稿保持不变。

## Create Rename Delete

1. 复制当前简历。
2. 从 `cpp` 或 `ai-agent` 样例新建。
3. 重命名新简历。
4. 删除新简历。

期望：

- 新 ID 稳定、安全且不重复。
- 新建不会复制备份或输出，并先显示草稿预览和 `PDF 待生成`。
- 空名称和规范化后的重复名称被拒绝。
- 重命名不改变 ID 或路径。
- 删除只清理对应 YAML、备份和输出，共享照片保留。
- 只剩一份时删除入口禁用，服务端也拒绝删除。

## Isolation

准备两份内容明显不同的简历，分别执行保存、草稿预览、生成、备份列表、恢复和照片上传。

期望：

- 每次操作只改变请求中 `resumeId` 对应的 YAML 或目录。
- 另一份 YAML 字节内容保持不变。
- 备份列表不混入其他 ID。
- 照片文件名包含当前 ID。
- 未知 ID 和路径型 ID 在文件操作前返回 `400`。

## CLI

1. 修改 `resumes.json.activeId` 后执行 `npm run generate`。
2. 执行 `npm run generate -- --resume cpp`。
3. 指定未知 ID。

期望：

- 默认命令生成 active ID。
- 显式命令只写指定 ID 的输出目录。
- 未知 ID 失败并列出可用 ID。
