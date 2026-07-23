---
name: skill-manager
description: Skill 配置管理：列出、添加、修改、删除 global/self 技能，以及管理 skills 加载配置。当用户要求「加/删/改 skill」「管理技能」「配置 global skills」「列出技能」时启用。不负责 builtin skill（内置技能只读，走 agent-manager）。
---

## 本 skill 的定位

| 项 | 说明 |
|----|------|
| **类型** | 内置 skill（builtin），随内置 `default` agent 分发 |
| **skill 文件位置** | g-agent 包内 `builtin/default/builtin-skills/skill-manager/`；**安装时不复制**到 `~/.config/g-agent/` |
| **LLM 如何获知** | 系统提示词 `## Built-in skills` 中仅列 name、description 与路径；任务匹配时用 `read` 加载本 SKILL.md |
| **脚本路径** | `{{skill_dir}}/scripts/skill.mjs`（加载时已替换为磁盘实际路径） |
| **本 skill 写入的数据** | global 技能目录、`~/.config/g-agent/agents/<name>/skills/`、`config.json` / `agent.json` 的 `skills` 字段 |
| **本 skill 不可触碰** | **builtin（内置）skill** — 只读；增删改必须走 **agent-manager** |

---

## 技能三层与本 skill 权限

| 层级 | 中文 | 作用范围 | 本 skill 是否可写 |
|------|------|---------|-----------------|
| **builtin** | 内置 | 随 agent 分发 | **否（只读）** → 用 **agent-manager** |
| **global** | 全局 | 所有 agent 共享 | **是** |
| **self** | 专属 | 仅当前 agent | **是** |

同名冲突：**self > global > builtin**。本 skill 只能操作 **global** 与 **self**。

---

## 管理脚本

优先用脚本，不要手工编辑 JSON 或批量扫描目录，除非脚本失败。

脚本路径：`{{skill_dir}}/scripts/skill.mjs`

```bash
node "{{skill_dir}}/scripts/skill.mjs" paths [--json]
node "{{skill_dir}}/scripts/skill.mjs" list [--agent <name>] [--json]
node "{{skill_dir}}/scripts/skill.mjs" resolve <name> [--agent <name>] [--json]
node "{{skill_dir}}/scripts/skill.mjs" get global <name> [--json]
node "{{skill_dir}}/scripts/skill.mjs" get self <agent> <name> [--json]
node "{{skill_dir}}/scripts/skill.mjs" add global <name> --description "<desc>" [--body "<markdown>"] [--json]
node "{{skill_dir}}/scripts/skill.mjs" add self <agent> <name> --description "<desc>" [--body "<markdown>"] [--json]
node "{{skill_dir}}/scripts/skill.mjs" set global <name> --description "<desc>" [--body "<markdown>"] [--json]
node "{{skill_dir}}/scripts/skill.mjs" set self <agent> <name> --description "<desc>" [--body "<markdown>"] [--json]
node "{{skill_dir}}/scripts/skill.mjs" remove global <name> [--json]
node "{{skill_dir}}/scripts/skill.mjs" remove self <agent> <name> [--json]
node "{{skill_dir}}/scripts/skill.mjs" config get global [--json]
node "{{skill_dir}}/scripts/skill.mjs" config get agent <name> [--json]
node "{{skill_dir}}/scripts/skill.mjs" config set global [--skills-json '<skills>'] [--load-agents-skills true|false] [--skip-path <path>...] [--paths <path>...]
node "{{skill_dir}}/scripts/skill.mjs" config set agent <name> [--skills-json '<skills>'] [--global true|false] [--load-agents-skills true|false] [--skip-path <path>...]
```

> 脚本**不接受** `builtin` 作为 scope。对 builtin 执行 add/set/remove/get 会报错。

需要结构化结果时加 `--json`。

---

## 触发

| 用户意图 | 触发词示例 |
|---------|-----------|
| 列出技能 | 「有哪些 skill」「列出技能」「查看 global skills」 |
| 添加技能 | 「加一个 skill」「新建全局技能」「给 xxx agent 加技能」 |
| 修改技能 | 「改一下 xxx skill 的描述」「更新 SKILL.md」 |
| 删除技能 | 「删掉 xxx skill」「移除技能」 |
| 配置加载 | 「关闭 global skills」「不要加载 Cursor 技能」 |

**不触发**（走 agent-manager）：创建/删除 agent、增删 **builtin-skills**、修改内置 manager skill（如 memory-manager 的 builtin 版本）。

