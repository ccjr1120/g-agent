---
name: create-agent
description: 当用户明确要求「创建 / 新建 / 加一个 agent」时启用，引导梳理 name / 描述 / system prompt / 技能，并在 ~/.config/g-agent/agents/<name>/ 下生成 agent.json、system.md 与可选技能，随后提示用 /agent <name> 切换验证
---

为 g-agent 创建一个新的 agent。新 agent 统一放在用户目录：

```
~/.config/g-agent/agents/<name>/
  agent.json              # 必需，{ "description": "..." }
  system.md               # 可选，该 agent 的 system prompt；缺失则继承内置 default 的
  builtin-skills/         # 可选，该 agent 的内置技能
    <skill>/SKILL.md
  skills/                 # 可选，该 agent 的用户技能
    <skill>/SKILL.md
```

> 路径中的 `~` 会由 `write` 工具自动展开到家目录并创建所需父目录，直接写 `~/.config/g-agent/agents/<name>/...` 即可，无需先 `mkdir`。

## 触发

仅当用户明确要求创建 agent（如「创建一个 agent」「新建一个 agent」「加一个 xxx agent」「帮我做一个 agent」）时启用本技能。普通对话、改配置、加技能但不新建 agent 等不触发。

## 创建流程（引导式）

### 1. 澄清四个要素

逐项与用户确认（已有的直接沿用，未提及的主动询问或给出合理默认）：

- **name** — agent 目录名与 `/agent <name>` 的切换名。小写、连字符分隔，如 `code-reviewer`、`translation-helper`。
- **description** — 写进 `agent.json` 的一句话描述，用于 `/agent` 列表里区分。如「专注代码审查的助手」。
- **system prompt** — 写进 `system.md` 的角色设定：身份、能力边界、语气、是否主动用工具等。若用户想要默认行为，可省略 `system.md`，该 agent 会继承内置 `default` 的 system prompt。
- **skills** — 该 agent 要自带哪些技能。可选。激活某 agent 时**只加载它自己的技能**（完全替换，不读全局技能目录），所以若该 agent 需要 `memory` 这类基础技能，需显式为其内置。

> 参考：内置 `default` agent 的 `system.md` / `builtin-skills/memory/SKILL.md` 是现成范例，必要时可先用 `read` 取一份作为模板。

### 2. 生成文件

按确认结果用 `write` 创建文件：

- **始终写** `~/.config/g-agent/agents/<name>/agent.json`：
  ```json
  {
    "description": "<description>"
  }
  ```
- 用户给了 system prompt 时，写 `~/.config/g-agent/agents/<name>/system.md`（纯文本，无 frontmatter）。
- 用户要技能时，每个技能建 `~/.config/g-agent/agents/<name>/builtin-skills/<skill>/SKILL.md`，其 frontmatter 至少含 `name` 与 `description`：

  ```markdown
  ---
  name: <skill>
  description: <何时启用此技能的一句话>
  ---

  <技能正文：触发条件、操作步骤、约定路径等>
  ```

  若该 agent 需要 `memory` 能力，复制内置 `default` 的 memory SKILL.md 内容到 `~/.config/g-agent/agents/<name>/builtin-skills/memory/SKILL.md`（可先 `read` 内置那份作模板）。

### 3. name 冲突检查

同名时用户 agent 会覆盖内置同名 agent；若用户目录下已存在同名 agent，创建前先告知用户将覆盖，确认后再写。

## 验证与交付

文件写完后：

1. 用 `bash` 执行 `ls -R ~/.config/g-agent/agents/<name>` 列出生成的结构，向用户确认无误。
2. 告知用户切换方式：

   - 重启 g-agent 并在 `config.json` 里把 `agent` 设为 `<name>`，使其成为默认 agent；或
   - TUI 运行中直接输入 `/agent <name>` 即时切换（会清空当前对话、重载技能与 system prompt）。

3. 简述该 agent 自带的技能清单（若有），并提示「激活该 agent 时只加载它自己的技能，不读全局技能目录」。

## 约束

- 只在 `~/.config/g-agent/agents/` 下创建，不写仓库源码目录。
- 不修改 `config.json` 的 `agent` 字段（交给用户决定是否设为默认）；若用户要求修改，提示该字段决定启动时加载哪个 agent。
- 不为 skill 正文中出现的 `{{skill_dir}}` 占位符做替换——那是加载期由 g-agent 自动处理的，写文件时原样保留即可。
