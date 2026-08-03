import type { ServerWebSocket } from "bun";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
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
} from "@g-agent/agent";
import {
  formatProviderRef,
  getActiveProvider,
  getServerHost,
  getServerPort,
  loadConfig,
  mergeAgentMcpServers,
  mergeAgentProviderOverrides,
  isMcpOAuthEnabled,
  type GAgentConfig,
  type ResolvedProvider,
} from "@g-agent/config";
import type { Skill } from "@g-agent/agent";
import {
  parseClientMessage,
  type AgentTaskInfo,
  type AgentTaskStatus,
  type McpServerCatalogEntry,
  type ServerMessage,
} from "@g-agent/shared";
import type { McpServerConfig } from "@g-agent/config";

const initialConfig = await loadConfig();
let config = initialConfig.config;
const configPath = initialConfig.path;
let loadedAgents = await loadAgents(config);
const { agent: initialAgent } = resolveActiveAgent(undefined, loadedAgents);
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
  cancelRequested: boolean;
  abortController?: AbortController;
  history: ConversationMessage[];
  activeAgent: AgentConfig;
  systemPrompt: string;
  /** Effective provider after merging agent-level overrides. */
  effectiveProvider: ResolvedProvider | null;
  mcpManager: McpManager;
  agentTasks: BackgroundAgentTask[];
  nextAgentTaskSlot: number;
  activeAgentTaskSlot?: number;
};

type BackgroundAgentTask = {
  slot: number;
  agent: AgentConfig;
  title: string;
  status: AgentTaskStatus;
  activity?: string;
  createdAt: number;
  completedAt?: number;
  unread: boolean;
  mcpManager?: McpManager;
  history: ConversationMessage[];
  transcript: Array<{
    role: "user" | "assistant";
    content: string;
    thinking?: string;
    tools?: Array<{ name: string; args: string }>;
    durationMs?: number;
  }>;
  activeTurn?: {
    content: string;
    thinking: string;
    tools: Array<{ name: string; args: string }>;
  };
  promptQueue: string[];
  draining: boolean;
  abortController?: AbortController;
};

function send(ws: ServerWebSocket<WsData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

function agentTaskInfo(task: BackgroundAgentTask): AgentTaskInfo {
  return {
    slot: task.slot,
    agent: task.agent.name,
    title: task.title,
    status: task.status,
    ...(task.activity ? { activity: task.activity } : {}),
    elapsedMs: Math.max(
      0,
      (task.completedAt ?? Date.now()) - task.createdAt,
    ),
    unread: task.unread,
  };
}

function sendAgentTasks(ws: ServerWebSocket<WsData>): void {
  send(ws, {
    type: "agent_tasks",
    tasks: ws.data.agentTasks.map(agentTaskInfo),
  });
}

function summarizeToolActivity(name: string, argsText: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsText) as Record<string, unknown>;
  } catch {
    // Tool progress is best-effort and must never affect execution.
  }
  if (name === "read" || name === "write") {
    return `${name === "read" ? "Reading" : "Writing"} ${String(args.path ?? "file")}`;
  }
  if (name === "bash") {
    return "Running a command";
  }
  if (name === "glob" || name === "grep") {
    return "Searching files";
  }
  return `Using ${name}`;
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
        oauth: isMcpOAuthEnabled(config) || result?.oauth,
        authRequired: result?.authRequired ?? false,
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
  config = freshConfig;
  clearGlobalSkillsCache();
  loadedAgents = await loadAgents(config);
  ensureReloadWatches();
  return loadedAgents;
}

