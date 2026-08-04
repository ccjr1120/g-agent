import type { ConversationMessage } from "@g-agent/agent";

export function estimateConversationTokens(
  systemPrompt: string,
  history: ConversationMessage[],
  estimateTextTokens: (text: string | null | undefined) => number,
  pendingPrompt?: string,
): number {
  const systemTokens = estimateTextTokens(systemPrompt) + 4;
  const historyTokens = history.reduce((total, message) => {
    return total + estimateTextTokens(message.content) + 4;
  }, 0);
  const pendingTokens = pendingPrompt
    ? estimateTextTokens(pendingPrompt) + 4
    : 0;
  return systemTokens + historyTokens + pendingTokens;
}

/**
 * Drop oldest history until it fits the context window. Priority: assistant
 * replies are trimmed before user messages, and the first user message (the
 * task) plus the most recent message are always preserved. Returns the new
 * history and how many messages were dropped.
 */
export function trimHistory(
  maxTokens: number,
  systemPrompt: string,
  history: ConversationMessage[],
  estimateTextTokens: (text: string | null | undefined) => number,
  pendingPrompt?: string,
): { history: ConversationMessage[]; dropped: number } {
  const result = [...history];
  const over = () =>
    estimateConversationTokens(
      systemPrompt,
      result,
      estimateTextTokens,
      pendingPrompt,
    ) > maxTokens;
  let dropped = 0;

  while (result.length > 2 && over()) {
    const index = findDropIndex(result, "assistant");
    if (index === -1) {
      break;
    }
    result.splice(index, 1);
    dropped += 1;
  }
  while (result.length > 2 && over()) {
    const index = findDropIndex(result, "user");
    if (index === -1) {
      break;
    }
    result.splice(index, 1);
    dropped += 1;
  }
  return { history: result, dropped };
}

/** Oldest message of `role` that is not the first or last message. */
function findDropIndex(
  history: ConversationMessage[],
  role: ConversationMessage["role"],
): number {
  for (let i = 1; i < history.length - 1; i++) {
    if (history[i]?.role === role) {
      return i;
    }
  }
  return -1;
}
