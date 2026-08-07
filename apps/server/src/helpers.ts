import type { ServerWebSocket } from "bun";
import {
  getActiveProvider,
  mergeAgentMcpServers,
  mergeAgentProviderOverrides,
  type GAgentConfig,
  type ResolvedProvider,
} from "@g-agent/config";
import type { McpServerConfig } from "@g-agent/config";
import {
  McpManager,
  type AgentConfig,
  type Skill,
} from "@g-agent/agent";
import { config, send, type WsData } from "./state.js";

export function resolveProvider(
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

export function mergedMcpServers(
  agent: AgentConfig,
  runtimeConfig: GAgentConfig = config,
) {
  return mergeAgentMcpServers(runtimeConfig, { mcpServers: agent.mcpServers });
}

export async function connectMcpForAgent(
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

/**
 * Build the prompt that injects a skill's SKILL.md body into a conversation
 * turn, so the model follows the skill's instructions on demand. `body` is
 * already loaded and `{{skill_dir}}`-templated by `loadSkillsFromDir`.
 */
export function buildSkillPrompt(skill: Skill): string {
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

/**
 * Create an `askUser` handler for a connection. Sends the question to the
 * client as an `ask_user` event (with a per-question `id` and discrete
 * `options` when provided) and resolves when the matching `ask_user_reply`
 * arrives. Rejects (and removes its slot) if the connection drops or the turn
 * is aborted, so an in-flight ask never hangs a turn forever.
 *
 * Every question gets its own id and stays answerable until explicitly
 * replied to, so a model that emits several `ask_user` calls in one round (a
 * concurrent `Promise.all` tool round) can be answered question by question
 * instead of the later calls rejecting the earlier ones.
 */
export function makeAskUserHandler(
  ws: ServerWebSocket<WsData>,
  signal?: AbortSignal,
): (question: string, options?: string[]) => Promise<string> {
  return (question, options) =>
    new Promise<string>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      const id = crypto.randomUUID();
      ws.data.pendingAsks ??= new Map();
      ws.data.pendingAsks.set(id, { resolve, reject });
      send(ws, {
        type: "ask_user",
        id,
        question,
        ...(options && options.length > 0 ? { options } : {}),
      });
      const onAbort = () => {
        if (ws.data.pendingAsks?.delete(id)) {
          reject(new Error("cancelled"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export type { McpServerConfig };
