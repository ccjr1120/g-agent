import type {
  AgentStreamEvent,
  StreamedCompletion,
  ToolCallMessage,
} from "./types.js";

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Streaming <think>…</think> splitter. Content inside a think block is emitted
 * as thinking_delta, everything else as delta. A partial tag suffix is held
 * back so tags split across SSE chunks are classified correctly.
 */
class StreamThinkSplitter {
  private mode: "text" | "thinking" = "text";
  private pending = "";
  private thinkingParts: string[] = [];
  private textParts: string[] = [];

  addReasoning(text: string): void {
    this.thinkingParts.push(text);
  }

  addContent(
    chunk: string,
    emit: (type: "thinking_delta" | "delta", text: string) => void,
  ): void {
    this.pending += chunk;
    this.processPending(emit);
  }

  private processPending(
    emit: (type: "thinking_delta" | "delta", text: string) => void,
  ): void {
    while (true) {
      if (this.mode === "thinking") {
        const close = this.pending.indexOf(THINK_CLOSE);
        if (close === -1) {
          const keep = partialTagSuffix(THINK_CLOSE, this.pending);
          const flushLen = this.pending.length - keep;
          if (flushLen > 0) {
            const flush = this.pending.slice(0, flushLen);
            this.thinkingParts.push(flush);
            emit("thinking_delta", flush);
            this.pending = this.pending.slice(flushLen);
          }
          return;
        }
        const before = this.pending.slice(0, close);
        if (before) {
          this.thinkingParts.push(before);
          emit("thinking_delta", before);
        }
        this.mode = "text";
        this.pending = this.pending.slice(close + THINK_CLOSE.length);
        continue;
      }

      const open = this.pending.indexOf(THINK_OPEN);
      if (open === -1) {
        const keep = partialTagSuffix(THINK_OPEN, this.pending);
        const flushLen = this.pending.length - keep;
        if (flushLen > 0) {
          const flush = this.pending.slice(0, flushLen);
          this.textParts.push(flush);
          emit("delta", flush);
          this.pending = this.pending.slice(flushLen);
        }
        return;
      }
      const before = this.pending.slice(0, open);
      if (before) {
        this.textParts.push(before);
        emit("delta", before);
      }
      this.mode = "thinking";
      this.pending = this.pending.slice(open + THINK_OPEN.length);
    }
  }

  finish(): { thinking: string; text: string } {
    if (this.pending) {
      if (this.mode === "thinking") {
        this.thinkingParts.push(this.pending);
      } else {
        this.textParts.push(this.pending);
      }
      this.pending = "";
    }
    return {
      thinking: this.thinkingParts.join("").trim(),
      text: this.textParts.join(""),
    };
  }
}

/** Length of the longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagSuffix(tag: string, text: string): number {
  const max = Math.min(tag.length - 1, text.length);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Read an LLM response and emit thinking_delta / delta as tokens arrive. SSE
 * streams are consumed incrementally; a plain JSON completion (providers that
 * ignore `stream: true`, and test mocks) is emitted once.
 */
export async function readCompletion(
  response: Response,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<StreamedCompletion> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const reader = response.body?.getReader();
    if (!reader) {
      return { thinking: "", text: "", toolCalls: [] };
    }
    return consumeSse(reader, onEvent);
  }

  const raw = await response.text();
  if (raw.includes("data:")) {
    return consumeSseText(raw, onEvent);
  }
  return emitSingleCompletion(raw, onEvent);
}

async function consumeSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<StreamedCompletion> {
  const decoder = new TextDecoder();
  const splitter = new StreamThinkSplitter();
  const toolCalls: ToolCallMessage[] = [];
  let buffer = "";
  const emit = (type: "thinking_delta" | "delta", text: string) => {
    onEvent({ type, text });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        return completeStreamed(splitter, toolCalls);
      }
      applySseDelta(payload, splitter, toolCalls, emit);
    }
  }

  return completeStreamed(splitter, toolCalls);
}

function applySseDelta(
  payload: string,
  splitter: StreamThinkSplitter,
  toolCalls: ToolCallMessage[],
  emit: (type: "thinking_delta" | "delta", text: string) => void,
): void {
  let parsed: {
    choices?: Array<{
      delta?: {
        reasoning_content?: string;
        content?: string;
        tool_calls?: Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return;
  }
  const delta = parsed.choices?.[0]?.delta;
  if (!delta) {
    return;
  }
  if (delta.reasoning_content) {
    splitter.addReasoning(delta.reasoning_content);
    emit("thinking_delta", delta.reasoning_content);
  }
  if (delta.content) {
    splitter.addContent(delta.content, emit);
  }
  if (delta.tool_calls?.length) {
    mergeToolCallDeltas(toolCalls, delta.tool_calls);
  }
}

function consumeSseText(
  raw: string,
  onEvent: (event: AgentStreamEvent) => void,
): StreamedCompletion {
  const splitter = new StreamThinkSplitter();
  const toolCalls: ToolCallMessage[] = [];
  const emit = (type: "thinking_delta" | "delta", text: string) => {
    onEvent({ type, text });
  };

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      break;
    }
    applySseDelta(payload, splitter, toolCalls, emit);
  }

  return completeStreamed(splitter, toolCalls);
}

function emitSingleCompletion(
  raw: string,
  onEvent: (event: AgentStreamEvent) => void,
): StreamedCompletion {
  const data = JSON.parse(raw) as {
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

  const tagged = splitThinkTaggedContent(message.content ?? "");
  const reasoning = [message.reasoning_content, tagged.thinking]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  if (reasoning) {
    onEvent({ type: "thinking_delta", text: reasoning });
  }

  const toolCalls = message.tool_calls ?? [];
  if (toolCalls.length === 0 && tagged.text.trim()) {
    onEvent({ type: "delta", text: tagged.text });
  }
  return { thinking: reasoning, text: tagged.text, toolCalls };
}

function completeStreamed(
  splitter: StreamThinkSplitter,
  toolCalls: ToolCallMessage[],
): StreamedCompletion {
  const { thinking, text } = splitter.finish();
  return { thinking, text, toolCalls: toolCalls.filter(Boolean) };
}

function mergeToolCallDeltas(
  acc: ToolCallMessage[],
  deltas: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>,
): void {
  for (const delta of deltas) {
    const index = delta.index ?? acc.length;
    let call = acc[index];
    if (!call) {
      call = { id: "", type: "function", function: { name: "", arguments: "" } };
      acc[index] = call;
    }
    if (delta.id) {
      call.id = delta.id;
    }
    if (delta.function?.name) {
      if (!call.function.name) {
        call.function.name = delta.function.name;
      } else if (!call.function.name.endsWith(delta.function.name)) {
        call.function.name += delta.function.name;
      }
    }
    if (delta.function?.arguments) {
      call.function.arguments += delta.function.arguments;
    }
  }
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
