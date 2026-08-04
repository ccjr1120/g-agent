import type { ResolvedProvider } from "@g-agent/config";
import { McpManager } from "./mcp/index.js";
import type {
  AgentRunOptions,
  AgentStreamEvent,
  ConversationMessage,
} from "./types.js";
import { isAbortError } from "./http.js";
import { runOpenAI } from "./openai.js";

export {
  buildAgentSystemPrompt,
  clearGlobalSkillsCache,
  loadAgents,
  resolveActiveAgent,
  type AgentConfig,
  type LoadedAgents,
  type ResolvedAgent,
} from "./agents/index.js";
export {
  getBannerLines,
  loadBanner,
  resolveBannersDir,
  resolveBuiltinBannersDir,
  type LoadedBanner,
} from "./banners/index.js";
export { type Skill } from "./skills/index.js";
export { McpManager, type McpConnectionResult } from "./mcp/index.js";
export { builtinTools, type ToolDefinition } from "./tools/index.js";
export type {
  ScheduledTaskEntry,
  ScheduledTaskManager,
  ScheduledTaskStatus,
} from "./schedules/index.js";
export type { ResolvedProvider } from "@g-agent/config";
export type {
  AgentRunOptions,
  AgentStreamEvent,
  ConversationMessage,
} from "./types.js";

export async function runAgent(
  prompt: string,
  onEvent: (event: AgentStreamEvent) => void,
  provider?: ResolvedProvider | null,
  systemPrompt?: string,
  history: ConversationMessage[] = [],
  options: AgentRunOptions = {},
): Promise<void> {
  const resolved = provider ?? resolveProviderFromEnv();
  const sys = systemPrompt ?? "";

  try {
    if (resolved) {
      await runOpenAI(resolved, prompt, sys, onEvent, history, options);
    } else {
      await streamEcho(prompt, sys, onEvent, history);
    }
    onEvent({ type: "done" });
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      onEvent({ type: "cancelled" });
      return;
    }
    onEvent({
      type: "error",
      message: error instanceof Error ? error.message : "Agent failed",
    });
  }
}

function resolveProviderFromEnv(): ResolvedProvider | null {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const model = process.env.G_AGENT_MODEL ?? "gpt-4o-mini";
  return {
    name: "env",
    baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    ),
    model,
    modelName: model,
    apiKey,
  };
}

async function streamEcho(
  prompt: string,
  systemPrompt: string,
  onEvent: (event: AgentStreamEvent) => void,
  history: ConversationMessage[],
): Promise<void> {
  onEvent({ type: "system_prompt", text: systemPrompt });

  const reply =
    "[echo mode — add providers in config.json or set OPENAI_API_KEY]\n" +
    (history.length > 0 ? `Context messages: ${history.length}\n` : "") +
    `You said: ${prompt}`;
  for (const char of reply) {
    onEvent({ type: "delta", text: char });
  }
}
