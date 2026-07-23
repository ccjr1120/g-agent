import type { ServerWebSocket } from "bun";
import { watch } from "node:fs";
import {
  buildAgentSystemPrompt,
  builtinTools,
  clearGlobalSkillsCache,
  loadAgents,
  McpManager,
  resolveActiveAgent,
  runAgent,
  type AgentConfig,
  type ConversationMessage,
  type LoadedAgents,
  type ResolvedAgent,
} from "@g-agent/agent";
import {
  formatProviderRef,
  getActiveProvider,
  getServerHost,
  getServerPort,
  loadConfig,
  mergeAgentMcpServers,
  mergeAgentProviderOverrides,
  saveActiveAgent,
  type GAgentConfig,
  type ResolvedProvider,
} from "@g-agent/config";
import type { Skill } from "@g-agent/agent";
import { parseClientMessage, type McpServerCatalogEntry, type ServerMessage } from "@g-agent/shared";
import type { McpServerConfig } from "@g-agent/config";

const { config, path: configPath } = await loadConfig();
let loadedAgents = await loadAgents(config);
const { agent: initialAgent, fallback } = resolveActiveAgent(
  config.agent,
  loadedAgents,
);
const host = getServerHost();
const port = getServerPort();

function resolveProvider(
  agent: AgentConfig,
  runtimeConfig: GAgentConfig = config,
): ResolvedProvider | null {
  try {
    return getActiveProvider(
      mergeAgentProviderOverrides(runtimeConfig, {
        provider: agent.provider,
        providers: agent.providers,
      }),
    );
  } catch {
    return null;
  }
}

function mergedMcpServers(agent: AgentConfig, runtimeConfig: GAgentConfig = config) {
  return mergeAgentMcpServers(runtimeConfig, { mcpServers: agent.mcpServers });
}

async function connectMcpForAgent(
  agent: AgentConfig,
  runtimeConfig: GAgentConfig = config,
): Promise<McpManager> {
  const manager = new McpManager();
  const results = await manager.connect(mergedMcpServers(agent, runtimeConfig));

  for (const result of results) {
    if (result.ok) {
      console.log(
        `MCP server ${result.serverName} connected for agent=${agent.name} tools=${result.toolCount ?? 0}`,
      );
      continue;
    }
    console.warn(
      `MCP server ${result.serverName} failed for agent=${agent.name}: ${result.error}`,
    );
  }

  return manager;
}

type WsData = {
  promptQueue: string[];
  draining: boolean;
  history: ConversationMessage[];
  activeAgent: AgentConfig;
  systemPrompt: string;
  /** Effective provider after merging agent-level overrides. */
  effectiveProvider: ResolvedProvider | null;
  /** Set once per connection from the startup fallback; surfaced to the
   * client as an `agent_fallback` hint on socket open. */
  startupFallback?: { requested: string };
  mcpManager: McpManager;
};

