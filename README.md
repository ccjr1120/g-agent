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
