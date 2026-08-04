import type { ServerWebSocket } from "bun";
import { runAgent } from "@g-agent/agent";
import {
  send,
  type WsData,
} from "./state.js";
import { scheduleManager } from "./scheduled-runtime.js";
import {
  sendContextUsage,
  sendNotice,
  trimHistoryForPrompt,
  truncateError,
} from "./usage.js";

export async function runPrompt(ws: ServerWebSocket<WsData>, prompt: string): Promise<void> {
  const dropped = trimHistoryForPrompt(ws, prompt);
  if (dropped > 0) {
    sendNotice(
      ws,
      `Context window reached — dropped ${dropped} oldest message${dropped === 1 ? "" : "s"} to fit`,
    );
  }
  sendContextUsage(ws, prompt);
  const isVisible = () => ws.data.activeAgentTaskSlot === undefined;
  if (isVisible()) send(ws, { type: "start" });

  let assistantText = "";
  let failed = false;
  const abortController = new AbortController();
  ws.data.abortController = abortController;

  try {
    await runAgent(
      prompt,
      (event) => {
      if (event.type === "system_prompt") {
        if (isVisible()) send(ws, { type: "system_prompt", text: event.text });
        return;
      }

      if (event.type === "thinking_delta") {
        if (isVisible()) send(ws, { type: "thinkingDelta", text: event.text });
        return;
      }

      if (event.type === "delta") {
        assistantText += event.text;
        if (isVisible()) send(ws, { type: "delta", text: event.text });
        return;
      }

      if (event.type === "tool_call") {
        if (isVisible()) {
          send(ws, {
            type: "tool_call",
            name: event.name,
            args: event.args,
          });
        }
        return;
      }

      if (event.type === "tool_result") {
        if (isVisible()) {
          send(ws, {
            type: "tool_result",
            name: event.name,
            output: event.output,
          });
        }
        return;
      }

      if (event.type === "error") {
        failed = true;
        // Keep the failed turn in history so a follow-up "continue" still has
        // context, and tell the model the previous attempt failed instead of
        // silently starting over.
        ws.data.history.push({ role: "user", content: prompt });
        ws.data.history.push({
          role: "assistant",
          content: `[Previous attempt failed: ${truncateError(event.message)}]`,
        });
        sendContextUsage(ws);
        if (isVisible()) send(ws, { type: "error", message: event.message });
        return;
      }

      if (event.type === "cancelled") {
        failed = true;
        ws.data.cancelRequested = false;
        sendContextUsage(ws);
        if (isVisible()) send(ws, { type: "done" });
        return;
      }

      if (!failed) {
        if (!ws.data.cancelRequested) {
          ws.data.history.push({ role: "user", content: prompt });
          if (assistantText.trim()) {
            ws.data.history.push({ role: "assistant", content: assistantText });
          }
        } else {
          ws.data.cancelRequested = false;
        }
      }
      sendContextUsage(ws);
      if (isVisible()) send(ws, { type: "done" });
      },
      ws.data.effectiveProvider,
      ws.data.systemPrompt,
      ws.data.history,
      {
        mcpManager: ws.data.mcpManager,
        scheduleManager,
        signal: abortController.signal,
      },
    );
  } finally {
    if (ws.data.abortController === abortController) {
      ws.data.abortController = undefined;
    }
  }
}

export async function drainPromptQueue(ws: ServerWebSocket<WsData>): Promise<void> {
  if (ws.data.draining) {
    return;
  }

  ws.data.draining = true;

  try {
    while (ws.data.promptQueue.length > 0) {
      const prompt = ws.data.promptQueue.shift();
      if (!prompt) {
        continue;
      }
      await runPrompt(ws, prompt);
      if (ws.data.cancelRequested) {
        ws.data.cancelRequested = false;
        ws.data.promptQueue.length = 0;
        break;
      }
    }
  } finally {
    ws.data.draining = false;
  }
}
