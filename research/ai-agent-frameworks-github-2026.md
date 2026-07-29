# GitHub AI Agent 框架 / 编排框架 调研报告

> 范围：**Agent 框架 / 编排框架** —— 让 LLM 具备工具调用、规划、记忆、协作能力的开发框架。
> 排除：纯浏览器/操作系统控制（browser-use、Stagehand）、纯 RAG（未含 agent 编排层）、Coding Agent 产品（Devin）、awesome 列表、教程项目。
> 数据采集时间：2026-07-29（基于 GitHub API 当前快照，活跃度窗口 = 最近 90 天 commit 数）。

---

## 一、总览（Top 10 候选）

| # | 仓库 | ⭐ | Forks | 主语言 | License | 最近 90d commits | 健康度 |
|---|---|---:|---:|---|---|---:|---|
| 1 | [langchain-ai/langchain](https://github.com/langchain-ai/langchain) | 142,825 | 23,777 | Python | MIT | 100+ | 🟢 持续高强度 |
| 2 | [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) | 69,576 | 8,870 | Python | MIT | 低 ⚠ | 🟡 节奏放缓 |
| 3 | [microsoft/autogen](https://github.com/microsoft/autogen) | 60,065 | 9,047 | Python | CC-BY-4.0 | 低 ⚠ | 🟡 迁移到 Microsoft Agent Framework |
| 4 | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 56,291 | 7,999 | Python | MIT | 91 | 🟢 持续高强度 |
| 5 | [run-llama/llama_index](https://github.com/run-llama/llama_index) | 51,177 | 7,825 | Python | MIT | 38 | 🟢 持续 |
| 6 | [agno-agi/agno](https://github.com/agno-agi/agno) | 41,478 | 5,713 | Python | Apache-2.0 | 100+ | 🟢 持续高强度 |
| 7 | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 38,364 | 6,464 | Python | MIT | 100+ | 🟢 持续高强度 |
| 8 | [huggingface/smolagents](https://github.com/huggingface/smolagents) | 28,572 | 2,818 | Python | Apache-2.0 | 15 | 🟡 节奏放缓（已进入稳定期） |
| 9 | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | 28,252 | 4,391 | Python | MIT | 100+ | 🟢 持续高强度 |
| 10 | [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) | 18,869 | 2,437 | Python | MIT | 100+ | 🟢 持续高强度 |

> 备注：commits 计数是 90 天内通过 GitHub API 抓取的上限样本（最大 100）。langchain / autogen / MetaGPT 的 commit 计数异常低是 2026 上半年集中重构、版本切换的副作用，不等于社区失活。

---

## 二、Top 10 详解

### 1. langchain-ai/langchain  ⭐ 142.8k
- **定位**：通用 LLM 应用开发平台，Agent 只是其中一个子模块（`langchain.agents` + LCEL 表达式）。官方现在称自己为 "the agent engineering platform"。
- **核心特性**：Chain/LCEL 组合、工具调用、Memory、Retrievers、模型/向量库/嵌入的可插拔抽象；商业化产品 LangSmith 配套。
- **生态优势**：模型/向量库/工具的集成数量业界第一；和 LangGraph、LangSmith 形成平台闭环。
- **劣势**：抽象层多，历史 API 变化大；新手对 `langchain.agents` vs `langgraph.prebuilt` 的边界容易混乱。
- **适用场景**：需要快速接入非常多模型/向量库/工具的复杂 RAG + Agent 混合应用。

### 2. FoundationAgents/MetaGPT  ⭐ 69.6k
- **定位**：把"软件公司"建模成多 agent 协作系统（产品经理、架构师、工程师、QA），输入一句话输出完整代码仓库。
- **核心特性**：SOP（标准作业流程）驱动、多 agent 角色分工、PR/Issue 风格产物、自动写代码、测试、文档。
- **代表场景**：自动从自然语言生成小型应用/脚本；研究型实验（SWE-bench 类）。
- **适用场景**：探索"多 agent 软件工程"，对 SOP/角色驱动流程感兴趣的团队。
- **活跃度警告**：最近 90d 提交数明显放缓，但社区 fork 数量依然很大，说明影响力还在。

### 3. microsoft/autogen  ⭐ 60.1k
- **定位**：微软出品，2024 年最热的多 agent 编程框架，主打"conversable agents"和异步事件驱动。
- **核心特性**：Actor-model 风格、GroupChat、UserProxyAgent、跨语言 (Python/.NET)。
- **演进**：v0.2 之后进入"稳态"；微软把它合并到新的 [microsoft/agent-framework](https://github.com/microsoft/agent-framework) (12.5k) 中，原 autogen 仓库转入维护模式。
- **适用场景**：遗留项目维护；对多 agent 异步协作有研究兴趣。

### 4. crewAIInc/crewAI  ⭐ 56.3k
- **定位**："role-playing, autonomous AI agents"，强调多 agent 分工协作的工程化封装。
- **核心特性**：Role / Goal / Backstory / Tools 声明式；Tasks + Crews；Flows 引入条件分支和状态机；与 LangChain 工具生态集成。
- **优势**：API 直观、上手快，社区有大量角色模板；商用产品 crewAI Plus 配套。
- **适用场景**：业务自动化、流程编排（"销售 + 研究员 + 写手"这种分工清晰的 agent 团队）。
- **趋势**：进入 2026 之后增长曲线仍很陡（90d 91 commit），是商业化走得最远的开源 agent 框架之一。

### 5. run-llama/llama_index  ⭐ 51.2k
- **定位**："leading document agent and OCR platform"，从 RAG 框架演化出 Agent / Workflow 层。
- **核心特性**：LlamaIndex `Workflows` 事件驱动编排、`FunctionAgent` / `ReActAgent`、`AgentRunner`、LlamaParse 文档解析、LlamaCloud 商业化。
- **优势**：RAG + 文档处理能力业界最强；agent 抽象在 0.10+ 之后明显更克制、不喧宾夺主。
- **适用场景**：以文档/企业知识库为底座的 agent（合同问答、内部知识助手）。

### 6. agno-agi/agno  ⭐ 41.5k
- **定位**："build, run, and manage agent platforms"，前身是 phidata。
- **核心特性**：极快的 agent runtime（号称 <2μs 启动）、内置 50+ 模型 provider、AgentOS 平台抽象、Memory + Knowledge + Tools 的清晰分层。
- **优势**：性能/类型安全 (Pydantic)；自带 FastAPI、SQLite、Postgres 集成；商业产品 Agno Platform。
- **趋势**：2025 → 2026 增长曲线最陡的 agent 框架之一，90d commit 100+。
- **适用场景**：需要把 agent 部署成 SaaS 的团队；想避开 LangChain 抽象复杂度的 Python 工程师。

### 7. langchain-ai/langgraph  ⭐ 38.4k
- **定位**：langchain 体系的"低层 agent 编排引擎"，用**有状态图** (StateGraph) 表达 agent 循环。
- **核心特性**：节点 / 边 / 命令、条件边、人在回路 (human-in-the-loop)、持久化 checkpointing、时间旅行 (time travel) 调试；可独立于 langchain 使用。
- **优势**：生产部署非常成熟（LangGraph Platform 提供托管）；和 LangSmith 追踪无缝。
- **适用场景**：需要"循环 + 回退 + 人工审批" 的复杂 agent 工作流；做生产级 agent 服务的首选之一。

### 8. huggingface/smolagents  ⭐ 28.6k
- **定位**："a barebones library for agents that think in code"，HuggingFace 出品。
- **核心特性**：极简 API（`@tool` 装饰器）、默认让 LLM **写 Python 代码**作为动作（CodeAgent）、ToolCallingAgent 双模式、内置安全沙箱 (E2B/Docker/Pyodide/Modal)。
- **优势**：哲学"agents should think in code, not JSON"，论文证明 code-as-action 在很多任务上更稳；HF 生态自然集成 transformers/datasets/hub。
- **趋势**：已进入稳定期，更新节奏放缓，但仍是"极简 agent" 流派的事实标准。
- **适用场景**：研究 / 实验 / 教学；不想要重框架、想自己掌控 agent loop 的工程师。

### 9. openai/openai-agents-python  ⭐ 28.2k
- **定位**：OpenAI 官方的轻量 Python SDK，前身是 Swarms 教程。
- **核心特性**：`Agent` / `Runner` / `handoff` / `guardrail` / `session` / `function_tool`、原生支持 OpenAI Realtime、MCP、Tracing。
- **优势**：API 极简、官方背书、Tracing 与 OpenAI Dashboard 直连；支持多 LLM provider。
- **趋势**：在 OpenAI 内部已经是默认推荐 agent 框架；90d commit 100+。
- **适用场景**：以 OpenAI 模型为主、想用最少的代码搭起带追踪和护栏的 agent；教学 / 入门。

### 10. pydantic/pydantic-ai  ⭐ 18.9k
- **定位**："AI Agent Framework, the Pydantic way"，Pydantic 团队出品。
- **核心特性**：类型安全 + Pydantic 风格验证、原生 `result_type`、内置 `Tool`、多模型 provider、MCP、A2A、Durable Execution (Temporal / DBOS)。
- **优势**：和 FastAPI / Pydantic Logfire 协同；类型校验在 agent 输出侧非常稳。
- **趋势**：增长曲线非常陡（2025 年中才 1k，到 2026 年 7 月已 18.9k），90d commit 100+。
- **适用场景**：Python 项目对类型安全/可观测性要求高的团队；用 FastAPI 构建生产 agent。

---

## 三、按"流派"分类视图

| 流派 | 代表 | 关键词 |
|---|---|---|
| **图编排 / 状态机** | langgraph, pydantic-ai, agno | StateGraph, Durable Execution |
| **多 agent 分工 (Role-based)** | crewAI, MetaGPT, camel-ai, autogen | Role / Crew / SOP / GroupChat |
| **通用平台 / 编排** | langchain, agno, llama_index | 工具/记忆/RAG/模型 全栈 |
| **极简 / Code-as-Action** | smolagents, openai-agents-python | 少抽象、code-as-tool、官方背书 |
| **RAG/文档优先** | llama_index, haystack | workflow、agent over documents |
| **状态化 + 长期记忆** | letta, mem0 (生态) | persistent memory、self-improve |
| **TS 生态** | mastra, vercel/ai SDK, assistant-ui | TypeScript / React / Next.js |
| **语音 / Realtime** | livekit/agents | voice agent、telephony |

---

## 四、几个值得单独点名观察

- **[agno-agi/agno](https://github.com/agno-agi/agno)** — 2025→2026 增速最猛的新生代平台型 agent 框架，号称 <2μs 启动 + AgnoOS 商业化。
- **[pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai)** — 后起之秀，类型安全 + Temporal 持久化执行，正在变成"Python 严肃工程派"的首选。
- **[mastra-ai/mastra](https://github.com/mastra-ai/mastra)** — 26.7k ⭐，TS 生态里事实上的 agent 框架，对标 LangChain 在 Node 侧的位置。
- **[openai/openai-agents-python](https://github.com/openai/openai-agents-python)** — OpenAI 官方亲儿子，Tracing + Realtime + MCP 全内置，2026 入门首选。
- **[letta-ai/letta](https://github.com/letta-ai/letta)** — 24k ⭐，主打"有状态 agent + 长期记忆"，AgentOS 概念先驱。
- **[i-am-bee/beeai-framework](https://github.com/i-am-bee/beeai-framework)** — IBM 主导，跨 Python/TS，主打企业级生产部署。
- **[VoltAgent/voltagent](https://github.com/VoltAgent/voltagent)** — 10k+ ⭐ 的 TypeScript 框架，强调"AI Agent Engineering Platform"，生态工具完整。
- **MCP 生态 (Model Context Protocol)** — 已成事实标准，几乎所有主流 agent 框架都把 MCP 作为 tool 接入层；`microsoft/mcp` (3.5k) 是微软官方 server 目录。

---

## 五、横向选型建议

| 你的需求 | 推荐 |
|---|---|
| 入门 / 教学 / Demo | openai-agents-python、smolagents |
| Python 全栈 + RAG + Agent | langchain / langgraph / llama_index |
| 复杂可回退可审计的工作流 | langgraph、pydantic-ai |
| 多 agent 角色分工 | crewAI、MetaGPT、camel-ai |
| 想避开 LangChain 抽象复杂度 | agno、pydantic-ai、smolagents |
| TypeScript / Node 生态 | mastra、vercel/ai SDK、VoltAgent |
| 文档 / 企业知识库为主 | llama_index、haystack |
| 长期记忆 / 状态化 | letta |
| 实时语音 agent | livekit/agents |

---

## 六、活跃度趋势观察

- **持续高强度（100+ commits / 90d）**：langchain、langgraph、crewAI、agno、openai-agents-python、pydantic-ai、vercel/ai SDK、livekit/agents、assistant-ui、camel-ai、microsoft/agent-framework。
- **节奏放缓但生态仍在**：autogen（已迁往 microsoft/agent-framework）、MetaGPT、smolagents、letta。
- **快速增长（2025 H2 后入场）**：pydantic-ai、agno、VoltAgent、openai-agents-python、microsoft/agent-framework。

---

## 七、数据来源与采集方法

- GitHub REST/GraphQL API（`gh search repos` + `gh repo view` + `gh api repos/.../commits`）
- 时间窗口：90 天 commit 计数（采样上限 100）
- 排序依据：⭐ stars 为主，commit 活跃度 + 语言/许可证 + 流派代表性做加权
- 剔除范围：awesome lists、教程项目、paper 列表、纯 computer-use/browser agent（Coding Agent 与 Computer Use 在各自专项调研中）

报告生成时间：2026-07-29
