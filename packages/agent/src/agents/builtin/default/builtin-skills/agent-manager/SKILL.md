---
name: agent-manager
description: Agent 生命周期管理：创建、编辑、删除、列出 agent。当用户要求「创建/新建/加一个 agent」、「修改/编辑/删除 agent」、「列出/查看 agent」时启用。
---

管理 g-agent 的用户 agent。用户 agent 统一放在：

```
~/.config/g-agent/agents/<name>/
  agent.json              # 必需，{ "description": "..." }，可选 provider/providers
  system.md               # 可选，该 agent 的 system prompt；缺失则继承内置 default 的
  builtin-skills/         # 可选，该 agent 的内置技能
    <skill>/SKILL.md
  skills/                 # 可选，该 agent 的用户技能
    <skill>/SKILL.md
```

> 路径中的 `~` 会由 `write` 工具自动展开到家目录并创建所需父目录，直接写 `~/.config/g-agent/agents/<name>/...` 即可，无需先 `mkdir`。

同名时用户 agent 会覆盖内置同名 agent（加载期 `loadAgents()` 中 user 覆盖 builtin）。

---

## 触发

| 用户意图 | 触发词示例 |
|---------|-----------|
| 创建 agent | 「创建/新建/加一个 agent」「帮我做一个 xxx agent」 |
| 编辑 agent | 「修改/编辑 xxx agent」「给 xxx 加个技能」「去掉 xxx 的技能」 |
| 删除 agent | 「删除/移除 xxx agent」 |
| 列出 agent | 「有哪些 agent」「列出/查看 agent」「我的 agent」 |

普通对话、改全局配置、加技能但不涉及 agent 等不触发。

---

## 第零步：列出已有 agent（所有操作前必做）

执行任何操作前，先用 `bash` 列出用户已有 agent，并告知内置 agent 情况：

```bash
for d in ~/.config/g-agent/agents/*/; do
  [ -d "$d" ] || continue
  name=$(basename "$d")
  desc=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('description',''))" 2>/dev/null < "$d/agent.json" || echo "")
  echo "$name — $desc"
done
```

> 若 `~/.config/g-agent/agents/` 下为空目录，说明还没有用户创建的 agent。内置 agent（如 `default`、`agent-manager`）始终可用，不需要列出文件。

用简洁的自然语言告诉用户当前有哪些用户 agent，然后进入具体操作。

---

## 一、创建 agent

### 1. 先问用途，再推导一切

**只问一个问题**：这个 agent 用来做什么？（一句话描述用途）

用户只需说「用来做代码审查」「帮我写 commit message」「翻译中英文」这类一句，不要一开始就要求填四样。

### 2. 从用途推导四项内容

基于用途，自动生成以下四项的草案，**一次性全部展示**给用户确认：

| 要素 | 推导方式 |
|------|---------|
| **name** | 用途的英文翻译，小写、连字符分隔，如 `code-reviewer`、`commit-writer`、`translator` |
| **description** | 用途的中文一句话，如「专注代码审查的助手」 |
| **system.md** | 基于用途生成角色设定：身份、能力边界、语气、常用工具偏好。3-8 句话即可，不要冗长 |
| **skills** | 始终建议包含 `memory`（记住用户偏好等基础能力）。除非用途明确不需要（如纯一次性翻译 agent），否则 memory 是合理默认 |

> 模板参考：内置 `default` agent 的 system.md 可先 `read` 作为风格参照。memory skill 的内容可先从内置 `default` 的 `builtin-skills/memory/SKILL.md` `read` 取来直接复用。

**`provider` / `providers`（可选）**：

agent.json 可选的 `provider` 和 `providers` 与 config.json 结构一致。当 agent 需要不同的模型或 API 后端时使用：

- `provider` — 覆盖全局的 provider/model 引用。格式 `"provider名/model名"`（如 `"openai/gpt-4o"`）。比如代码审查 agent 可能需要更强的模型。
- `providers` — 追加或覆盖全局 providers 配置。例如 agent 使用了 config.json 里没有的第三方 API。

**默认不填**，除非用户明确说「这个 agent 要用另一个模型」。填了就只影响该 agent，不影响其他 agent。

### 3. 一次性预览

将四项内容整理为预览，清楚列出将要创建的文件和内容：

```
将要创建 agent「<name>」，文件结构：

~/.config/g-agent/agents/<name>/
├── agent.json          （1 个文件）
├── system.md           （如果提供）
└── builtin-skills/     （如果提供）
    └── memory/SKILL.md

--- agent.json ---
{
  "description": "...",
  "provider": "...",        // （可选）覆盖全局 provider，格式 "provider名/model名"
  "providers": { ... }      // （可选）追加或覆盖全局 providers
}

--- system.md ---
（展示完整内容）

--- builtin-skills/memory/SKILL.md ---
（展示完整内容，或注明「复用内置 default 的 memory skill」）
```