function send(ws: ServerWebSocket<WsData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

function estimateTextTokens(text: string | null | undefined): number {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function estimateConversationTokens(
  systemPrompt: string,
  history: ConversationMessage[],
  pendingPrompt?: string,
): number {
  const systemTokens = estimateTextTokens(systemPrompt) + 4;
  const historyTokens = history.reduce((total, message) => {
    return total + estimateTextTokens(message.content) + 4;
  }, 0);
  const pendingTokens = pendingPrompt ? estimateTextTokens(pendingPrompt) + 4 : 0;
  return systemTokens + historyTokens + pendingTokens;
}

function getContextWindow(provider: ResolvedProvider | null): number | undefined {
  return provider?.contextWindow;
}

function contextUsage(
  ws: ServerWebSocket<WsData>,
  pendingPrompt?: string,
): { usedTokens: number; maxTokens: number; percent: number } {
  const maxTokens = getContextWindow(ws.data.effectiveProvider);
  const usedTokens = estimateConversationTokens(
    ws.data.systemPrompt,
    ws.data.history,
    pendingPrompt,
  );
  if (!maxTokens) {
    return { usedTokens, maxTokens: 0, percent: 0 };
  }
  return {
    usedTokens,
    maxTokens,
    percent: Math.min(100, Math.round((usedTokens / maxTokens) * 100)),
  };
}

function sendContextUsage(
  ws: ServerWebSocket<WsData>,
  pendingPrompt?: string,
): void {
  send(ws, { type: "context", ...contextUsage(ws, pendingPrompt) });
}

function trimHistoryForPrompt(
  ws: ServerWebSocket<WsData>,
  prompt: string,
): void {
  const maxTokens = getContextWindow(ws.data.effectiveProvider);
  if (!maxTokens) {
    return;
  }
  while (
    ws.data.history.length > 0 &&
    estimateConversationTokens(ws.data.systemPrompt, ws.data.history, prompt) >
      maxTokens
  ) {
    const removeCount = ws.data.history[0]?.role === "user" ? 2 : 1;
    ws.data.history.splice(0, removeCount);
  }
}

function agentCatalog(loaded: LoadedAgents, active: AgentConfig) {
  return loaded.list.map((a) => ({
    name: a.name,
    description: a.description,
    active: a.name === active.name,
  }));
}

function skillsCatalog(active: AgentConfig) {
  return active.skills.map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source,
  }));
}

function formatMcpTarget(config: McpServerConfig): {
  transport: "stdio" | "url";
  target: string;
} {
  if (config.command) {
    const args = config.args?.join(" ") ?? "";
    return {
      transport: "stdio",
      target: args ? `${config.command} ${args}` : config.command,
    };
  }

  return {
    transport: "url",
    target: config.url ?? "",
  };
}

function mcpCatalog(
  agent: AgentConfig,
  manager: McpManager,
): McpServerCatalogEntry[] {
  const agentServerNames = new Set(Object.keys(agent.mcpServers ?? {}));
  const merged = mergedMcpServers(agent);

  return Object.entries(merged)
    .map(([name, config]) => {
      const result = manager.getConnectionResult(name);
      const { transport, target } = formatMcpTarget(config);
      const tools = manager.getServerTools(name);

      return {
        name,
        source: agentServerNames.has(name) ? "agent" : "global",
        transport,
        target,
        connected: result?.ok ?? false,
        error: result?.ok ? undefined : result?.error,
        toolCount: result?.toolCount ?? tools.length,
        tools,
      } satisfies McpServerCatalogEntry;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sendMcpCatalog(ws: ServerWebSocket<WsData>): void {
  send(ws, {
    type: "mcp",
    servers: mcpCatalog(ws.data.activeAgent, ws.data.mcpManager),
  });
}

function modelLabel(provider: ResolvedProvider | null): string {
  return provider ? formatProviderRef(provider) : "echo";
}

const clients = new Set<ServerWebSocket<WsData>>();

async function reloadAgentsCatalog(): Promise<LoadedAgents> {
  const { config: freshConfig } = await loadConfig();
  Object.assign(config, freshConfig);
  clearGlobalSkillsCache();
  loadedAgents = await loadAgents(config);
  ensureAgentsDirectoryWatch();
  return loadedAgents;
}

function syncActiveAgentConfig(ws: ServerWebSocket<WsData>): AgentConfig {
  const refreshed = loadedAgents.agents.get(ws.data.activeAgent.name);
  if (refreshed) {
    ws.data.activeAgent = refreshed;
    ws.data.systemPrompt = buildAgentSystemPrompt(refreshed, loadedAgents);
    return refreshed;
  }

  const { agent } = resolveActiveAgent(config.agent, loadedAgents);
  ws.data.activeAgent = agent;
  ws.data.systemPrompt = buildAgentSystemPrompt(agent, loadedAgents);
  ws.data.effectiveProvider = resolveProvider(agent);
  return agent;
}

function sendAgentsCatalog(ws: ServerWebSocket<WsData>): void {
  send(ws, {
    type: "agents",
    agents: agentCatalog(loadedAgents, ws.data.activeAgent),
    active: ws.data.activeAgent.name,
    model: modelLabel(ws.data.effectiveProvider),
  });
}

function broadcastAgentsCatalog(): void {
  for (const ws of clients) {
    syncActiveAgentConfig(ws);
    sendAgentsCatalog(ws);
  }
}

function watchAgentsDirectory(): void {
  const userPath = loadedAgents.userPath;
  if (!userPath) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(userPath, { recursive: true }, () => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void reloadAgentsCatalog()
        .then(() => {
          broadcastAgentsCatalog();
        })
        .catch((error) => {
          console.warn(
            "Failed to reload agents after directory change:",
            error instanceof Error ? error.message : error,
          );
        });
    }, 300);
  });
}

