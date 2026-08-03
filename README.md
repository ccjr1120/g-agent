# G-Agent

无论是 Hermes 还是 Openclaw，对我来说都太重太繁琐，我要的功能没那么复杂，也不太在乎安全，所以有了这个简单简洁版本的。

Monorepo：**pnpm** 管理 JS 依赖，**bun** 运行 server；TUI 为 Rust（Ratatui + Crossterm），位于 `apps/tui`。共享协议与 agent 逻辑在 `packages/`。

## 安装

一行命令（从 GitHub 拉取并安装，自动安装 bun / pnpm / Rust）：

```bash
curl -fsSL https://raw.githubusercontent.com/ccjr1120/g-agent/main/install.sh | bash
```

本地仓库安装：

```bash
./install.sh
```

安装完成后运行：

```bash
g-agent
```

若更新前 server 已在运行，`install.sh` 会在安装完成后自动执行 `g-agent server restart`。

手动重启后台 server：

```bash
g-agent server restart
```

可选环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `G_AGENT_HOME` | 安装目录 | `~/.local/share/g-agent` |
| `G_AGENT_BRANCH` | Git 分支 | `main` |
| `G_AGENT_REPO` | Git 仓库地址 | `https://github.com/ccjr1120/g-agent.git` |

## 自定义

### 配置文件

`config.json` 从以下路径按序查找（首个存在者生效）：

1. `$G_AGENT_CONFIG`
2. `$G_AGENT_HOME/config.json`
3. `~/.config/g-agent/config.json`
4. `~/.local/share/g-agent/config.json`

示例见 `config.example.json`，关键字段：

- `provider` — 默认 provider，形如 `openai/gpt-4o-mini`
- `providers` — provider 清单（baseUrl / apiKeyEnv / models）

`G_AGENT_PROVIDER` 环境变量可临时覆盖 `provider`。

### Agent

每个 agent 是 `agents/<name>/` 下的一个目录，自带 system prompt 与技能：

```
~/.config/g-agent/agents/<name>/
  agent.json        # { "description": "..." }
  system.md         # 该 agent 的 system prompt（可选，缺失则用内置 default 的）
  builtin-skills/   # 该 agent 的内置技能（可选；**内置 default 不支持**）
    <skill>/SKILL.md
  skills/           # 该 agent 的用户技能（可选）
    <skill>/SKILL.md
  memory.md         # 用户记忆（memory-manager 写入）
```

agent 目录从以下路径查找：`$G_AGENT_AGENTS_DIR` → `$G_AGENT_HOME/agents` → `~/.config/g-agent/agents` → `~/.local/share/g-agent/agents`。同名时用户目录下的 agent 覆盖内置同名 agent。

内置 `default` agent 的用户目录（`~/.config/g-agent/agents/default/`）是**叠加层**：可放 `memory.md`、可选 `system.md` 与 `skills/`（专属技能），但**不会**读取其中的 `builtin-skills/`——内置 skill 始终来自 g-agent 包内。自定义 skill（如 weekly-report）请放到 `skills/`（仅 default 可用）或 global 目录（`~/.agents/skills/` 等）。

每个 agent 会加载**四类**技能（均为**渐进式加载**：系统提示词仅列 name、description 与路径，匹配时用 `read` 加载 `SKILL.md` 全文）：

| 层级 | 作用范围 | 典型路径 | skill-manager scope | 管理入口 |
|------|---------|---------|---------------------|---------|
| **built-in（内置）** | 随 agent 分发 | 包内 `builtin-skills/`；自定义 agent 可用 `agents/<name>/builtin-skills/`（**不含 default**） | —（只读） | agent-manager |
| **shared global（共享全局）** | 所有 agent + Cursor 等工具 | `~/.agents/skills/` | `shared`（`global` 为兼容别名） | skill-manager |
| **g-agent global（g-agent 全局）** | 仅 g-agent 安装范围、所有 agent | `~/.config/g-agent/skills/` | `gagent` | skill-manager |
| **self（专属）** | 仅当前 agent | `~/.config/g-agent/agents/<name>/skills/` | `self` | skill-manager |

同名时优先级：**self > gagent > shared > built-in**。

