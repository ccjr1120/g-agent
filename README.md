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
- `agent` — 可选；指定启动时加载哪个 agent。未设置或指向不存在的 agent 时回退到内置 `default`（见下）。运行时切换 agent 会自动写回此字段，下次启动沿用上次的 agent

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

内置 `default` agent 的用户目录（`~/.config/g-agent/agents/default/`）是**叠加层**：可放 `memory.md`、可选 `system.md` 与 `skills/`（专属技能），但**不会**读取其中的 `builtin-skills/`——内置 skill 始终来自 g-agent 包内。自定义 skill（如 weekly-report）请放到 `skills/`（仅 default 可用）或 global 目录（`~/.agent/skills/` 等）。

每个 agent 会加载三类技能（均为**渐进式加载**：系统提示词仅列 name、description 与路径，匹配时用 `read` 加载 `SKILL.md` 全文）：

| 层级 | 作用范围 | 典型路径 | 管理入口 |
|------|---------|---------|---------|
| **built-in（内置）** | 随 agent 分发，该 agent 激活时始终可用 | 包内 `builtin-skills/`；自定义 agent 可用 `~/.config/g-agent/agents/<name>/builtin-skills/`（**不含 default**） | agent-manager |
| **global（全局）** | 所有 agent 共享（可被单个 agent 关闭） | `~/.agent/skills/` | skill-manager |
| **self（专属）** | 仅当前 agent，其他 agent 不可见 | `~/.config/g-agent/agents/<name>/skills/` | skill-manager |

同名时优先级：**self > global > built-in**。

- built-in skills：`<agent>/builtin-skills/<skill>/SKILL.md`
- global skills：`$G_AGENT_GLOBAL_SKILLS_DIR` → `$G_AGENT_HOME/skills` → `~/.agent/skills` → `~/.agents/skills` → `~/.config/g-agent/skills` → `~/.local/share/g-agent/skills`（按顺序取第一个存在的目录；新建 global skill 默认写入 `~/.agent/skills`）

  可在 `config.json` 中通过 `skills` 控制全局技能发现：

  ```json
  {
    "skills": {
      "loadAgentsSkills": false
    }
  }
  ```

  - `loadAgentsSkills: false` — 跳过 `~/.agents/skills`（常见于 Cursor 的技能目录）
  - `skipPaths` — 额外跳过的目录，支持 `~` 前缀
  - `paths` — 显式指定全局技能目录（替换自动发现，仍取第一个存在的目录）

  单个 agent 可在 `agent.json` 中覆盖：

  ```json
  {
    "description": "隔离环境的 agent",
    "skills": {
      "global": false,
      "loadAgentsSkills": false
    }
  }
  ```

  - `global: false` — 该 agent 不加载任何 global skills
  - `loadAgentsSkills` / `skipPaths` — 仅对该 agent 生效，与全局配置合并
- self skills：`<agent>/skills/<skill>/SKILL.md`

同名技能按 `self > global > built-in` 的优先级覆盖。启动时如果发现同名冲突，会在 server 日志中输出被选中的来源和所有候选路径。

内置 `default` agent 已含 `memory-manager`、`skill-manager`、`agent-manager`、`mcp-manager` 等内置技能与基础 system prompt，无需配置即可用。

#### 运行时切换

TUI 内：

- `/agent` — 列出所有 agent（`*` 标记当前）
- `/agent <name>` — 切换到指定 agent（清空当前对话、重载技能与 system prompt）

`config.json` 的可选 `agent` 字段决定启动时加载哪个 agent；未设置或指向不存在的 agent 时回退到内置 `default`。在 TUI 中切换 agent 后会自动更新该字段，下次启动默认使用上次在用的 agent。

## 开发

前置：安装 [bun](https://bun.sh)、[pnpm](https://pnpm.io) 与 [Rust](https://rustup.rs)（含 `cargo`）。

```bash
pnpm install
pnpm dev          # 启动 server + Rust TUI
pnpm dev:tui      # 仅 TUI（server 需已运行或由 TUI 自动拉起）
cargo test -p g-agent-tui
```

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
