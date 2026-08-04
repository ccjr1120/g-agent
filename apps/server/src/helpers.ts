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
import { config } from "./state.js";

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

export type { McpServerConfig };
