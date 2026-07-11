# Resume Builder V2.4 Limited Layout Controls Boundaries

Date: 2026-07-11

## Goal And Workflow

V2.4 在现有单模板、一页标准 A4 的基础上增加每份简历独立的有限排版设置。内容编辑、照片、模块顺序、多简历、备份、导入导出、恢复和隐私边界保持不变。

1. 在右侧打开 `排版设置`。
2. 选择 `自动适配` 或 `固定参数`，调整正文字号、行高、内容间距和页边距。
3. 左侧草稿按与正式生成器相同的候选规则测量，并显示实际生效参数和 A4 状态。
4. 保存只写入当前简历 YAML；点击 `生成 PDF` 后，生成器重新读取已保存数据并独立测量。

## Per-Resume Data

设置保存在每份 `resumes/<id>.yaml` 内：

```yaml
layout:
  sectionOrder:
    - internships
    - skills
    - projects
  mode: auto
  fontSizePt: 10.8
  lineHeight: 1.38
  spacingLevel: 67
  marginPreset: normal
```

- `mode`: `auto` 或 `fixed`。
- `fontSizePt`: `10.2` 至 `11.2`，步长 `0.1pt`。
- `lineHeight`: `1.25` 至 `1.42`，步长 `0.01`。
- `spacingLevel`: `0` 至 `100` 的整数。
- `marginPreset`: `narrow`、`normal` 或 `wide`。

旧 YAML 只含 `layout.sectionOrder` 时继续有效。加载不会写文件；编辑器在内存中补齐默认值，下一次用户显式保存该简历时写入完整设置。复制简历、单份备份、数据包导入导出和整套恢复都会自然携带这些字段。

## Spacing And Margin Semantics

`spacingLevel` 是抽象紧凑度，不是百分比：

| Level | UI | Meaning |
| ---: | --- | --- |
| `0` | 紧凑 | 原最紧间距下界 |
| `50` | 较紧 | 原 compact 间距 |
| `67` | 标准 | 默认间距 |
| `100` | 宽松 | 有限放宽后的上界 |

中间值分别线性插值条目、section、经历和 bullet 缩进变量，不按统一百分比缩放。

页边距是 A4 页面内部 padding：`narrow` 为 `6mm / 4mm`，`normal` 为 `8mm / 6mm`，`wide` 为 `10mm / 8mm`。A4 尺寸、打印页边距、照片尺寸和基本信息结构不可编辑。

## Auto And Fixed Modes

自动模式从用户偏好开始，按确定顺序尝试：

1. 降低内容间距到 `0`。
2. 将页边距逐步收窄到 `narrow`。
3. 将行高逐步降到 `1.25`。
4. 将正文字号逐步降到 `10.2pt`。

每一阶段保留前一阶段已经达到的值。首个同时满足横向和纵向 A4 容差的候选生效；达到所有下界后仍溢出则停止，不再缩小。

固定模式只测量用户指定的一组参数，不自动压缩。草稿和正式生成分别测量，浏览器草稿结果不会被正式生成器直接信任。

## Save And Generate Boundary

- 溢出不会阻止保存 YAML，便于保留未完成草稿。
- 已知溢出会禁用 `生成 PDF`，避免发布裁切或不完整文件。
- 回到可放入 A4 的设置并保存后，生成操作恢复。
- 正式生成若失败或溢出，不替换上一份 PDF、PNG 或 HTML。
- 状态栏显示实际生效参数以及 `A4 单页`、`A4 待测量` 或 `超出 A4 Npx`，不会预先承诺单页。

## Validation And Security

- 未知 key、非法枚举、非有限数字、越界值和错误步长由服务端拒绝。
- 草稿接口只返回白名单化的 CSS 变量；浏览器再次按变量名白名单应用。
- API 和错误不回显 YAML 内容、个人信息或绝对路径。
- 真实 YAML、照片、备份、输出和数据 ZIP 继续保存在 Git 仓库外的数据目录中。

## Explicit Non-Goals

V2.4 不提供：

- 每个 section、卡片、字段或 bullet 的单独字号与间距。
- 自定义 CSS、颜色主题、模板切换或任意页面尺寸。
- 照片尺寸调整、拖拽排序或内容折叠。
- 多页简历、Word 导出、AI 改写或自动删减内容。
- 精确判断是哪一个 YAML 字段导致溢出。