let agentsDirectoryWatchStarted = false;

function ensureAgentsDirectoryWatch(): void {
  if (agentsDirectoryWatchStarted) {
    return;
  }
  if (!loadedAgents.userPath) {
    return;
  }
  agentsDirectoryWatchStarted = true;
  watchAgentsDirectory();
}

/**
 * Build the prompt that injects a skill's SKILL.md body into a conversation
 * turn, so the model follows the skill's instructions on demand. `body` is
 * already loaded and `{{skill_dir}}`-templated by `loadSkillsFromDir`.
 */
function buildSkillPrompt(skill: Skill): string {
  const header = skill.description
    ? `技能：${skill.name}\n说明：${skill.description}\n`
    : `技能：${skill.name}\n`;
  return [
    "请按以下技能指令执行。",
    "",
    header,
    "指令正文：",
    "---",
    skill.body,
    "---",
    "",
    "请立即开始执行该技能。需要用户输入时主动询问用户。",
  ].join("\n");
}

/** Re-read config.json so reconnecting clients pick up the last-used agent. */
async function loadStartupAgent(): Promise<ResolvedAgent & { runtimeConfig: GAgentConfig }> {
  await reloadAgentsCatalog();
  const resolved = resolveActiveAgent(config.agent, loadedAgents);
  return { ...resolved, runtimeConfig: config };
}

async function applyAgentSwitch(
  ws: ServerWebSocket<WsData>,
  target: AgentConfig,
  options: { clearHistory: boolean },
): Promise<void> {
  if (target.name !== ws.data.activeAgent.name) {
    await ws.data.mcpManager.close();
    ws.data.activeAgent = target;
    ws.data.systemPrompt = buildAgentSystemPrompt(target, loadedAgents);
    ws.data.effectiveProvider = resolveProvider(target);
    ws.data.mcpManager = await connectMcpForAgent(target);

    void saveActiveAgent(target.name)
      .then(() => {
        config.agent = target.name;
      })
      .catch((error) => {
        console.warn(
          `Failed to persist active agent "${target.name}" to config:`,
          error instanceof Error ? error.message : error,
        );
      });
  }

  ws.data.promptQueue.length = 0;
  if (options.clearHistory) {
    ws.data.history.length = 0;
  }

  send(ws, {
    type: "agents",
    agents: agentCatalog(loadedAgents, ws.data.activeAgent),
    active: ws.data.activeAgent.name,
    model: modelLabel(ws.data.effectiveProvider),
  });
  send(ws, { type: "skills", skills: skillsCatalog(ws.data.activeAgent) });
  sendMcpCatalog(ws);
  send(ws, { type: "system_prompt", text: ws.data.systemPrompt });
  sendContextUsage(ws);
}

