---
name: skill-manager
description: Skill 配置管理：列出、添加、修改、删除 shared/gagent/self 技能，以及管理 skills 加载配置。当用户要求「加/删/改 skill」「管理技能」「列出技能」时启用。builtin 只读，走 agent-manager。
---

## 技能四层

| 层级 | scope | 路径 | 开关 |
|------|-------|------|------|
| **builtin** | — | 包内 / agent `builtin-skills/` | 只读 → **agent-manager** |
| **shared global** | `shared` | `~/.agents/skills/` | `skills.shared`（`global` 为兼容别名） |
| **g-agent global** | `gagent` | `~/.config/g-agent/skills/` | `skills.gagent` |
| **self** | `self` | `~/.config/g-agent/agents/<name>/skills/` | — |

**优先级：** self > gagent > shared > builtin

**开关位置：** `config.json` 的 `skills.shared` / `skills.gagent` 为全局默认；`agent.json` 可覆盖。两层互不影响。

## 脚本

```bash
node "{{skill_dir}}/scripts/skill.mjs" list [--agent <name>] [--shared-only | --gagent-only] [--json]
node "{{skill_dir}}/scripts/skill.mjs" add shared|gagent|self ... --description "..."
node "{{skill_dir}}/scripts/skill.mjs" config set global [--shared true|false] [--gagent true|false]
node "{{skill_dir}}/scripts/skill.mjs" config set agent <name> [--shared true|false] [--gagent true|false]
```

添加 skill 前先问：**shared**（Cursor 共用）/ **gagent**（g-agent 专用）/ **self**（单 agent）。
