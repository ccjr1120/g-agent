# g-agent TUI UI 规范

本规范定义 g-agent 终端界面的颜色、样式与使用场景。实现代码集中在 `src/ui/theme.rs`，所有 UI 组件应通过该模块引用颜色，避免在组件内硬编码 `Color::*`。

## 设计原则

1. **单一来源**：颜色与语义样式只在 `theme.rs` 定义。
2. **语义优先**：按用途（用户消息、警告、禁用态等）命名，而不是按颜色名（Cyan、Yellow）命名。
3. **终端友好**：默认依赖 256/16 色终端配色；正文尽量使用终端默认前景色，保证在不同主题下可读。
4. **层次清晰**：品牌色用于交互与关键信息，灰色用于次要信息，黄/红仅用于状态反馈。
5. **消息单一归属**：除纯状态 UI 外，所有面向用户的文本回复、命令反馈、成功提示、警告与错误都必须按发生顺序进入 Transcript 消息列表，不得以长期悬挂的独立通知条或错误条展示。

### 消息与状态的边界

以下内容属于状态 UI，可以独立于消息列表显示：

- Status Bar 中的连接状态、当前 Model、当前 Agent 和上下文用量。
- Sub Agents 区域中的任务状态、活动、耗时与未读标记。
- 输入补全菜单、滚动位置提示、等待动画等瞬时界面状态。

### Agent 子会话

- 启动时直接进入内置 `default` 主会话；它正常处理普通对话，但不出现在 Sub Agents 区域，也不能调用其他 Agent。
- 所有 `/agent <name>` 候选直接平铺在一级 Slash Command 菜单，不得使用 `/agent` 二级菜单。
- `/<编号>` 进入已有子会话，`⌘0` / `Alt+0` / `/0` 快速返回 `default` 主会话，`/back` 作为兼容命令保留；各子会话拥有独立 Transcript。
- 子会话第一条用户消息必须原样发送并作为固定标题，不经过其他 Agent扩写。
- Sub Agents 中每个会话使用两行：第一行显示 `/<编号> <标题>`，第二行固定显示 Agent、状态、活动和耗时。
- 标题根据可用显示宽度截断并添加 `…`，不得挤占或隐藏状态行。

### Plan 区域

- `update_plan` 的结构化步骤不得作为普通工具调用混入 Transcript。
- 进行中的 Plan 固定显示在 Transcript 下方的独立边框区域，标题展示完成数与总数；一旦所有步骤完成，Plan 会转成一条普通助手消息插入 Transcript（随历史滚动），固定面板随即消失。
- 已完成、进行中、待处理步骤分别使用成功色、品牌色和弱化色；进行中步骤必须有最高视觉优先级。
- 主会话与各子会话独立保存 Plan，切换会话时同步切换展示。
- 区域最多展示 5 个步骤；步骤更多时以当前步骤为中心显示相邻内容，避免过度压缩 Transcript。

### Ask 区域

- 有 `ask_user` 阻塞提问待回答时，顶部显示独立的 Ask 面板（标题为 `" Ask (i/n) "`，多个问题待答时显示计数），展示当前问题的换行正文、可选项和操作提示；其交互解答面用 `style::ask()` / `style::ask_hint()` 渲染。
- `←`/`→` 切换待回答问题（`(i/n)` 计数随之更新）；带选项的问题用 `↑`/`↓` 高亮当前项、`Enter` 直接选择该选项发送；无选项时提示 `Type your answer and press Enter (Esc to skip)`，直接在输入框输入回答。
- `Esc` 跳过当前问题，向 Agent 发送 `skip` 让其按最佳假设继续。
- Transcript 仍保留问题与回答作为历史记录（问题用品牌色 `? ` 前缀），但**交互解答的面板始终固定在屏幕顶部**，不会因滚动而脱离可视区域。

以下内容必须进入 Transcript：

- Agent 回复和子 Agent主动选择后展示的结果。
- Slash Command 的执行结果与用法提示。
- 开关状态反馈、复制/导出结果、重载与重连反馈。
- 面向用户的警告、失败原因和错误信息。
- `ask_user` 的阻塞提问与用户的回答。

本地反馈应使用区别于 `user` / `assistant` 的消息角色，避免写入发送给模型的会话历史，但渲染顺序必须与普通消息一致。

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
| 助手 bullet | `style::assistant_bullet()` | `●` 加粗，正文使用终端默认色；同一轮回复只出现一次，后续正文块使用 `  ` 续行缩进对齐 |
| 思考过程 | `style::thinking()` | 灰色斜体，显示在正式回复之前 |
| 工具调用 | `style::tool_call()` | 灰色单行标签，`▸ ` 前缀（不使用 emoji 图标），与正文同一列对齐 |
| 耗时 | `style::muted()` | 如 `· 1.2s` |
| 等待 spinner | `spinner_line(...)` | 见下方 Spinner；整轮进行中持续显示，直到回合结束 |
| ask_user 提问 | `style::ask()` | 品牌色 `? ` 前缀，区别于系统反馈，等待用户回答 |
| ask_user 选项 | `style::ask()` / `style::ask_hint()` | 提问带离散选项时，选项直接渲染在问题下方（Transcript 内，`❯` 高亮当前项）；交互选择在顶部 Ask 面板进行 |
| ask_user 回答模式 | `style::ask()` | 当前问题固定显示在顶部 Ask 面板（见 Ask 区域）；**Esc** 跳过该问题让 Agent 继续 |
| 多问题切换 | — | 一轮中出现多个待回答问题时（Agent 并行 `ask_user`），各问题带独立 `id` 全部保留，`←` `→` 在问题间切换（Ask 面板标题显示 `(i/n)` 计数），每个问题可独立回答或跳过 |

助手正文中的 Markdown（代码块、链接等）目前由 `markdown_ratatui` 默认主题渲染，后续可对齐本规范。

## 输入区（Composer）

| 元素 | Helper | 说明 |
| --- | --- | --- |
| 输入框（可用） | `style::composer_active()` | 品牌色 |
| 输入框（禁用） | `style::composer_disabled()` | 灰色 |
| ask_user 回答提示 | `style::ask_hint()` | 灰色提示，仅出现在顶部 Ask 面板内（如选择无选项问题时的 `<Type your answer and press Enter (Esc to skip)>`，或导航按键 `←/→ question · ↑/↓ select · Enter answer · Esc skip`），不再占用输入框首行 |
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

## 本地反馈消息

成功通知、命令反馈和错误统一渲染在 Transcript 中。成功/普通反馈可沿用助手正文布局，错误使用 `style::error()`；不得为这些反馈增加独立的 App chrome 行。历史滚动提示属于纯状态 UI，可以保留在 Transcript 外。

## Spinner

| 元素 | Helper | 说明 |
| --- | --- | --- |
| 动画帧 | `style::spinner_frame()` | 黄色 |
| 标签文字 | `style::spinner_label()` | 灰色 |
| 仅计时（dim 模式） | `style::muted()` | 整行灰色 |

`Thinking…` / `Working…` 加载指示在整轮对话进行期间（推理、跑工具、正文流式输出或两次输出之间的停顿）持续显示，仅在回合结束（`waiting` 清空）后消失，避免画面看起来卡住。

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
