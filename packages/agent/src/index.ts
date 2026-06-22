export type AgentStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type ResolvedProvider = {
  name: string;
  baseUrl: string;
  model: string;
  modelName?: string;
  apiKey: string;
};

export async function runAgent(
  prompt: string,
  onEvent: (event: AgentStreamEvent) => void,
  provider?: ResolvedProvider | null,
): Promise<void> {
  const resolved = provider ?? resolveProviderFromEnv();

  try {
    if (resolved) {
      await streamOpenAI(prompt, onEvent, resolved);
    } else {
      await streamEcho(prompt, onEvent);
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
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const reply =
    "[echo mode — add providers in config.json or set OPENAI_API_KEY]\n" +
    `You said: ${prompt}`;
  for (const char of reply) {
    onEvent({ type: "delta", text: char });
    await sleep(12);
  }
}

async function streamOpenAI(
  prompt: string,
  onEvent: (event: AgentStreamEvent) => void,
  provider: ResolvedProvider,
): Promise<void> {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: provider.modelName ?? provider.model,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${body}`);
  }

  if (!response.body) {
    throw new Error("LLM response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;

      const chunk = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string } }>;
      };
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        onEvent({ type: "delta", text });
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
