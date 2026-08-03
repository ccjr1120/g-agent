import type { ResolvedProvider } from "@g-agent/config";
import {
  builtinTools,
  executeTool,
  toOpenAITools,
} from "./tools/index.js";
import { McpManager } from "./mcp/index.js";

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
export type { ResolvedProvider } from "@g-agent/config";

export type AgentRunOptions = {
  mcpManager?: McpManager | null;
  /** Cancels an in-flight model request. */
  signal?: AbortSignal;
};

export type AgentStreamEvent =
  | { type: "system_prompt"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; output: string }
  | { type: "cancelled" }
  | { type: "done" }
  | { type: "error"; message: string };

type ToolCallMessage = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCallMessage[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

const DEFAULT_MAX_TOOL_ROUNDS = 25;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export type ConversationMessage = Extract<
  ChatMessage,
  { role: "user" | "assistant" }
>;

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

function buildInitialMessages(
  prompt: string,
  systemPrompt: string,
  history: ConversationMessage[],
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [systemPrompt, TOOL_EFFICIENCY_PROMPT].filter(Boolean).join("\n\n"),
    },
    ...history,
    { role: "user", content: prompt },
  ];
}

const TOOL_EFFICIENCY_PROMPT = `## Tool efficiency

Use tools economically. Batch related reads and queries, request independent tool calls in the same response, and prefer one well-scoped shell command over many tiny shell calls. For research, gather a broad candidate set in bulk, shortlist it, then inspect only the strongest candidates in depth. Stop gathering evidence once you can answer reliably.`;

async function runOpenAI(
  provider: ResolvedProvider,
  prompt: string,
  systemPrompt: string,
  onEvent: (event: AgentStreamEvent) => void,
  history: ConversationMessage[],
  options: AgentRunOptions,
): Promise<void> {
  const messages = buildInitialMessages(prompt, systemPrompt, history);
  if (systemPrompt) {
    onEvent({ type: "system_prompt", text: systemPrompt });
  }
  const mcpTools = options.mcpManager?.getTools() ?? [];
  const tools = toOpenAITools([...builtinTools, ...mcpTools]);
  const model = provider.modelName ?? provider.model;
  const maxToolRounds = positiveEnvNumber(
    "G_AGENT_MAX_TOOL_ROUNDS",
    DEFAULT_MAX_TOOL_ROUNDS,
  );

  for (let round = 0; round < maxToolRounds; round++) {
    const mustAnswer = round === maxToolRounds - 1;
    if (mustAnswer) {
      messages.push({
        role: "system",
        content:
          "The tool-call budget is exhausted. Do not call tools. Give the best complete answer now using the evidence already collected, and briefly note any material uncertainty.",
      });
    }
    const response = await fetchWithRetry(
      `${provider.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...provider.requestBody,
          model,
          stream: false,
          messages,
          ...(mustAnswer ? {} : { tools, tool_choice: "auto" }),
        }),
      },
      options.signal,
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: ToolCallMessage[];
        };
      }>;
    };

    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error("LLM response has no message");
    }

    const taggedContent = splitThinkTaggedContent(message.content ?? "");
    const reasoning = [message.reasoning_content, taggedContent.thinking]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    if (reasoning) {
      await streamText(reasoning, onEvent, "thinking_delta");
    }

    if (message.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      });

      for (const call of message.tool_calls) {
        const name = call.function.name;
        const argsText = call.function.arguments;
        onEvent({ type: "tool_call", name, args: argsText });
      }

      const results = await Promise.all(message.tool_calls.map(async (call) => {
        const name = call.function.name;
        const argsText = call.function.arguments;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsText) as Record<string, unknown>;
        } catch {
          return {
            call,
            name,
            output: "Error: tool arguments must be valid JSON",
          };
        }

        const output = await executeNamedTool(name, args, options.mcpManager);
        return { call, name, output };
      }));

      // Preserve the provider's tool-call order in conversation history even
      // though independent calls execute concurrently.
      for (const { call, name, output } of results) {
        onEvent({ type: "tool_result", name, output });
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }

      continue;
    }

    const text = taggedContent.text.trim();
    if (text) {
      await streamText(text, onEvent, "delta");
    }
    return;
  }

  throw new Error(`Unable to produce an answer after ${maxToolRounds} rounds`);
}

/**
 * Some OpenAI-compatible providers return reasoning inside ordinary content
 * using <think>...</think> instead of the reasoning_content field. Separate
 * those blocks so the TUI can render them in its dedicated thinking area.
 */
function splitThinkTaggedContent(content: string): {
  thinking: string;
  text: string;
} {
  if (!/<think>/i.test(content)) {
    return { thinking: "", text: content };
  }

  const thinking: string[] = [];
  let text = "";
  let cursor = 0;
  const block = /<think>([\s\S]*?)<\/think>/gi;
  for (const match of content.matchAll(block)) {
    const index = match.index ?? 0;
    text += content.slice(cursor, index);
    thinking.push(match[1]);
    cursor = index + match[0].length;
  }

  // A provider may omit the closing tag on a truncated response. Treat the
  // remaining content as thinking instead of leaking the raw tag to chat.
  const remainder = content.slice(cursor);
  const unclosed = remainder.match(/<think>([\s\S]*)$/i);
  if (unclosed && unclosed.index !== undefined) {
    text += remainder.slice(0, unclosed.index);
    thinking.push(unclosed[1]);
  } else {
    text += remainder;
  }

  return {
    thinking: thinking.map((value) => value.trim()).filter(Boolean).join("\n\n"),
    text,
  };
}

async function executeNamedTool(
  name: string,
  args: Record<string, unknown>,
  mcpManager?: McpManager | null,
): Promise<string> {
  if (mcpManager?.hasTool(name)) {
    return mcpManager.callTool(name, args);
  }
  return executeTool(name, args);
}

async function streamText(
  text: string,
  onEvent: (event: AgentStreamEvent) => void,
  eventType: "delta" | "thinking_delta" = "delta",
): Promise<void> {
  onEvent({ type: eventType, text });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const timeoutMs = positiveEnvNumber(
    "G_AGENT_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const maxRetries = positiveEnvNumber(
    "G_AGENT_MAX_RETRIES",
    DEFAULT_MAX_RETRIES,
    true,
  );

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;

    try {
      const response = await fetch(url, { ...init, signal: requestSignal });
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= maxRetries) {
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (signal?.aborted || attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }
    }

    await abortableDelay(Math.min(250 * 2 ** attempt, 2_000), signal);
  }
}

function positiveEnvNumber(
  name: string,
  fallback: number,
  allowZero = false,
): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)
    ? Math.floor(value)
    : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isRetryableError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