async function runPrompt(ws: ServerWebSocket<WsData>, prompt: string): Promise<void> {
  trimHistoryForPrompt(ws, prompt);
  sendContextUsage(ws, prompt);
  send(ws, { type: "start" });

  let assistantText = "";
  let failed = false;

  await runAgent(
    prompt,
    (event) => {
      if (event.type === "system_prompt") {
        send(ws, { type: "system_prompt", text: event.text });
        return;
      }

      if (event.type === "delta") {
        assistantText += event.text;
        send(ws, { type: "delta", text: event.text });
        return;
      }

      if (event.type === "tool_call") {
        send(ws, {
          type: "tool_call",
          name: event.name,
          args: event.args,
        });
        return;
      }

      if (event.type === "tool_result") {
        send(ws, {
          type: "tool_result",
          name: event.name,
          output: event.output,
        });
        return;
      }

      if (event.type === "error") {
        failed = true;
        send(ws, { type: "error", message: event.message });
        return;
      }

      if (!failed) {
        ws.data.history.push({ role: "user", content: prompt });
        if (assistantText.trim()) {
          ws.data.history.push({ role: "assistant", content: assistantText });
        }
      }
      sendContextUsage(ws);
      send(ws, { type: "done" });
    },
    ws.data.effectiveProvider,
    ws.data.systemPrompt,
    ws.data.history,
    { mcpManager: ws.data.mcpManager },
  );
}

async function drainPromptQueue(ws: ServerWebSocket<WsData>): Promise<void> {
  if (ws.data.draining) {
    return;
  }

  ws.data.draining = true;

  try {
    while (ws.data.promptQueue.length > 0) {
      const prompt = ws.data.promptQueue.shift();
      if (!prompt) {
        continue;
      }
      await runPrompt(ws, prompt);
    }
  } finally {
    ws.data.draining = false;
  }
}

