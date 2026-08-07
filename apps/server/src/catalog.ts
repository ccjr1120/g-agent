import type { ServerWebSocket } from "bun";
import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import {
  buildAgentSystemPrompt,
  clearGlobalSkillsCache,
  loadAgents,
  resolveActiveAgent,
  type AgentConfig,
  type LoadedAgents,
  type McpManager,
} from "@g-agent/agent";
import {
  formatProviderRef,
  isMcpOAuthEnabled,
  loadConfig,
  type McpServerConfig,
  type ResolvedProvider,
} from "@g-agent/config";
import type { McpServerCatalogEntry } from "@g-agent/shared";
import {
  clients,
  configPath,
  loadedAgents,
  send,
  setConfig,
  setLoadedAgents,
  type WsData,
} from "./state.js";
import { connectMcpForAgent, mergedMcpServers, resolveProvider } from "./helpers.js";
import { sendContextUsage } from "./usage.js";

export function agentCatalog(loaded: LoadedAgents, active: AgentConfig) {
  return loaded.list.map((a) => ({
    name: a.name,
    description: a.description,
    active: a.name === active.name,
  }));
}

export function skillsCatalog(active: AgentConfig) {
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
  manager: McpManager | null,
): McpServerCatalogEntry[] {
  const agentServerNames = new Set(Object.keys(agent.mcpServers ?? {}));
  const merged = mergedMcpServers(agent);

  return Object.entries(merged)
    .map(([name, config]) => {
      const result = manager?.getConnectionResult(name);
      const { transport, target } = formatMcpTarget(config);
      const tools = manager?.getServerTools(name) ?? [];

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

/**
 * Resolve the MCP context the client currently sees: the active sub-agent
 * session (its agent config + its own McpManager) when one is open, otherwise
 * the main session. Keeps `/mcp` and the panel in sync with whichever agent
 * actually runs the next prompt, instead of always reporting the main agent.
 */
export function activeMcpContext(
  ws: ServerWebSocket<WsData>,
): { agent: AgentConfig; manager: McpManager | null } {
  if (ws.data.activeAgentTaskSlot !== undefined) {
    const task = ws.data.agentTasks.find(
      (candidate) => candidate.slot === ws.data.activeAgentTaskSlot,
    );
    if (task) {
      return { agent: task.agent, manager: task.mcpManager ?? null };
    }
  }
  return { agent: ws.data.activeAgent, manager: ws.data.mcpManager };
}

export function sendMcpCatalog(ws: ServerWebSocket<WsData>): void {
  const { agent, manager } = activeMcpContext(ws);
  send(ws, {
    type: "mcp",
    servers: mcpCatalog(agent, manager),
  });
}

export function modelLabel(provider: ResolvedProvider | null): string {
  return provider ? formatProviderRef(provider) : "echo";
}

export async function reloadAgentsCatalog(): Promise<LoadedAgents> {
  const { config: freshConfig } = await loadConfig();
  setConfig(freshConfig);
  clearGlobalSkillsCache();
  setLoadedAgents(await loadAgents(freshConfig));
  ensureReloadWatches();
  return loadedAgents;
}

export function syncActiveAgentConfig(ws: ServerWebSocket<WsData>): AgentConfig {
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

export function sendAgentsCatalog(ws: ServerWebSocket<WsData>): void {
  send(ws, {
    type: "agents",
    agents: agentCatalog(loadedAgents, ws.data.activeAgent),
    active: ws.data.activeAgent.name,
    model: modelLabel(ws.data.effectiveProvider),
  });
}

export function refreshClient(ws: ServerWebSocket<WsData>): void {
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
export async function reloadAndRefreshClients(): Promise<void> {
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

    // Re-resolve sub-agent sessions against the fresh catalog and reconnect
    // their MCP when the merged server set changed, so config edits to a
    // sub-agent take effect without a server restart.
    for (const task of ws.data.agentTasks) {
      const refreshed = loadedAgents.agents.get(task.agent.name);
      if (!refreshed) continue;
      const before = JSON.stringify(mergedMcpServers(task.agent));
      task.agent = refreshed;
      const afterTask = JSON.stringify(mergedMcpServers(task.agent));
      if (before !== afterTask && task.mcpManager) {
        await task.mcpManager.close();
        task.mcpManager = await connectMcpForAgent(task.agent);
      }
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

export function ensureReloadWatches(): void {
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
