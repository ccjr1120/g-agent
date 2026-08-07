import type { ConversationTurn } from "@g-agent/shared";

/** A single display unit inside an assistant turn. Order matters — this is
 *  the single source of display order (thinking → text → tools). */
export type TurnSegment =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; args: string; status: "running" | "ok" | "error"; output?: string; durationMs?: number }
  | { type: "ask"; id: string; question: string; options?: string[] }
  | { type: "reply"; text: string };

export type ChatLineRole = "user" | "assistant" | "error" | "status" | "local" | "ask";

export type ChatLine = {
  id: string;
  role: ChatLineRole;
  /** Accumulated body, used for persistence. Never drives display order. */
  text: string;
  sentContent?: string;
  segments: TurnSegment[];
  pendingThinking: string;
  pendingText: string;
  durationMs?: number;
  queued: boolean;
  /** When set, this line belongs to a sub-agent slot. */
  slot?: number;
};

let counter = 0;
export function newLineId(): string {
  return `line-${Date.now()}-${counter++}`;
}

/** Convert a committed ChatLine back into a persistent ConversationTurn. */
export function lineToTurn(line: ChatLine): ConversationTurn {
  if (line.role === "user") {
    return {
      role: "user",
      content: line.sentContent ?? line.text,
      thinking: undefined,
      tools: undefined,
      durationMs: undefined,
    };
  }
  const thinking = line.segments
    .filter((s): s is Extract<TurnSegment, { type: "thinking" }> => s.type === "thinking")
    .map((s) => s.text)
    .join("\n");
  const tools = line.segments
    .filter((s): s is Extract<TurnSegment, { type: "tool" }> => s.type === "tool")
    .map((s) => ({ name: s.name, args: s.args }));
  return {
    role: "assistant",
    content: line.text,
    thinking: thinking || undefined,
    tools: tools.length ? tools : undefined,
    durationMs: line.durationMs,
  };
}

export type PlanStepState = "done" | "running" | "pending" | "failed";

export type PlanDisplay = {
  title: string;
  steps: Array<{ description: string; state: PlanStepState }>;
};

/** Server-side catalog snapshots that the transcript needs to stay fresh. */
export type CatalogState = {
  agents: Array<{ name: string; description: string; active: boolean }>;
  skills: Array<{ name: string; description: string; source: string }>;
  activeAgent: string;
  model: string;
};