Bun.serve<WsData>({
  port,
  hostname: host,
  fetch(req, server) {
    if (
      server.upgrade(req, {
        data: {
          promptQueue: [],
          draining: false,
          history: [],
          activeAgent: initialAgent,
          systemPrompt: buildAgentSystemPrompt(initialAgent, loadedAgents),
          effectiveProvider: resolveProvider(initialAgent),
          startupFallback: fallback,
          mcpManager: new McpManager(),
        } satisfies WsData,
      })
    ) {
      return undefined;
    }

    return new Response("G-Agent server — connect via WebSocket", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      void (async () => {
        const { agent, fallback, runtimeConfig } = await loadStartupAgent();
        ws.data.activeAgent = agent;
        ws.data.systemPrompt = buildAgentSystemPrompt(agent, loadedAgents);
        ws.data.effectiveProvider = resolveProvider(agent, runtimeConfig);
        ws.data.startupFallback = fallback;
        ws.data.mcpManager = await connectMcpForAgent(agent, runtimeConfig);

        send(ws, { type: "ready" });
        if (ws.data.startupFallback) {
          send(ws, {
            type: "agent_fallback",
            requested: ws.data.startupFallback.requested,
            active: ws.data.activeAgent.name,
          });
        }
        send(ws, {
          type: "agents",
          agents: agentCatalog(loadedAgents, ws.data.activeAgent),
          active: ws.data.activeAgent.name,
          model: modelLabel(ws.data.effectiveProvider),
        });
        send(ws, {
          type: "skills",
          skills: skillsCatalog(ws.data.activeAgent),
        });
        sendMcpCatalog(ws);
        send(ws, { type: "system_prompt", text: ws.data.systemPrompt });
        sendContextUsage(ws);
      })();
    },
    close(ws) {
      clients.delete(ws);
      void ws.data.mcpManager.close();
    },
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      const message = parseClientMessage(text);

      if (!message) {
        send(ws, { type: "error", message: "Invalid message" });
        return;
      }

      if (message.type === "reset") {
        ws.data.promptQueue.length = 0;
        ws.data.history.length = 0;
        send(ws, { type: "system_prompt", text: ws.data.systemPrompt });
        sendContextUsage(ws);
        return;
      }

      if (message.type === "resume") {
        if (message.history.length === 0) {
          send(ws, { type: "error", message: "Cannot resume an empty session" });
          return;
        }

        void (async () => {
          await reloadAgentsCatalog();
          const targetName = message.agent.trim();
          const target = loadedAgents.agents.get(targetName);
          if (!target) {
            send(ws, { type: "error", message: `Unknown agent "${targetName}"` });
            return;
          }

          await applyAgentSwitch(ws, target, { clearHistory: false });
          ws.data.history = message.history.map((turn) => ({
            role: turn.role,
            content: turn.content,
          })) satisfies ConversationMessage[];

          send(ws, {
            type: "resumed",
            agent: ws.data.activeAgent.name,
            turns: ws.data.history.length,
          });
          sendContextUsage(ws);
        })();
        return;
      }

      if (message.type === "agent") {
        void (async () => {
          await reloadAgentsCatalog();
          syncActiveAgentConfig(ws);

          if (!message.name) {
            sendAgentsCatalog(ws);
            return;
          }

          const targetName = message.name.trim();
          const target = loadedAgents.agents.get(targetName);
          if (!target) {
            send(ws, { type: "error", message: `Unknown agent "${targetName}"` });
            return;
          }

          // Switching to the currently active agent is a no-op apart from
          // re-sending the catalog so the client stays in sync.
          if (target.name === ws.data.activeAgent.name) {
            sendAgentsCatalog(ws);
            return;
          }

          await applyAgentSwitch(ws, target, { clearHistory: true });
        })();
        return;
      }

      if (message.type === "skill") {
        const skillName = message.name.trim();
        if (!skillName) {
          send(ws, { type: "error", message: "Empty skill name" });
          return;
        }

        const skill = ws.data.activeAgent.skills.find(
          (s) => s.name === skillName,
        );
        if (!skill) {
          send(ws, { type: "error", message: `Unknown skill "${skillName}"` });
          return;
        }

        ws.data.promptQueue.push(buildSkillPrompt(skill));
        void drainPromptQueue(ws);
        return;
      }

      if (message.type === "mcp") {
        sendMcpCatalog(ws);
        return;
      }

      const prompt = message.message.trim();
      if (!prompt) {
        send(ws, { type: "error", message: "Empty message" });
        return;
      }

      ws.data.promptQueue.push(prompt);
      void drainPromptQueue(ws);
    },
  },
});

ensureAgentsDirectoryWatch();

const startupProvider = resolveProvider(initialAgent);
const providerLabel = startupProvider ? formatProviderRef(startupProvider) : "echo";
const configLabel = configPath ?? "none";
const agentsLabel = `${loadedAgents.list.length}${loadedAgents.userPath ? ` (user: ${loadedAgents.userPath})` : ""}`;
const builtinCount = initialAgent.skills.filter((s) => s.source === "builtin").length;
const globalCount = initialAgent.skills.filter((s) => s.source === "global").length;
const selfCount = initialAgent.skills.filter((s) => s.source === "self").length;
const globalLabel = loadedAgents.globalSkillsPath ?? "none";
const skillsLabel = `built-in=${builtinCount} global=${globalCount} self=${selfCount} global-path=${globalLabel}`;
const mcpCount = Object.keys(mergedMcpServers(initialAgent)).length;
console.log(
  `G-Agent server ws://${host}:${port} · agent=${initialAgent.name} · provider=${providerLabel} · config=${configLabel} · agents=${agentsLabel} · skills=${skillsLabel} · tools=${builtinTools.length} · mcp=${mcpCount}`,
);

for (const conflict of loadedAgents.skillConflicts) {
  const candidates = conflict.candidates
    .map((candidate) => `${candidate.source}:${candidate.path}`)
    .join(" | ");
  console.warn(
    `Skill conflict agent=${conflict.agent} skill=${conflict.name} selected=${conflict.selectedSource} candidates=${candidates}`,
  );
}
