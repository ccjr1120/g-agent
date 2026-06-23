---
name: memory
description: 记住用户告知的信息，并在相关问题中主动回忆
---

## 记忆文件

记忆存储在：`{{skill_dir}}/memory.md`

每条记忆格式：

```
- [YYYY-MM-DD] <内容>
```

## 读取记忆

除非是纯粹的打招呼（如"你好"、"hi"、"早上好"），否则在回答前先用 `read` 读取 `{{skill_dir}}/memory.md`。
文件不存在时视为无记忆，直接回答。
已经在本轮对话中读取过则无需重复读取。

## 写入记忆

当用户说"记住……"、"记一下……"、"帮我记……"或类似表达时：

1. 用 `bash` 执行 `date +%Y-%m-%d` 获取当前日期
2. 用 `read` 读取 `{{skill_dir}}/memory.md`（不存在则视为空）
3. 在末尾追加 `- [YYYY-MM-DD] <内容>`
4. 用 `write` 写回 `{{skill_dir}}/memory.md`
5. 回复"已记住：<内容>"
