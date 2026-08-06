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

  // The last plan reported by `update_plan`, if any. Tracks whether multi-step
  // work is still in flight so the loop does not let the model end mid-plan
  // with a plain-text "any questions?" turn that derails execution.
  let activePlan: { steps: Array<{ status: string }> } | null = null;
  let planBlocks = 0;

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

    // Emits thinking_delta / delta as tokens arrive. Text events are buffered
    // so a reply that ends up being blocked (plan still incomplete) is never
    // shown to the user — the model's mid-plan prose must not read as a
    // finished answer.
    const bufferedText: AgentStreamEvent[] = [];
    const roundOnEvent = (event: AgentStreamEvent) => {
      if (event.type === "thinking_delta" || event.type === "delta") {
        bufferedText.push(event);
      } else {
        onEvent(event);
      }
    };
    const result = await readCompletion(response, roundOnEvent);
    const flushText = () => {
      for (const event of bufferedText) {
        onEvent(event);
      }
      bufferedText.length = 0;
    };

    if (result.toolCalls.length > 0) {
      flushText();
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
          options.agentName,
          options.askUser,
        );
        return { call, name, output };
      }));

      // Preserve the provider's tool-call order in conversation history even
      // though independent calls execute concurrently.
      for (const { call, name, output } of results) {
        onEvent({ type: "tool_result", name, output });
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }

      // Track plan state from update_plan calls so a plain-text end can be
      // blocked while steps remain.
      for (const call of result.toolCalls) {
        if (call.function.name !== "update_plan") {
          continue;
        }
        try {
          const args = JSON.parse(call.function.arguments) as {
            steps?: Array<{ status?: string }>;
          };
          if (Array.isArray(args.steps) && args.steps.length > 0) {
            activePlan = { steps: args.steps };
            planBlocks = 0;
          }
        } catch {
          // Malformed args are already reported as a tool error; skip tracking.
        }
      }

      continue;
    }

    // A plain-text reply. If a plan is still unfinished, do not let the model
    // end with prose that asks the user or summarises mid-way — nudge it back
    // into executing, but yield to the final answer round so a blocked task
    // still terminates.
    const planIncomplete =
      activePlan !== null &&
      activePlan.steps.some((step) => step.status !== "completed");
    if (planIncomplete && !mustAnswer && planBlocks < 2) {
      planBlocks += 1;
      messages.push({
        role: "system",
        content:
          "Your plan still has unfinished steps. Do not end the turn or ask the user to continue — keep executing. If a step is blocked or needs user input, call `ask_user` to resolve it, then continue. Update the plan as you make progress.",
      });
      continue;
    }

    flushText();
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
  agentName?: string,
  askUser?: (question: string) => Promise<string>,
): Promise<string> {
  if (mcpManager?.hasTool(name)) {
    return mcpManager.callTool(name, args);
  }
  return executeTool(name, args, scheduleManager, agentName, askUser);
}

export type { ChatMessage, ToolCallMessage };
