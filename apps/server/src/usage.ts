import type { ServerWebSocket } from "bun";
import { encode } from "gpt-tokenizer";
import type { ResolvedProvider } from "@g-agent/config";
import { estimateConversationTokens, trimHistory } from "./context.js";
import { send, type WsData } from "./state.js";

export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) {
    return 0;
  }
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/** Cap LLM error text stored into conversation history so it never bloats context. */
export function truncateError(message: string, max = 200): string {
  const text = message.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function getContextWindow(provider: ResolvedProvider | null): number | undefined {
  return provider?.contextWindow;
}

export function contextUsage(
  ws: ServerWebSocket<WsData>,
  pendingPrompt?: string,
): { usedTokens: number; maxTokens: number; percent: number } {
  const maxTokens = getContextWindow(ws.data.effectiveProvider);
  const usedTokens = estimateConversationTokens(
    ws.data.systemPrompt,
    ws.data.history,
    estimateTextTokens,
    pendingPrompt,
  );
  if (!maxTokens) {
    return { usedTokens, maxTokens: 0, percent: 0 };
  }
  return {
    usedTokens,
    maxTokens,
    percent: Math.min(100, Math.round((usedTokens / maxTokens) * 100)),
  };
}

export function sendContextUsage(
  ws: ServerWebSocket<WsData>,
  pendingPrompt?: string,
): void {
  send(ws, { type: "context", ...contextUsage(ws, pendingPrompt) });
}

/**
 * Drop oldest history until it fits the context window (priority-aware). Notifies
 * the user when messages had to be dropped.
 */
export function trimHistoryForPrompt(
  ws: ServerWebSocket<WsData>,
  prompt: string,
): number {
  const maxTokens = getContextWindow(ws.data.effectiveProvider);
  if (!maxTokens) {
    return 0;
  }
  const { history, dropped } = trimHistory(
    maxTokens,
    ws.data.systemPrompt,
    ws.data.history,
    estimateTextTokens,
    prompt,
  );
  ws.data.history = history;
  return dropped;
}

export function sendNotice(ws: ServerWebSocket<WsData>, message: string): void {
  send(ws, { type: "notice", message });
}