- shared global：`~/.agents/skills/<skill>/SKILL.md`（`skill-manager add shared`）
- g-agent global：`~/.config/g-agent/skills/<skill>/SKILL.md`（`skill-manager add gagent`）
- self skills：`<agent>/skills/<skill>/SKILL.md`

  **两层全局 skill 独立开关**（`config.json` 全局默认，`agent.json` 可覆盖）：

  ```json
  {
    "skills": {
      "shared": false,
      "gagent": true
    }
  }
  ```

  - `shared: false` — 跳过 shared global（`~/.agents/skills`）；旧字段 `global: false` 等同
  - `gagent: false` — 跳过 g-agent global（`~/.config/g-agent/skills/`）
  - `skipPaths` / `paths` — 仅影响 shared global 的目录发现
  - 已移除 `loadAgentsSkills`；旧配置里 `loadAgentsSkills: false` 会自动当作 `shared: false`

内置 `default` agent 已含 `memory-manager`、`skill-manager`、`agent-manager`、`mcp-manager` 等内置技能与基础 system prompt，无需配置即可用。

#### default 主会话与 Agent 子会话

TUI 内：

- `/agent <name> <message>` — 创建独立 Agent 子会话并在后台执行首条消息；主会话会持续显示其进度
- `/<编号>` — 重新进入已有子会话
- `/back` — 返回 `default` 主会话
- `/new` — 启动新会话，同时从磁盘重新加载配置、Agent 与 Skill，并重建当前 Agent 的 MCP 连接；添加或修改 MCP/Skill 后无需重启 server
- `/reload` — 不清空当前对话，立即重新加载配置、Agent 与 Skill；仅在 MCP 配置发生变化时重建连接

启动后默认进入内置 `default` 主会话。`default` 不显示在 Sub Agents 区域，也不负责调用其他 Agent。用户执行 `/agent <name> <message>` 后，子会话会在后台运行，主会话可通过 Sub Agents 区域观察状态；输入 `/<编号>` 可进入子会话查看结果。首条消息会原样发送，并作为固定标题。

## 开发

前置：安装 [bun](https://bun.sh)、[pnpm](https://pnpm.io) 与 [Rust](https://rustup.rs)（含 `cargo`）。

```bash
pnpm install
pnpm dev          # 启动 server + Rust TUI
pnpm dev:tui      # 仅 TUI（server 需已运行或由 TUI 自动拉起）
pnpm test         # Agent 单元测试 + TUI 测试
cargo test -p g-agent-tui
```

模型请求默认 120 秒超时，并对 408/409/429/5xx 等瞬时错误最多重试 2
次。可通过 `G_AGENT_REQUEST_TIMEOUT_MS` 和 `G_AGENT_MAX_RETRIES` 调整；在
TUI 中取消当前回复会立即中止进行中的模型请求。

Agent 默认最多运行 25 轮模型请求，可通过 `G_AGENT_MAX_TOOL_ROUNDS` 调整。
最后一轮会禁用工具并要求模型基于已有结果作答，避免研究型任务因达到上限而
丢失已收集的成果。同一轮中模型发出的多个工具调用会并发执行。

终端性能的后续优化计划见
[docs/terminal-performance-todo.md](docs/terminal-performance-todo.md)。

### 修改内置 agent

内置 agent 源码位于 `packages/agent/src/agents/builtin/<name>/`：

| 文件 | 作用 |
|------|------|
| `system.md` | system prompt 主体（原则、工具说明等） |
| `builtin-skills/<skill>/SKILL.md` | 内置技能；运行时渐进式加载（系统提示词仅列 name、description、路径，匹配时用 `read` 加载全文） |

**新增或修改 `builtin-skills` 时，须同步更新 `system.md`**——例如 Skills first 原则、能力边界、与新 skill 相关的触发说明。`SKILL.md` 正文通过渐进式加载按需读取，但 `system.md` 中的原则性描述需人工维护。

## 卸载

```bash
cargo uninstall g-agent
pnpm remove -g @g-agent/tui   # 若曾用旧版 pnpm link 安装
rm -rf ~/.local/share/g-agent   # 若通过 curl 安装
```

若运行 `g-agent` 报 `dist/cli.js` 找不到，说明 PATH 里仍是旧的 pnpm 全局命令。执行 `pnpm remove -g @g-agent/tui`，或确认 `~/.cargo/bin` 在 `~/.local/share/pnpm` 之前。
