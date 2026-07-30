---
name: agent-manager
description: Agent 生命周期管理：通过参数化脚本创建、查询、编辑、删除用户 agent，管理 agent.json、system.md 和 builtin-skills。当用户要求创建、修改、删除、列出、查看 agent，或优化 agent 提示词、模型、技能时使用。
---

# Agent Manager

管理 `~/.config/g-agent/agents/<name>/` 下的用户 agent。所有读取和变更必须通过：

```bash
node "{{skill_dir}}/scripts/agent.mjs" <command> [arguments]
```

`{{skill_dir}}` 由加载器替换为实际路径。

## 强制约束

- **只调用 `agent.mjs`，禁止用 `read`、`write`、`bash cat`、`ls`、`rm` 或临时脚本直接操作 agent 文件。**
- 先调用 `list --json` 或 `get <name> --json` 获取现状；不要自行探测目录。
- 创建、修改、删除前先向用户展示预览并确认；收到确认后才调用写命令。
- 删除必须在用户明确确认后传 `--yes`。脚本拒绝删除 `default` 用户覆盖。
- 只管理用户 agent，不修改仓库内置 agent。要覆盖内置 agent 时创建同名用户 agent。
- `builtin-skills` 由本脚本管理；global/self skills 交给 `skill-manager`。
- 增删 builtin skill 时，同时用 `update --system` 同步 system prompt 中的 Skills first 原则和技能清单。
- 不修改全局 `config.json` 的默认 agent。

## 命令

```text
agent.mjs paths [--json]
agent.mjs list [--json]
agent.mjs get <name> [--json]

agent.mjs create <name>
  --description <text>
  [--system <markdown>]
  [--provider <provider/model>]
  [--providers-json <json>]
  [--skills-json <json>]
  [--mcp-servers-json <json>]
  [--json]

agent.mjs update <name>
  [--description <text>]
  [--system <markdown> | --remove-system]
  [--provider <provider/model> | --remove-provider]
  [--providers-json <json> | --remove-providers]
  [--skills-json <json> | --remove-skills-config]
  [--mcp-servers-json <json> | --remove-mcp-servers]
  [--json]

agent.mjs remove <name> --yes [--json]

agent.mjs builtin-skill list <agent> [--json]
agent.mjs builtin-skill get <agent> <skill> [--json]
agent.mjs builtin-skill add <agent> <skill>
  --description <text> [--body <markdown>] [--json]
agent.mjs builtin-skill set <agent> <skill>
  [--description <text>] [--body <markdown>] [--json]
agent.mjs builtin-skill remove <agent> <skill> --yes [--json]
```

所有正文和 JSON 都作为单个参数传入。调用 shell 工具时用独立参数安全传递，不把用户内容拼接为可执行命令。

## 工作流

### 列出或查看

直接执行：

```bash
node "{{skill_dir}}/scripts/agent.mjs" list --json
node "{{skill_dir}}/scripts/agent.mjs" get <name> --json
```

`get` 一次返回 config、完整 system prompt、builtin skills 和 self skills，无需再读文件。

### 创建

1. 调用 `list --json` 检查重名。
2. 只问 agent 用途；从用途推导 name、description、system prompt 和建议技能。
3. 默认建议 `memory-manager`，纯一次性用途可不加。执行类 agent 的 system prompt 默认要求先规划再实施。
4. 展示完整预览并等待确认。
5. 确认后调用 `create`，再按需调用 `builtin-skill add`。
6. 最后调用 `get --json` 验证结果。

示例：

```bash
node "{{skill_dir}}/scripts/agent.mjs" create code-reviewer \
  --description "专注代码审查的助手" \
  --system "<完整 system prompt>" \
  --json
```

### 编辑或优化提示词

1. 调用 `get <name> --json`。
2. 根据用户要求生成新版字段或 system prompt。
3. 展示差异并等待确认。
4. 使用一次 `update` 传入所有变更。
5. 再次调用 `get --json` 验证。

未传入的字段保持不变；删除可选字段必须使用对应的 `--remove-*` 参数。

### 管理 builtin skill

1. 调用 `builtin-skill list/get` 获取现状。
2. 生成 description、body 和同步后的 system prompt。
3. 展示两者的变更并等待确认。
4. 调用 `builtin-skill add/set/remove`，随后调用 `update --system`。
5. 调用 `get --json` 验证。

`builtin-skill add/set` 自动生成规范的 `SKILL.md` frontmatter，LLM 只传 description 与正文。

### 删除

1. 调用 `get <name> --json` 展示将删除的全部内容。
2. 明确询问是否删除且说明不可恢复。
3. 用户确认后调用 `remove <name> --yes --json`。

## Agent 配置字段

- `description`：必需，一句话说明用途。
- `provider`：可选，格式为 `provider/model`。
- `providers`：可选，agent 级 provider 配置对象。
- `skills`：可选，global skills 加载策略。
- `mcpServers`：可选，agent 级 MCP 配置。
- `system.md`：可选；缺失时继承内置 default system prompt。

交付时说明可在 TUI 使用 `/agent <name>` 打开该 agent；配置和技能目录会热重载。