预览后询问用户：
- 「这样可以吗？可以直接确认，也可以修改其中任何一项。」
- 若用户要改某个要素（如「name 改短一点」「system prompt 太长了」），只改那一项后重新展示。

### 4. name 冲突检查

若用户目录下已存在同名 agent，在预览中标注 `⚠️ 将覆盖已有 agent「<name>」`，确认后再写。

### 5. 写文件

用户确认后用 `write` 依次创建文件。写完后进入验证交付（见下文）。

---

## 二、编辑 agent

### 1. 确定目标

用户提到要编辑某个 agent 时，先确认名称。若名称不明确，从第零步的列表中帮用户定位。

### 2. 读取现状

```bash
cat ~/.config/g-agent/agents/<name>/agent.json
cat ~/.config/g-agent/agents/<name>/system.md
ls ~/.config/g-agent/agents/<name>/builtin-skills/
ls ~/.config/g-agent/agents/<name>/skills/
```

用 `read` 读取相关文件，向用户展示当前内容。

### 3. 编辑操作

**修改 system prompt**：
- 展示当前 system.md → 用户描述修改方向 → 生成新版 → 预览 → 确认 → `write`

**增删技能**：
- 添加技能：用户描述技能用途 → 生成 SKILL.md → 预览 → 确认 → `write` 到对应目录
- 删除技能：用户指定技能名 → 确认 → `bash rm -rf ~/.config/g-agent/agents/<name>/builtin-skills/<skill>`
- 若该 agent 没有 `memory` 且用户需要，从内置 default 复制

**修改 description**：
- 展示当前 → 用户给新的 → 预览 → 确认 → `write` agent.json

**修改 provider / providers**：
- 展示当前 agent.json → 用户说「这个 agent 换成 xxx 模型」→ 更新 `provider` 字段 → 预览 → 确认 → `write` agent.json
- 用户说「加一个 provider 配置」→ 更新 `providers` 字段 → 预览 → 确认 → `write` agent.json

### 4. 约束

- 只编辑 `~/.config/g-agent/agents/` 下的用户 agent，不碰仓库源码中的内置 agent
- 若用户要调整内置 agent 的行为，引导其创建同名用户 agent 来覆盖

---

## 三、删除 agent

### 1. 确认目标

用户说「删除 xxx agent」时，先确认名称。若名称模糊，列出候选。

### 2. 展示将被删除的内容

```bash
ls -R ~/.config/g-agent/agents/<name>
```

展示完整文件结构，并提示「此操作不可撤销」。

### 3. 二次确认

明确问「确认删除 agent「<name>」及其所有文件？」——用户必须明确说「确认」「是」「删」等肯定词才执行。

### 4. 执行

```bash
rm -rf ~/.config/g-agent/agents/<name>
```

删除后告知用户结果。若该 agent 正被设为默认（`config.json` 中 `agent` 字段指向它），额外提示：
> ⚠️ config.json 中 `agent` 字段当前为「<name>」，该 agent 已删除。下次启动将回退到 default agent，或你可手动修改 config.json。

### 5. 约束

- 不删除仓库源码中的内置 agent
- 不删除名为 `default` 的用户 agent（会解除对内置 default 的覆盖），提示 `default` 是基础 fallback

---

## 验证与交付

任何操作完成后：

1. **文件确认**：用 `bash ls -R ~/.config/g-agent/agents/<name>`（创建/编辑后）列出结果
2. **切换指引**：
   - TUI 中直接输入 `/agent <name>` 即时切换（清空当前对话、重载技能与 system prompt）
   - 或在 `config.json` 里把 `agent` 设为 `<name>` 使其成为默认 agent
3. **技能提示**：简述该 agent 自带的技能清单，并提醒「激活该 agent 时只加载它自己的技能，不读全局技能目录」

---

## 全局约束

- 只在 `~/.config/g-agent/agents/` 下创建/编辑/删除，不碰仓库源码目录
- 不修改 `config.json` 的 `agent` 字段（交给用户决定）；若用户要求修改，提示该字段决定启动时加载哪个 agent
- 不为 skill 正文中的 `{{skill_dir}}` 占位符做替换——加载期由 g-agent 自动处理，原样保留
- 预览先于写入：任何写操作前先让用户确认内容，不要直接写
- 不删除内置 agent，不编辑内置 agent（引导用户创建同名用户 agent 覆盖即可）
