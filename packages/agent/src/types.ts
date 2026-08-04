import type { McpManager } from "./mcp/index.js";
import type { ScheduledTaskManager } from "./schedules/index.js";

export type AgentRunOptions = {
  mcpManager?: McpManager | null;
  /** Recurring background tasks that schedule_task/unschedule_task act on. */
  scheduleManager?: ScheduledTaskManager | null;
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

export type ToolCallMessage = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCallMessage[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ConversationMessage = Extract<
  ChatMessage,
  { role: "user" | "assistant" }
>;

export type StreamedCompletion = {
  thinking: string;
  text: string;
  toolCalls: ToolCallMessage[];
};

export const DEFAULT_MAX_TOOL_ROUNDS = 25;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;
export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