function syncActiveAgentConfig(ws: ServerWebSocket<WsData>): AgentConfig {
  const refreshed = loadedAgents.agents.get(ws.data.activeAgent.name);
  if (refreshed) {
    ws.data.activeAgent = refreshed;
    ws.data.systemPrompt = buildAgentSystemPrompt(refreshed, loadedAgents);
    ws.data.effectiveProvider = resolveProvider(refreshed);
    return refreshed;
  }

  const { agent } = resolveActiveAgent(undefined, loadedAgents);
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

function refreshClient(ws: ServerWebSocket<WsData>): void {
  sendAgentsCatalog(ws);
  send(ws, { type: "skills", skills: skillsCatalog(ws.data.activeAgent) });
  sendMcpCatalog(ws);
  send(ws, { type: "system_prompt", text: ws.data.systemPrompt });
  sendContextUsage(ws);
}

/**
 * Re-read config + agents + skills from disk and push the fresh catalogs to
 * every connected client. MCP connections are only re-established when the
 * merged MCP server set for a client's active agent actually changed.
 */
async function reloadAndRefreshClients(): Promise<void> {
  const mcpSnapshots = new Map<ServerWebSocket<WsData>, string>();
  for (const ws of clients) {
    mcpSnapshots.set(ws, JSON.stringify(mergedMcpServers(ws.data.activeAgent)));
  }

  await reloadAgentsCatalog();

  for (const ws of clients) {
    syncActiveAgentConfig(ws);
    const after = JSON.stringify(mergedMcpServers(ws.data.activeAgent));
    if (mcpSnapshots.get(ws) !== after) {
      await ws.data.mcpManager.close();
      ws.data.mcpManager = await connectMcpForAgent(ws.data.activeAgent);
    }
    refreshClient(ws);
  }
}

const watchedReloadPaths = new Set<string>();

/**
 * Watch a path and trigger a debounced full reload + client refresh on any
 * change. `filterFile` narrows a directory watch to a single file (used for
 * config.json, since editors replace the file and break direct file watches).
 */
function watchPathForReload(
  path: string,
  options: { recursive?: boolean; filterFile?: string } = {},
): void {
  if (!path || watchedReloadPaths.has(path)) {
    return;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    watch(path, { recursive: options.recursive ?? false }, (_event, filename) => {
      if (options.filterFile && filename && filename !== options.filterFile) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        void reloadAndRefreshClients().catch((error) => {
          console.warn(
            `Failed to reload after change under ${path}:`,
            error instanceof Error ? error.message : error,
          );
        });
      }, 300);
    });
    watchedReloadPaths.add(path);
  } catch (error) {
    console.warn(
      `Failed to watch ${path}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function ensureReloadWatches(): void {
  if (loadedAgents.userPath) {
    watchPathForReload(loadedAgents.userPath, { recursive: true });
  }
  if (loadedAgents.skillWatchPaths.length > 0) {
    for (const path of loadedAgents.skillWatchPaths) {
      watchPathForReload(path, { recursive: true });
    }
  } else {
    if (loadedAgents.sharedSkillsPath) {
      watchPathForReload(loadedAgents.sharedSkillsPath, { recursive: true });
    }
    if (loadedAgents.gagentSkillsPath) {
      watchPathForReload(loadedAgents.gagentSkillsPath, { recursive: true });
    }
  }
  if (configPath) {
    watchPathForReload(dirname(configPath), { filterFile: basename(configPath) });
  }
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

/** Re-read the Agent catalog for a new lobby connection. */
async function loadStartupAgent(): Promise<{ agent: AgentConfig }> {
  await reloadAgentsCatalog();
  return { agent: resolveActiveAgent(undefined, loadedAgents).agent };
}

async function applyAgentSwitch(
  ws: ServerWebSocket<WsData>,
  target: AgentConfig,
  options: { clearHistory: boolean; reconnectMcp?: boolean },
): Promise<void> {
  const agentChanged = target.name !== ws.data.activeAgent.name;
  if (agentChanged || options.reconnectMcp) {
    await ws.data.mcpManager.close();
    ws.data.activeAgent = target;
    ws.data.systemPrompt = buildAgentSystemPrompt(target, loadedAgents);
    ws.data.effectiveProvider = resolveProvider(target);
    ws.data.mcpManager = await connectMcpForAgent(target);
  }

  ws.data.promptQueue.length = 0;
  if (options.clearHistory) {
    ws.data.history.length = 0;
  }

  refreshClient(ws);
}

/**
 * Start a clean session without restarting the server process.
 *
 * A session boundary is also a resource reload boundary: config, agents and
 * skills are re-read from disk, and MCP connections are recreated even when
 * their serialized config did not change (the MCP server implementation or
 * its advertised tools may have changed).
 */
async function restartSession(ws: ServerWebSocket<WsData>): Promise<void> {
  const currentAgentName = ws.data.activeAgent.name;
  await reloadAgentsCatalog();

  const target =
    loadedAgents.agents.get(currentAgentName) ??
    resolveActiveAgent(undefined, loadedAgents).agent;

  await applyAgentSwitch(ws, target, {
    clearHistory: true,
    reconnectMcp: true,
  });
  for (const task of ws.data.agentTasks) {
    await task.mcpManager?.close();
  }
  ws.data.agentTasks.length = 0;
  ws.data.nextAgentTaskSlot = 1;
  ws.data.activeAgentTaskSlot = undefined;
  sendAgentTasks(ws);
}

function sendAgentSession(
  ws: ServerWebSocket<WsData>,
  task?: BackgroundAgentTask,
): void {
  send(ws, {
    type: "agent_session",
    ...(task ? { slot: task.slot } : {}),
    agent: task?.agent.name ?? ws.data.activeAgent.name,
    model: task
      ? modelLabel(resolveProvider(task.agent))
      : modelLabel(ws.data.effectiveProvider),
    history: task
      ? task.transcript
      : ws.data.history.map((message) => ({
          role: message.role,
          content: message.content ?? "",
        })),
    ...(task?.activeTurn ? { activeTurn: task.activeTurn } : {}),
  });
}

function createAgentSession(
  ws: ServerWebSocket<WsData>,
  agent: AgentConfig,
  activate = true,
): BackgroundAgentTask {
  const task: BackgroundAgentTask = {
    slot: ws.data.nextAgentTaskSlot++,
    agent,
    title: "",
    status: "idle",
    activity: "Waiting for first message",
    createdAt: Date.now(),
    unread: false,
    history: [],
    transcript: [],
    promptQueue: [],
    draining: false,
  };
  ws.data.agentTasks.push(task);
  if (activate) {
    ws.data.activeAgentTaskSlot = task.slot;
  }
  sendAgentTasks(ws);
  if (activate) {
    sendAgentSession(ws, task);
  }
  return task;
}

async function runAgentSessionPrompt(
  ws: ServerWebSocket<WsData>,
  task: BackgroundAgentTask,
  prompt: string,
): Promise<void> {
  // elapsedMs describes the current (or most recently completed) turn, not
  // the lifetime of the reusable child session.
  task.createdAt = Date.now();
  task.completedAt = undefined;
  if (!task.title) {
    task.title = prompt;
  }
  if (!task.mcpManager) {
    task.status = "starting";
    task.activity = "Starting";
    sendAgentTasks(ws);
    task.mcpManager = await connectMcpForAgent(task.agent);
  }

  task.status = "thinking";
  task.activity = "Analyzing";
  task.unread = false;
  const isVisible = () => ws.data.activeAgentTaskSlot === task.slot;
  const priorHistory = [...task.history];
  task.history.push({ role: "user", content: prompt });
  task.transcript.push({ role: "user", content: prompt });
  task.activeTurn = { content: "", thinking: "", tools: [] };
  if (isVisible()) {
    send(ws, { type: "start" });
  }
  sendAgentTasks(ws);

  let assistantText = "";
  let failed = false;
  const abortController = new AbortController();
  task.abortController = abortController;
  try {
    await runAgent(
      prompt,
      (event) => {
        const wasStatus = task.status;
        const wasActivity = task.activity;
        if (event.type === "thinking_delta") {
          task.status = "thinking";
          task.activity = "Analyzing";
          task.activeTurn!.thinking += event.text;
          if (isVisible()) send(ws, { type: "thinkingDelta", text: event.text });
        } else if (event.type === "tool_call") {
          task.status = "tool_running";
          task.activity = summarizeToolActivity(event.name, event.args);
          task.activeTurn!.tools.push({ name: event.name, args: event.args });
          if (isVisible()) {
            send(ws, { type: "tool_call", name: event.name, args: event.args });
          }
        } else if (event.type === "tool_result") {
          if (isVisible()) {
            send(ws, {
              type: "tool_result",
              name: event.name,
              output: event.output,
            });
          }
        } else if (event.type === "delta") {
          task.status = "responding";
          task.activity = "Writing response";
          assistantText += event.text;
          task.activeTurn!.content += event.text;
          if (isVisible()) send(ws, { type: "delta", text: event.text });
        } else if (event.type === "error") {
          failed = true;
          task.status = "failed";
          task.activity = "Failed";
          task.completedAt = Date.now();
          task.unread = !isVisible();
          const turn = task.activeTurn;
          if (turn && (turn.content.trim() || turn.thinking.trim() || turn.tools.length > 0)) {
            task.transcript.push({
              role: "assistant",
              content: turn.content,
              ...(turn.thinking ? { thinking: turn.thinking } : {}),
              ...(turn.tools.length > 0 ? { tools: turn.tools } : {}),
              durationMs: Date.now() - task.createdAt,
            });
          }
          task.activeTurn = undefined;
          if (isVisible()) send(ws, { type: "error", message: event.message });
        } else if (event.type === "cancelled") {
          failed = true;
          task.history = priorHistory;
          task.transcript.pop();
          task.activeTurn = undefined;
          task.status = "cancelled";
          task.activity = "Cancelled";
          task.completedAt = Date.now();
          if (isVisible()) send(ws, { type: "done" });
        } else if (event.type === "done") {
          if (!failed) {
            if (assistantText.trim()) {
              task.history.push({ role: "assistant", content: assistantText });
            }
            const turn = task.activeTurn;
            if (turn && (turn.content.trim() || turn.thinking.trim() || turn.tools.length > 0)) {
              task.transcript.push({
                role: "assistant",
                content: turn.content,
                ...(turn.thinking ? { thinking: turn.thinking } : {}),
                ...(turn.tools.length > 0 ? { tools: turn.tools } : {}),
                durationMs: Date.now() - task.createdAt,
              });
            }
            task.activeTurn = undefined;
            task.status = "completed";
            task.activity = "Ready";
            task.completedAt = Date.now();
            task.unread = !isVisible();
          }
          if (isVisible()) send(ws, { type: "done" });
        }
        if (
          task.status !== wasStatus ||
          task.activity !== wasActivity ||
          event.type === "done" ||
          event.type === "error"
        ) {
          sendAgentTasks(ws);
        }
      },
      resolveProvider(task.agent),
      buildAgentSystemPrompt(task.agent, loadedAgents),
      priorHistory,
      { mcpManager: task.mcpManager, signal: abortController.signal },
    );
  } finally {
    if (task.abortController === abortController) {
      task.abortController = undefined;
    }
  }
}

async function drainAgentSessionQueue(
  ws: ServerWebSocket<WsData>,
  task: BackgroundAgentTask,
): Promise<void> {
  if (task.draining) return;
  task.draining = true;
  try {
    while (task.promptQueue.length > 0) {
      const prompt = task.promptQueue.shift();
      if (prompt) await runAgentSessionPrompt(ws, task, prompt);
    }
  } finally {
    task.draining = false;
  }
}

async function runPrompt(ws: ServerWebSocket<WsData>, prompt: string): Promise<void> {
  trimHistoryForPrompt(ws, prompt);
  sendContextUsage(ws, prompt);
  const isVisible = () => ws.data.activeAgentTaskSlot === undefined;
  if (isVisible()) send(ws, { type: "start" });

  let assistantText = "";
  let failed = false;
  const abortController = new AbortController();
  ws.data.abortController = abortController;

  try {
    await runAgent(
      prompt,
      (event) => {
      if (event.type === "system_prompt") {
        if (isVisible()) send(ws, { type: "system_prompt", text: event.text });
        return;
      }

      if (event.type === "thinking_delta") {
        if (isVisible()) send(ws, { type: "thinkingDelta", text: event.text });
        return;
      }

      if (event.type === "delta") {
        assistantText += event.text;
        if (isVisible()) send(ws, { type: "delta", text: event.text });
        return;
      }

      if (event.type === "tool_call") {
        if (isVisible()) {
          send(ws, {
            type: "tool_call",
            name: event.name,
            args: event.args,
          });
        }
        return;
      }

      if (event.type === "tool_result") {
        if (isVisible()) {
          send(ws, {
            type: "tool_result",
            name: event.name,
            output: event.output,
          });
        }
        return;
      }

      if (event.type === "error") {
        failed = true;
        if (isVisible()) send(ws, { type: "error", message: event.message });
        return;
      }

      if (event.type === "cancelled") {
        failed = true;
        ws.data.cancelRequested = false;
        sendContextUsage(ws);
        if (isVisible()) send(ws, { type: "done" });
        return;
      }

      if (!failed) {
        if (!ws.data.cancelRequested) {
          ws.data.history.push({ role: "user", content: prompt });
          if (assistantText.trim()) {
            ws.data.history.push({ role: "assistant", content: assistantText });
          }
        } else {
          ws.data.cancelRequested = false;
        }
      }
      sendContextUsage(ws);
      if (isVisible()) send(ws, { type: "done" });
      },
      ws.data.effectiveProvider,
      ws.data.systemPrompt,
      ws.data.history,
      { mcpManager: ws.data.mcpManager, signal: abortController.signal },
    );
  } finally {
    if (ws.data.abortController === abortController) {
      ws.data.abortController = undefined;
    }
  }
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
      if (ws.data.cancelRequested) {
        ws.data.cancelRequested = false;
        ws.data.promptQueue.length = 0;
        break;
      }
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
          cancelRequested: false,
          history: [],
          activeAgent: initialAgent,
          systemPrompt: buildAgentSystemPrompt(initialAgent, loadedAgents),
          effectiveProvider: resolveProvider(initialAgent),
          mcpManager: new McpManager(),
          agentTasks: [],
          nextAgentTaskSlot: 1,
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
        const { agent } = await loadStartupAgent();
        ws.data.activeAgent = agent;
        ws.data.systemPrompt = buildAgentSystemPrompt(agent, loadedAgents);
        ws.data.effectiveProvider = resolveProvider(agent);
        ws.data.mcpManager = await connectMcpForAgent(agent);

        send(ws, { type: "ready" });
        refreshClient(ws);
      })();
    },
    close(ws) {
      clients.delete(ws);
      void ws.data.mcpManager.close();
      for (const task of ws.data.agentTasks) {
        void task.mcpManager?.close();
      }
    },
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      const message = parseClientMessage(text);

      if (!message) {
        send(ws, { type: "error", message: "Invalid message" });
        return;
      }

      if (message.type === "reset") {
        void restartSession(ws).catch((error) => {
          send(ws, {
            type: "error",
            message:
              error instanceof Error ? error.message : "Session restart failed",
          });
        });
        return;
      }

      if (message.type === "agent_tasks") {
        sendAgentTasks(ws);
        return;
      }

      if (message.type === "agent_task") {
        const task = ws.data.agentTasks.find(
          (candidate) => candidate.slot === message.slot,
        );
        if (!task) {
          send(ws, {
            type: "error",
            message: `Unknown agent task /${message.slot}`,
          });
          return;
        }
        ws.data.activeAgentTaskSlot = task.slot;
        task.unread = false;
        sendAgentSession(ws, task);
        sendAgentTasks(ws);
        return;
      }

      if (message.type === "agent_back") {
        ws.data.activeAgentTaskSlot = undefined;
        sendAgentSession(ws);
        return;
      }

      if (message.type === "cancel") {
        const activeTask = ws.data.activeAgentTaskSlot
          ? ws.data.agentTasks.find(
              (task) => task.slot === ws.data.activeAgentTaskSlot,
            )
          : undefined;
        if (activeTask) {
          activeTask.promptQueue.length = 0;
          activeTask.abortController?.abort();
          return;
        }
        ws.data.cancelRequested = ws.data.abortController !== undefined;
        ws.data.promptQueue.length = 0;
        ws.data.abortController?.abort();
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
          if (target.name === loadedAgents.defaultName) {
            ws.data.activeAgentTaskSlot = undefined;
            sendAgentSession(ws);
            return;
          }

          const initialMessage = message.message?.trim();
          const task = createAgentSession(ws, target, !initialMessage);
          if (initialMessage) {
            task.status = "queued";
            task.activity = "Queued";
            task.promptQueue.push(initialMessage);
            sendAgentTasks(ws);
            void drainAgentSessionQueue(ws, task);
          }
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

      if (message.type === "reload") {
        void reloadAndRefreshClients().catch((error) => {
          send(ws, {
            type: "error",
            message:
              error instanceof Error ? error.message : "Reload failed",
          });
        });
        return;
      }

      if (message.type === "mcp_auth") {
        void (async () => {
          const serverName = message.name.trim();
          if (!serverName) {
            send(ws, { type: "error", message: "MCP server name is required" });
            return;
          }

          const merged = mergedMcpServers(ws.data.activeAgent);
          if (!(serverName in merged)) {
            send(ws, {
              type: "error",
              message: `Unknown MCP server "${serverName}"`,
            });
            return;
          }

          send(ws, {
            type: "start",
          });

          try {
            const result = await ws.data.mcpManager.authenticate(serverName);
            if (result.ok) {
              console.log(
                `MCP OAuth complete for agent=${ws.data.activeAgent.name} server=${serverName} tools=${result.toolCount ?? 0}`,
              );
            } else {
              console.warn(
                `MCP OAuth failed for agent=${ws.data.activeAgent.name} server=${serverName}: ${result.error}`,
              );
              send(ws, {
                type: "error",
                message: result.error ?? "MCP OAuth authorization failed",
              });
            }
          } catch (error) {
            const messageText =
              error instanceof Error ? error.message : "MCP OAuth authorization failed";
            send(ws, { type: "error", message: messageText });
          } finally {
            sendMcpCatalog(ws);
            send(ws, { type: "done" });
          }
        })();
        return;
      }

      const rawPrompt = message.message;
      if (!rawPrompt.trim()) {
        send(ws, { type: "error", message: "Empty message" });
        return;
      }

      const activeTask = ws.data.activeAgentTaskSlot
        ? ws.data.agentTasks.find(
            (task) => task.slot === ws.data.activeAgentTaskSlot,
          )
        : undefined;
      if (activeTask) {
        activeTask.status = "queued";
        activeTask.activity = "Queued";
        activeTask.promptQueue.push(rawPrompt);
        sendAgentTasks(ws);
        void drainAgentSessionQueue(ws, activeTask);
        return;
      }

      ws.data.promptQueue.push(rawPrompt.trim());
      void drainPromptQueue(ws);
    },
  },
});

ensureReloadWatches();

setInterval(() => {
  for (const ws of clients) {
    if (
      ws.data.agentTasks.some((task) =>
        ["queued", "starting", "thinking", "tool_running", "responding"].includes(
          task.status,
        ),
      )
    ) {
      sendAgentTasks(ws);
    }
  }
}, 1_000);

const startupProvider = resolveProvider(initialAgent);
const providerLabel = startupProvider ? formatProviderRef(startupProvider) : "echo";
const configLabel = configPath ?? "none";
const agentsLabel = `${loadedAgents.list.length}${loadedAgents.userPath ? ` (user: ${loadedAgents.userPath})` : ""}`;
const builtinCount = initialAgent.skills.filter((s) => s.source === "builtin").length;
const sharedCount = initialAgent.skills.filter((s) => s.source === "shared").length;
const gagentCount = initialAgent.skills.filter((s) => s.source === "gagent").length;
const selfCount = initialAgent.skills.filter((s) => s.source === "self").length;
const sharedLabel = loadedAgents.sharedSkillsPath ?? "none";
const gagentLabel = loadedAgents.gagentSkillsPath ?? "none";
const skillsLabel = `built-in=${builtinCount} shared=${sharedCount} gagent=${gagentCount} self=${selfCount} shared-path=${sharedLabel} gagent-path=${gagentLabel}`;
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
