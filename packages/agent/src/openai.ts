import type { ResolvedProvider } from "@g-agent/config";
import { builtinTools, executeTool, toOpenAITools } from "./tools/index.js";
import type { McpManager } from "./mcp/index.js";
import type { ScheduledTaskManager } from "./schedules/index.js";
import type {
  AgentRunOptions,
  AgentStreamEvent,
  ChatMessage,
  ConversationMessage,
  ToolCallMessage,
} from "./types.js";
import {
  fetchWithRetry,
  positiveEnvNumber,
} from "./http.js";
import { DEFAULT_MAX_TOOL_ROUNDS } from "./types.js";
import { readCompletion } from "./stream.js";

export const TOOL_EFFICIENCY_PROMPT = `## Tool efficiency

Use tools economically. Batch related reads and queries, request independent tool calls in the same response, and prefer one well-scoped shell command over many tiny shell calls. For research, gather a broad candidate set in bulk, shortlist it, then inspect only the strongest candidates in depth. Stop gathering evidence once you can answer reliably.`;

export async function runOpenAI(
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
    const response = await fetchWithRetryOpenAI(
      provider,
      model,
      messages,
      tools,
      mustAnswer,
      options.signal,
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body}`);
    }

    // Emits thinking_delta / delta as tokens arrive.
    const result = await readCompletion(response, onEvent);

    if (result.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: result.text.trim() || null,
        tool_calls: result.toolCalls,
      });

      for (const call of result.toolCalls) {
        const name = call.function.name;
        const argsText = call.function.arguments;
        onEvent({ type: "tool_call", name, args: argsText });
      }

      const results = await Promise.all(result.toolCalls.map(async (call) => {
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

        const output = await executeNamedTool(
          name,
          args,
          options.mcpManager,
          options.scheduleManager,
        );
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

    return;
  }

  throw new Error(`Unable to produce an answer after ${maxToolRounds} rounds`);
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

async function fetchWithRetryOpenAI(
  provider: ResolvedProvider,
  model: string,
  messages: ChatMessage[],
  tools: ReturnType<typeof toOpenAITools>,
  mustAnswer: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchWithRetry(
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
        stream: true,
        messages,
        ...(mustAnswer ? {} : { tools, tool_choice: "auto" }),
      }),
    },
    signal,
  );
}

export async function executeNamedTool(
  name: string,
  args: Record<string, unknown>,
  mcpManager?: McpManager | null,
  scheduleManager?: ScheduledTaskManager | null,
): Promise<string> {
  if (mcpManager?.hasTool(name)) {
    return mcpManager.callTool(name, args);
  }
  return executeTool(name, args, scheduleManager);
}

export type { ChatMessage, ToolCallMessage };
