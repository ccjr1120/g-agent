---
name: memory-manager
description: 用户记忆的写入与维护：记住、列出、搜索、修改、删除记忆时启用。查询类需求优先直接用系统提示里的 ## Memory，不必先加载本 skill。
---

## 本 skill 的定位

| 项 | 说明 |
|----|------|
| **类型** | 内置 skill（builtin），随内置 `default` agent 分发 |
| **skill 文件位置** | g-agent 包内 `builtin/default/builtin-skills/memory-manager/`；**安装时不复制**到 `~/.config/g-agent/` |
| **LLM 如何获知** | 系统提示词 `## Built-in skills` 中仅列 name、description 与路径；任务匹配时用 `read` 加载本 SKILL.md |
| **脚本路径** | `{{skill_dir}}/scripts/memory.mjs`（加载时已替换为磁盘实际路径） |
| **本 skill 写入的数据** | `~/.config/g-agent/agents/<agent>/memory.md`（见下文） |

## 读取 vs 写入

会话启动时，当前 agent 的 `memory.md` 会自动注入系统提示的 `## Memory` 段。

- **查/用记忆**（打开某个别名、找路径、回忆偏好等）：直接看系统提示里的 `## Memory`，不要再 `list` / `read`。
- **改记忆**（记住、更新、删除、显式「列出全部记忆」）：用本 skill 的脚本；改完后以脚本输出为准，本轮不必再读文件。

## 记忆文件

记忆存储在**用户配置目录**，按当前 agent 隔离，不在 skill 源码目录：

```
~/.config/g-agent/agents/<agent>/memory.md
```

每条记忆格式：

```
- [YYYY-MM-DD] <内容>
```

用 `paths` 查看当前 agent 的实际路径：

```bash
node "{{skill_dir}}/scripts/memory.mjs" paths
```

## 记忆脚本

优先用脚本管理记忆，不要手工拼接 `memory.md`，除非脚本运行失败。

脚本路径：`{{skill_dir}}/scripts/memory.mjs`

可用命令：

```bash
node "{{skill_dir}}/scripts/memory.mjs" paths [--json]
node "{{skill_dir}}/scripts/memory.mjs" list
node "{{skill_dir}}/scripts/memory.mjs" search "<关键词>"
node "{{skill_dir}}/scripts/memory.mjs" get <id>
node "{{skill_dir}}/scripts/memory.mjs" add "<内容>"
node "{{skill_dir}}/scripts/memory.mjs" update <id> "<新内容>"
node "{{skill_dir}}/scripts/memory.mjs" delete <id>
```

需要结构化结果时加 `--json`。

## 写入记忆

当用户说「记住……」「记一下……」「帮我记……」或类似表达时：

1. 先对照系统提示 `## Memory`（或 `list` / `search`）判断是否已有等价或冲突内容
2. 无等价内容时，用 `bash` 执行：

```bash
node "{{skill_dir}}/scripts/memory.mjs" add "<内容>"
```

3. 回复「已记住：<内容>」

如果已有等价内容，不重复写入，直接说明已存在。

## 查询记忆

当用户显式询问「我有哪些记忆」「列出记忆」「搜索记忆」「查一下记忆里有没有……」时：

- 若只需引用已知内容：直接用系统提示 `## Memory`
- 列出全部（要带 `#id`）：`node "{{skill_dir}}/scripts/memory.mjs" list`
- 关键词搜索：`node "{{skill_dir}}/scripts/memory.mjs" search "<关键词>"`
- 查看单条：`node "{{skill_dir}}/scripts/memory.mjs" get <id>`

回答时保留 `#<id>`，方便用户后续修改或删除。

## 更新记忆

当用户要求「修改记忆」「把第 N 条改成……」「更新关于……的记忆」时：

1. 先用 `list` 或 `search` 定位目标记忆
2. 若目标不明确，询问用户要修改哪一条
3. 目标明确后执行：

```bash
node "{{skill_dir}}/scripts/memory.mjs" update <id> "<新内容>"
```

4. 回复「已更新 #<id>：<新内容>」

## 删除记忆

当用户要求「删除记忆」「忘记……」「删掉第 N 条」时：

1. 先用 `list` 或 `search` 定位目标记忆
2. 若目标不明确，询问用户要删除哪一条
3. 目标明确后执行：

```bash
node "{{skill_dir}}/scripts/memory.mjs" delete <id>
```

4. 回复「已删除 #<id>：<原内容>」
