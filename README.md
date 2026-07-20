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

重启后台 server：

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
- `agent` — 可选；指定启动时加载哪个 agent。未设置或指向不存在的 agent 时回退到内置 `default`（见下）

`G_AGENT_PROVIDER` 环境变量可临时覆盖 `provider`。

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

agent 目录从以下路径查找：`$G_AGENT_AGENTS_DIR` → `$G_AGENT_HOME/agents` → `~/.config/g-agent/agents` → `~/.local/share/g-agent/agents`。同名时用户目录下的 agent 覆盖内置同名 agent。

每个 agent 会加载三类技能：

- built-in skills：`<agent>/builtin-skills/<skill>/SKILL.md`
- global skills：`$G_AGENT_GLOBAL_SKILLS_DIR` → `$G_AGENT_HOME/skills` → `~/.agents/skills` → `~/.config/g-agent/skills` → `~/.local/share/g-agent/skills`（按顺序取第一个存在的目录）

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

内置 `default` agent 已含 `memory` 技能与基础 system prompt，无需配置即可用。

#### 运行时切换

TUI 内：

- `/agent` — 列出所有 agent（`*` 标记当前）
- `/agent <name>` — 切换到指定 agent（清空当前对话、重载技能与 system prompt）

`config.json` 的可选 `agent` 字段决定首次打开加载哪个 agent；未设置或指向不存在的 agent 时回退到内置 `default`。

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
