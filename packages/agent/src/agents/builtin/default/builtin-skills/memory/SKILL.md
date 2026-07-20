---
name: memory
description: 除纯打招呼外，回答前应查阅用户记忆（习惯、偏好、路径、身份、配置及一切曾告知的信息）；「我的…」「你还记得…」类问题必须启用
---

## 记忆文件

记忆存储在：`{{skill_dir}}/memory.md`

每条记忆格式：

```
- [YYYY-MM-DD] <内容>
```

## 记忆脚本

优先用脚本管理记忆，不要手工拼接 `memory.md`，除非脚本运行失败。

脚本路径：`{{skill_dir}}/scripts/memory.mjs`

可用命令：

```bash
node "{{skill_dir}}/scripts/memory.mjs" list
node "{{skill_dir}}/scripts/memory.mjs" search "<关键词>"
node "{{skill_dir}}/scripts/memory.mjs" get <id>
node "{{skill_dir}}/scripts/memory.mjs" add "<内容>"
node "{{skill_dir}}/scripts/memory.mjs" update <id> "<新内容>"
node "{{skill_dir}}/scripts/memory.mjs" delete <id>
```

需要结构化结果时加 `--json`。

## 读取记忆

除非是纯粹的打招呼（如「你好」「hi」「早上好」），否则在回答前先用 `bash` 执行：

```bash
node "{{skill_dir}}/scripts/memory.mjs" list
```

再据此回答。脚本失败时，退回用 `read` 读取 `{{skill_dir}}/memory.md`（不存在则视为空）。

以下类型的问题必须查阅记忆：个人习惯与偏好、开发/工作目录与路径、身份与称呼、配置与环境、用户曾要求记住的内容，以及含「我的」「你还记得」「之前说过」等表述的问题。

已经在本轮对话中读取过则无需重复读取。写入、更新或删除记忆前，同样先用 `list` 或 `search` 查看当前内容。

## 写入记忆

当用户说「记住……」「记一下……」「帮我记……」或类似表达时：

1. 先读取现有记忆，判断是否已有等价或冲突内容
2. 无等价内容时，用 `bash` 执行：

```bash
node "{{skill_dir}}/scripts/memory.mjs" add "<内容>"
```

3. 回复「已记住：<内容>」

如果已有等价内容，不重复写入，直接说明已存在。

## 查询记忆

当用户询问「我有哪些记忆」「列出记忆」「搜索记忆」「查一下记忆里有没有……」时：

- 列出全部：`node "{{skill_dir}}/scripts/memory.mjs" list`
- 关键词搜索：`node "{{skill_dir}}/scripts/memory.mjs" search "<关键词>"`
- 查看单条：`node "{{skill_dir}}/scripts/memory.mjs" get <id>`

回答时保留 `#<id>`，方便用户后续修改或删除。

## 更新记忆

当用户要求「修改记忆」「把第 N 条改成……」「更新关于……的记忆」时：

1. 先用 `list` 或 `search` 定位目标记忆
2. 若目标不明确，询问用户要修改哪一条
3. 目标明确后执行：

```bash
node "{{skill_dir}}/scripts/memory.mjs" update <id> "<新内容>"
```

4. 回复「已更新 #<id>：<新内容>」

## 删除记忆

当用户要求「删除记忆」「忘记……」「删掉第 N 条」时：

1. 先用 `list` 或 `search` 定位目标记忆
2. 若目标不明确，询问用户要删除哪一条
3. 目标明确后执行：

```bash
node "{{skill_dir}}/scripts/memory.mjs" delete <id>
```

4. 回复「已删除 #<id>：<原内容>」
