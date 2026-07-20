---
name: mcp-manager
description: MCP 配置管理：列出、添加、修改、删除 MCP server。当用户要求「加/删/改 MCP」「配置 MCP server」「管理 MCP」时启用。
---

管理 g-agent 的 MCP server 配置。配置分两层，运行时按名称合并（agent 覆盖 global）：

| 层级 | 写入位置 | 作用范围 |
|------|---------|---------|
| **global** | `config.json` 的 `mcpServers` | 所有 agent 默认可用 |
| **agent** | `~/.config/g-agent/agents/<name>/agent.json` 的 `mcpServers` | 仅该 agent；同名覆盖 global |

TUI 中可用 `/mcp` 查看当前已连接 MCP；本 skill 负责**改配置文件**。

---

## 管理脚本

优先用脚本，不要手工编辑 JSON，除非脚本失败。

脚本路径：`{{skill_dir}}/scripts/mcp.mjs`

```bash
node "{{skill_dir}}/scripts/mcp.mjs" paths
node "{{skill_dir}}/scripts/mcp.mjs" list [--json]
node "{{skill_dir}}/scripts/mcp.mjs" list --agent <name> [--json]
node "{{skill_dir}}/scripts/mcp.mjs" get global <name> [--json]
node "{{skill_dir}}/scripts/mcp.mjs" get agent <agent> <name> [--json]
node "{{skill_dir}}/scripts/mcp.mjs" add global <name> --config '<json>' [--json]
node "{{skill_dir}}/scripts/mcp.mjs" add agent <agent> <name> --config '<json>' [--json]
node "{{skill_dir}}/scripts/mcp.mjs" set global <name> --config '<json>' [--json]
node "{{skill_dir}}/scripts/mcp.mjs" set agent <agent> <name> --config '<json>' [--json]
node "{{skill_dir}}/scripts/mcp.mjs" remove global <name> [--json]
node "{{skill_dir}}/scripts/mcp.mjs" remove agent <agent> <name> [--json]
```

也可用 transport 参数代替 `--config`：

```bash
# stdio
node "{{skill_dir}}/scripts/mcp.mjs" add global filesystem \
  --stdio npx --arg -y --arg @modelcontextprotocol/server-filesystem --arg /Users/me

# url
node "{{skill_dir}}/scripts/mcp.mjs" add global remote \
  --url http://localhost:3000/mcp --header Authorization=Bearer\ token
```

需要结构化结果时加 `--json`。

---

## 触发

| 用户意图 | 触发词示例 |
|---------|-----------|
| 列出 MCP | 「有哪些 MCP」「列出 MCP server」「查看 MCP 配置」 |
| 添加 MCP | 「加一个 MCP」「配置 filesystem MCP」「给 default agent 加 MCP」 |
| 修改 MCP | 「改一下 xxx MCP 的参数」「把 MCP 路径改成…」 |
| 删除 MCP | 「删掉 xxx MCP」「移除 MCP server」 |

---

## 第零步：先查现状（所有操作前必做）

1. 用 `bash` 执行：

```bash
node "{{skill_dir}}/scripts/mcp.mjs" paths
node "{{skill_dir}}/scripts/mcp.mjs" list --json
```

2. 若用户提到某个 agent，再执行：

```bash
node "{{skill_dir}}/scripts/mcp.mjs" list --agent <name> --json
```

3. 用自然语言告诉用户当前 global / agent 各有哪些 MCP，以及合并后的 effective 结果。

---

## 一、添加 MCP

1. 确认写入 **global** 还是 **agent** 层：
   - 所有 agent 都要用 → `global`
   - 仅某个 agent → `agent <name>`
   - 不确定时询问用户；默认建议 global
2. 收集 server **名称** 与传输方式：
   - **stdio**：`command` + 可选 `args` / `env` / `cwd`
   - **url**：HTTP MCP 地址 + 可选 `headers`
3. 展示将要写入的 JSON 预览，请用户确认
4. 确认后执行 `add`（已存在则改用 `set`）：

```bash
node "{{skill_dir}}/scripts/mcp.mjs" add global <name> --config '{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}'
```

5. 回复已添加，并提示：

> 配置已写入。请运行 `g-agent server restart` 使 MCP 生效；TUI 中可用 `/mcp` 查看连接状态。

---

## 二、修改 MCP

1. 先用 `get` 或 `list` 定位目标 server
2. 若目标不明确，列出候选并请用户选择
3. 生成新版配置，预览后确认
4. 执行 `set`（覆盖整条 server 配置）：

```bash
node "{{skill_dir}}/scripts/mcp.mjs" set global <name> --config '<新 json>'
# 或
node "{{skill_dir}}/scripts/mcp.mjs" set agent <agent> <name> --config '<新 json>'
```

5. 回复已更新，并提示 `g-agent server restart`

---

## 三、删除 MCP

1. 先用 `list` 定位；若 agent 层与 global 同名，说明删除 agent 层只会去掉覆盖，global 仍会保留
2. 展示将被删除的配置，请用户确认
3. 执行：

```bash
node "{{skill_dir}}/scripts/mcp.mjs" remove global <name>
# 或
node "{{skill_dir}}/scripts/mcp.mjs" remove agent <agent> <name>
```

4. 回复已删除，并提示 `g-agent server restart`

---

## 配置示例

**global（config.json）**

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me"]
    }
  }
}
```

**agent（agent.json）**

```json
{
  "description": "我的 agent",
  "mcpServers": {
    "extra": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

每条 server 必须**恰好**包含 `command`（stdio）或 `url`（HTTP）之一。

---

## 约束

- 预览先于写入：任何改配置操作前先让用户确认
- 只改 `mcpServers` 字段，不破坏 config.json / agent.json 里的其他配置
- global 默认写入 `~/.config/g-agent/config.json`（若不存在则创建）；agent 写入 `~/.config/g-agent/agents/<name>/agent.json`
- 修改配置后必须提醒用户 `g-agent server restart`
- 运行中查看连接状态用 TUI `/mcp`，不要用脚本冒充连接测试
