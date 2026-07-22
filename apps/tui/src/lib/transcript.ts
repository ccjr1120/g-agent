import type { ChatLine } from "../hooks/useAgentSocket.js";

/** Plain text of the most recent assistant reply, if any. */
export function lastAssistantText(
  staticLines: ChatLine[],
  streamingLine: ChatLine | null,
): string | null {
  if (streamingLine?.role === "assistant") {
    const text = streamingLine.text.trim();
    if (text) {
      return streamingLine.text;
    }
  }

  for (let index = staticLines.length - 1; index >= 0; index -= 1) {
    const line = staticLines[index];
    if (line?.role === "assistant") {
      const text = line.text.trim();
      if (text) {
        return line.text;
      }
    }
  }

  return null;
}