---

## 第零步：先查现状（所有操作前必做）

```bash
node "{{skill_dir}}/scripts/skill.mjs" paths
node "{{skill_dir}}/scripts/skill.mjs" list --json
# 若涉及具体 agent：
node "{{skill_dir}}/scripts/skill.mjs" list --agent <name> --json
```

说明当前 global / self / builtin 分布。**builtin 一律标注为只读**。

---

## 添加 / 修改 / 删除前：必须确认 skill 类型

对用户发起的 **添加、修改、删除**（不含纯列出），在写文件前**必须先向用户确认要操作的层级**。不要默认 global，也不要假设用户想改 builtin。

### 询问模板（添加 skill 时必用）

向用户说明两个可选项（**不要提供 builtin 作为本 skill 的选项**）：

1. **global（全局）** — 所有 agent 都能用，保存在 `~/.agent/skills/`
2. **self（专属）** — 仅某个 agent 能用，保存在 `~/.config/g-agent/agents/<name>/skills/`

若用户说「内置 / builtin / 随 agent 分发」→ **停止本 skill 流程**，说明 builtin 由 **agent-manager** 管理，本 skill 不能写入 builtin-skills/。

### 修改 / 删除已有 skill 时

1. 先用 `resolve` 查该 skill 在哪些层存在：

```bash
node "{{skill_dir}}/scripts/skill.mjs" resolve <name> [--agent <name>] --json
```

2. 按结果处理：

| resolve 结果 | 动作 |
|-------------|------|
| 仅 **builtin** 存在 | **拒绝修改/删除**。告知：builtin 只读；若需定制请用 agent-manager 改用户 agent 的 `builtin-skills/`，或另建 global/self 覆盖层 |
| **global** 或 **self** 存在 | 确认用户要改哪一层（若两层都有，必须让用户选） |
| 不存在 | 按添加流程处理，并先问 global 还是 self |

3. 用户未明确层级时，**必须追问**，不得擅自写入。

---

## 一、添加技能

1. **先问类型**：global 还是 self？（见上文模板；builtin 不可用）
2. self 需确认 **agent 名称**；global 确认是否所有 agent 都要用
3. 收集 **name**、**description**、正文
4. 展示预览（含目标路径与层级），请用户确认
5. 执行 `add`：

```bash
node "{{skill_dir}}/scripts/skill.mjs" add global my-skill \
  --description "简短描述与触发条件" \
  --body $'## 工作流\n\n1. ...'
```

6. 提示重载：`/agent <name>` 或重启 server

---

## 二、修改技能

1. `resolve <name>` 定位层级
2. 若仅 builtin → **拒绝**，引导 agent-manager 或建议新建 global/self 覆盖
3. 若 global/self → 确认用户要改哪一层
4. `get` 读取现状 → 预览 → `set` 或 `write`
5. 提示重载

---

## 三、删除技能

1. `resolve <name>` 定位层级
2. 若仅 builtin → **拒绝**（「不能删除内置 skill」）
3. 若 global/self → 展示路径，二次确认
4. `remove global <name>` 或 `remove self <agent> <name>`
5. 提示重载

> 删除 global/self 后，若仍有同名 builtin，运行时仍会回退到 builtin 版本 — 须向用户说明。

---

## 四、skills 加载配置

**global（config.json）**

```json
{
  "skills": {
    "loadAgentsSkills": false,
    "skipPaths": ["~/.agents/skills"],
    "paths": ["~/.agent/skills"]
  }
}
```

**agent（agent.json）**

```json
{
  "description": "...",
  "skills": {
    "global": false,
    "loadAgentsSkills": false,
    "skipPaths": ["~/.agents/skills"]
  }
}
```

修改前先 `config get`，预览后 `config set`，再提醒重载。

---

## 约束

- **builtin 只读**：本 skill 不得 add/set/remove/get builtin；用户要改 builtin → **agent-manager**
- **先问类型**：添加 / 修改 / 删除前必须确认 global 或 self，用户没说清楚就追问
- 预览先于写入
- global 默认写入 `~/.agent/skills`；self 写入 `~/.config/g-agent/agents/<name>/skills/`
- 不为 `SKILL.md` 中的 `{{skill_dir}}` 做替换——加载期由 g-agent 自动处理
- 用户 agent 的 **builtin-skills** 增删与 system.md 同步见 **agent-manager**
