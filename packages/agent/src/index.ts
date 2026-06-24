import {
  buildSystemPrompt,
  loadPrompts,
  type LoadedPrompts,
} from "./prompts/index.js";
import { type LoadedSkills } from "./skills/index.js";
import {
  builtinTools,
  executeTool,
  toOpenAITools,
} from "./tools/index.js";

export {
  buildSystemPrompt,
  getPrompt,
  loadPrompts,
  resolveBuiltinPromptsDir,
  resolvePromptsDir,
  type LoadedPrompts,
  type Prompt,
} from "./prompts/index.js";
export {
  getBannerLines,
  loadBanner,
  resolveBannersDir,
  resolveBuiltinBannersDir,
  type LoadedBanner,
} from "./banners/index.js";
export {
  loadSkills,
  resolveSkillsDir,
  type LoadedSkills,
  type Skill,
} from "./skills/index.js";
export { builtinTools, type ToolDefinition } from "./tools/index.js";

export type AgentStreamEvent =
  | { type: "system_prompt"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; output: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type ResolvedProvider = {
  name: string;
  baseUrl: string;
  model: string;
  modelName?: string;
  apiKey: string;
};

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

const MAX_TOOL_ROUNDS = 25;

export async function runAgent(
  prompt: string,
  onEvent: (event: AgentStreamEvent) => void,
  provider?: ResolvedProvider | null,
  loadedSkills: LoadedSkills = { skills: [], builtinPath: "", userPath: null },
  loadedPrompts: LoadedPrompts = {
    prompts: new Map(),
    builtinPath: "",
    userPath: null,
  },
): Promise<void> {
  const resolved = provider ?? resolveProviderFromEnv();

  try {
    if (resolved) {
      await runOpenAI(resolved, prompt, loadedSkills, loadedPrompts, onEvent);
    } else {
      await streamEcho(prompt, loadedSkills, loadedPrompts, onEvent);
    }
    onEvent({ type: "done" });
  } catch (error) {
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

  return {
    name: "env",
    baseUrl: (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    ),
    model: process.env.G_AGENT_MODEL ?? "gpt-4o-mini",
    apiKey,
  };
}

async function streamEcho(
  prompt: string,
  loadedSkills: LoadedSkills,
  loadedPrompts: LoadedPrompts,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const systemPrompt = buildSessionSystemPrompt(loadedSkills, loadedPrompts);
  onEvent({ type: "system_prompt", text: systemPrompt });

  const reply =
    "[echo mode — add providers in config.json or set OPENAI_API_KEY]\n" +
    `You said: ${prompt}`;
  for (const char of reply) {
    onEvent({ type: "delta", text: char });
    await sleep(12);
  }
}

export function buildSessionSystemPrompt(
  loadedSkills: LoadedSkills,
  loadedPrompts: LoadedPrompts,
): string {
  return buildSystemPrompt(loadedSkills, loadedPrompts);
}

async function buildInitialMessages(
  prompt: string,
  loadedSkills: LoadedSkills,
  loadedPrompts: LoadedPrompts,
): Promise<ChatMessage[]> {
  const systemPrompt = buildSessionSystemPrompt(loadedSkills, loadedPrompts);
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
}

async function runOpenAI(
  provider: ResolvedProvider,
  prompt: string,
  loadedSkills: LoadedSkills,
  loadedPrompts: LoadedPrompts,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const messages = await buildInitialMessages(prompt, loadedSkills, loadedPrompts);
  const systemPrompt = messages.find((m) => m.role === "system")?.content;
  if (systemPrompt) {
    onEvent({ type: "system_prompt", text: systemPrompt });
  }
  const tools = toOpenAITools(builtinTools);
  const model = provider.modelName ?? provider.model;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages,
        tools,
        tool_choice: "auto",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: ToolCallMessage[];
        };
      }>;
    };

    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new Error("LLM response has no message");
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

        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsText) as Record<string, unknown>;
        } catch {
          const output = "Error: tool arguments must be valid JSON";
          onEvent({ type: "tool_result", name, output });
          messages.push({ role: "tool", tool_call_id: call.id, content: output });
          continue;
        }

        const output = await executeTool(name, args);
        onEvent({ type: "tool_result", name, output });
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }

      continue;
    }

    const text = message.content?.trim();
    if (text) {
      await streamText(text, onEvent);
    }
    return;
  }

  throw new Error(`Too many tool call rounds (max ${MAX_TOOL_ROUNDS})`);
}

async function streamText(
  text: string,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  for (const char of text) {
    onEvent({ type: "delta", text: char });
    await sleep(4);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
