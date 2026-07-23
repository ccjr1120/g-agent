# g-agent TUI UI 规范

本规范定义 g-agent 终端界面的颜色、样式与使用场景。实现代码集中在 `src/ui/theme.rs`，所有 UI 组件应通过该模块引用颜色，避免在组件内硬编码 `Color::*`。

## 设计原则

1. **单一来源**：颜色与语义样式只在 `theme.rs` 定义。
2. **语义优先**：按用途（用户消息、警告、禁用态等）命名，而不是按颜色名（Cyan、Yellow）命名。
3. **终端友好**：默认依赖 256/16 色终端配色；正文尽量使用终端默认前景色，保证在不同主题下可读。
4. **层次清晰**：品牌色用于交互与关键信息，灰色用于次要信息，黄/红仅用于状态反馈。

## 品牌色

| Token | 颜色 | 用途 |
| --- | --- | --- |
| `palette::BRAND` | Cyan | 主品牌色：用户输入、状态栏关键值、Banner、连接指示、菜单选中项 |

品牌色代表「当前可操作 / 需要关注」的信息，不应大面积铺满正文区域。

## 语义色

| Token | 颜色 | 样式 helper | 用途 |
| --- | --- | --- | --- |
| `palette::SUCCESS` | Green | `style::success()` | 成功提示（如复制成功） |
| `palette::WARNING` | Yellow | `style::warning()` | 非阻断警告、历史滚动提示、上下文用量偏高 |
| `palette::ERROR` | Red | `style::error()` | 错误信息、上下文用量临界 |
| `palette::MUTED` | DarkGray | `style::muted()` | 次要文字、提示、边框、禁用态、工具调用标签 |

## 对话区（Transcript）

| 元素 | Helper | 说明 |
| --- | --- | --- |
| Banner | `style::banner()` | 启动 Banner，品牌色加粗；顶部预留 2 行空白 |
| 欢迎/引导文案 | `style::welcome()` | 灰色说明文字 |
| Agent 回退警告 | `style::warning()` | 配置的 agent 不存在时的提示 |
| 用户消息 | `style::user_message()` | `> ` 前缀与正文均为品牌色 |
| 助手 bullet | `style::assistant_bullet()` | `●` 加粗，正文使用终端默认色 |
| 思考过程 | `style::thinking()` | 灰色斜体，显示在正式回复之前 |
| 工具调用 | `style::tool_call()` | 灰色单行标签 |
| 耗时 | `style::muted()` | 如 `· 1.2s` |
| 等待 spinner | `spinner_line(...)` | 见下方 Spinner |

助手正文中的 Markdown（代码块、链接等）目前由 `markdown_ratatui` 默认主题渲染，后续可对齐本规范。

## 输入区（Composer）

| 元素 | Helper | 说明 |
| --- | --- | --- |
| 输入框（可用） | `style::composer_active()` | 品牌色 |
| 输入框（禁用） | `style::composer_disabled()` | 灰色 |
| 命令菜单选中项 | `style::menu_selected()` | 品牌色加粗 |
| 命令菜单描述 | `style::menu_description()` | 灰色 |
| 菜单提示行 | `style::muted()` | 如 `Commands · ↑↓ select ...` |
| 上下边框 | `style::border()` | 灰色 |

## 状态栏（Status Bar）

布局：**左侧**连接状态（品牌色），**右侧** Model / Agent / 上下文（字符画 icon + 灰色次要信息，环承载用量语义色）。

| 元素 | Helper | 说明 |
| --- | --- | --- |
| 连接图标 | `style::status_icon()` | 品牌色，左侧 `●` / `○`，距左缘 1 列 |
| 连接标签 | `style::status_label()` | 灰色，如 `Connected` |
| Model 图标 | `style::status_label()` | 灰色，`◇` |
| Agent 图标 | `style::status_label()` | 灰色，`◎` |
| 字段值 | `style::status_meta()` | 灰色，Model / Agent 名称、上下文百分比 |
| 上下文环轨道 | `style::context_track()` | 灰色，百分比右侧 |
| 上下文环填充 | `style::context_usage(percent)` | `<75%` 品牌色，`≥75%` 黄，`≥90%` 红 |

## 全局反馈（App chrome）

| 元素 | Helper | 说明 |
| --- | --- | --- |
| 成功通知 | `style::success()` | 绿色单行 |
| 历史滚动提示 | `style::warning()` | 黄色单行 |
| 错误条 | `style::error()` | 红色单行 |

## Spinner

| 元素 | Helper | 说明 |
| --- | --- | --- |
| 动画帧 | `style::spinner_frame()` | 黄色 |
| 标签文字 | `style::spinner_label()` | 灰色 |
| 仅计时（dim 模式） | `style::muted()` | 整行灰色 |

## 使用示例

```rust
use crate::ui::theme::{palette, style};

// 推荐：语义 helper
Paragraph::new(text).style(style::error());

// 需要原始颜色时
Span::styled(label, style::brand());
// 或
Span::styled(label, ratatui::style::Style::default().fg(palette::BRAND));
```

## 变更流程

1. 先在本文档更新 token 与用途说明。
2. 在 `theme.rs` 增加或调整常量 / helper。
3. 将相关 UI 组件迁移到新 token。
4. 避免在 `transcript.rs`、`composer.rs` 等组件中直接写 `Color::Cyan` 等硬编码值。
