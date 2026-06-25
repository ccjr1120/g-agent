# G-Agent

无论是 Hermes 还是 Openclaw，对我来说都太重太繁琐，我要的功能没那么复杂，也不太在乎安全，所以有了这个简单简洁版本的。

Monorepo：**pnpm** 管理依赖，**bun** 运行与构建。TUI 位于 `apps/tui`，共享库位于 `packages/`。

## 安装

一行命令（从 GitHub 拉取并安装，自动安装 bun / pnpm）：

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
- `agent` — 默认 agent 名，决定启动时加载哪个 agent（见下）

`G_AGENT_PROVIDER` / `G_AGENT_AGENT` 环境变量可临时覆盖 `provider` / `agent`。

### Agent

每个 agent 是 `agents/<name>/` 下的一个目录，自带 system prompt 与技能：

```
~/.config/g-agent/agents/<name>/
  agent.json        # { "description": "..." }
  system.md         # 该 agent 的 system prompt（可选，缺失则用内置 default 的）
  builtin-skills/   # 该 agent 的内置技能（可选）
    <skill>/SKILL.md
  skills/           # 该 agent 的用户技能（可选）
    <skill>/SKILL.md
```

agent 目录从以下路径查找：`$G_AGENT_AGENTS_DIR` → `$G_AGENT_HOME/agents` → `~/.config/g-agent/agents` → `~/.local/share/g-agent/agents`。同名时用户目录下的 agent 覆盖内置同名 agent；agent 内 `skills/` 的同名技能覆盖 `builtin-skills/`。

激活某 agent 时**只加载它自己的技能**（完全替换，不再读全局 `~/.config/g-agent/skills`）。

内置 `default` agent 已含 `memory` 技能与基础 system prompt，无需配置即可用。

#### 运行时切换

TUI 内：

- `/agent` — 列出所有 agent（`*` 标记当前）
- `/agent <name>` — 切换到指定 agent（清空当前对话、重载技能与 system prompt）

`config.json` 的 `agent` 字段决定首次打开加载哪个 agent。

## 开发

前置：安装 [bun](https://bun.sh) 与 [pnpm](https://pnpm.io)。

```bash
pnpm install
pnpm dev
```

## 卸载

```bash
pnpm unlink --global @g-agent/tui
rm -rf ~/.local/share/g-agent   # 若通过 curl 安装
```
