import type { ClientMessage, ConversationTurn, McpServerCatalogEntry, ScheduledTaskInfo } from "@g-agent/shared";
import { writeConversationLog } from "../export.js";
import { formatSessionLabel, listSessions, loadSession } from "../sessions.js";
import { formatMcpServerDetail } from "./mcp-format.js";
import { formatHelp, resolveScheduledTask } from "./menu.js";

export type DispatchContext = {
  text: string;
  activeSlot: number | undefined;
  turnBusy: boolean;
  activeAgent: string;
  agents: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description: string }>;
  mcp: McpServerCatalogEntry[];
  scheduledTasks: ScheduledTaskInfo[];
  transcriptLines: Array<{ role: string; text: string }>;
};

export type DispatchAction =
  | { type: "noop" }
  | { type: "quit" }
  | { type: "close_sub"; slot: number }
  | { type: "chat"; message: string }
  | { type: "send"; message: ClientMessage }
  | { type: "reset" }
  | { type: "local"; text: string }
  | { type: "status"; text: string }
  | { type: "error"; text: string }
  | { type: "complete"; text: string }
  | { type: "open_task"; slot: number; deferred?: boolean }
  | { type: "resume"; agent: string; history: ConversationTurn[] };

export function dispatchActions(ctx: DispatchContext): DispatchAction[] {
  const text = ctx.text.trim();
  if (!text) return [];

  if (text === "exit") {
    if (ctx.activeSlot !== undefined) {
      return [
        { type: "close_sub", slot: ctx.activeSlot },
        { type: "status", text: "Closed current agent session — back to the main session" },
      ];
    }
    return [{ type: "quit" }];
  }
  if (text === "/quit" || text === "/exit") return [{ type: "quit" }];
  if (text === "/chat-other") return [];

  if (text === "/help") {
    return [
      {
        type: "local",
        text: formatHelp(ctx.skills.length),
      },
    ];
  }

  if (text === "/reload") {
    return [
      { type: "send", message: { type: "reload" } },
      { type: "status", text: "Reloading config, agents and skills…" },
    ];
  }

  if (text === "/new" || text === "/reset" || text === "/clear") return [{ type: "reset" }];

  if (text === "/skills") {
    if (ctx.skills.length === 0) return [{ type: "local", text: "No skills loaded." }];
    return [{ type: "complete", text: `/skill ${ctx.skills[0].name}` }];
  }

  if (text === "/mcp") return [{ type: "send", message: { type: "mcp" } }];

  if (text.startsWith("/mcp auth ")) {
    const name = text.slice("/mcp auth ".length).trim();
    if (!name) return [{ type: "local", text: "Usage: /mcp auth <server-name>" }];
    return [
      { type: "send", message: { type: "mcp_auth", name } },
      {
        type: "local",
        text: `Starting OAuth for MCP server "${name}"... Complete sign-in in your browser.`,
      },
    ];
  }

  if (text.startsWith("/mcp ")) {
    const name = text.slice("/mcp ".length).trim();
    const server = ctx.mcp.find((s) => s.name === name);
    if (!server) return [{ type: "local", text: `MCP server not found: ${name}` }];
    return [{ type: "local", text: formatMcpServerDetail(server) }];
  }

  if (text.startsWith("/agent ")) {
    const args = text.slice("/agent ".length).trim();
    const space = args.indexOf(" ");
    const name = space === -1 ? args : args.slice(0, space);
    const message = space === -1 ? undefined : args.slice(space + 1).trim() || undefined;
    if (!name) return [{ type: "complete", text: "/agent " }];
    if (!message) return [{ type: "complete", text: `/agent ${name} ` }];
    return [
      { type: "send", message: { type: "agent", name, message } },
      { type: "status", text: `Started ${name} in the background` },
    ];
  }

  if (text.startsWith("/skill ")) {
    const name = text.slice("/skill ".length).trim();
    if (!name) return [{ type: "local", text: "Usage: /skill <name>" }];
    return [{ type: "send", message: { type: "skill", name } }];
  }

  if (text === "/log" || text === "/export") {
    try {
      const path = writeConversationLog(ctx.transcriptLines);
      return [{ type: "local", text: `Log saved to: ${path}` }];
    } catch (error) {
      return [{ type: "error", text: error instanceof Error ? error.message : String(error) }];
    }
  }

  if (text === "/resume all") {
    const saved = listSessions();
    if (saved.length === 0) return [{ type: "local", text: "No saved sessions." }];
    return [{ type: "local", text: saved.map(formatSessionLabel).join("\n") }];
  }

  if (text === "/resume") {
    const saved = listSessions();
    if (saved.length === 0) return [{ type: "local", text: "No saved sessions." }];
    return [{ type: "complete", text: `/resume ${saved[0].id}` }];
  }

  if (text.startsWith("/resume ")) {
    const id = text.slice("/resume ".length).trim();
    const session = loadSession(id);
    if (!session) return [{ type: "local", text: `Session not found: ${id}` }];
    return [{ type: "send", message: { type: "resume", agent: session.agent, history: session.history } }];
  }

  if (text === "/tasks") return [{ type: "send", message: { type: "agent_tasks" } }];
  if (text === "/scheduled") return [{ type: "send", message: { type: "scheduled_tasks" } }];

  const scheduled = matchScheduled(ctx, text);
  if (scheduled) return scheduled;

  if (text === "/back" || text === "/0") {
    return [{ type: "send", message: { type: "agent_back" } }];
  }

  const slotMatch = text.match(/^\/(\d+)$/);
  if (slotMatch) {
    const slot = Number.parseInt(slotMatch[1], 10);
    if (ctx.activeSlot === undefined && ctx.turnBusy) {
      return [
        { type: "open_task", slot, deferred: true },
        {
          type: "local",
          text: "Main agent is still responding; the sub-session will open automatically when it finishes.",
        },
      ];
    }
    return [{ type: "open_task", slot }];
  }

  const skillName = text.startsWith("/") ? text.slice(1) : "";
  if (skillName && ctx.skills.some((s) => s.name === skillName)) {
    return [{ type: "send", message: { type: "skill", name: skillName } }];
  }

  return [{ type: "chat", message: text }];
}

function matchScheduled(ctx: DispatchContext, text: string): DispatchAction[] | null {
  for (const [prefix, kind] of [
    ["/scheduled cancel ", "cancel"],
    ["/scheduled run ", "run"],
    ["/scheduled history ", "history"],
  ] as const) {
    if (!text.startsWith(prefix)) continue;
    const trimmed = text.slice(prefix.length).trim();
    if (!trimmed) return [{ type: "local", text: `Usage: /scheduled ${kind} <number|id>` }];
    const resolved = resolveScheduledTask(ctx.scheduledTasks, trimmed);
    if (!resolved) return [{ type: "local", text: `Scheduled task not found: ${trimmed}` }];
    const message: ClientMessage =
      kind === "cancel"
        ? { type: "scheduled_task_cancel", id: resolved.id }
        : kind === "run"
          ? { type: "scheduled_task_run", id: resolved.id }
          : { type: "scheduled_task_history", id: resolved.id };
    const status =
      kind === "cancel"
        ? `Cancelling scheduled task "${resolved.label}"`
        : kind === "run"
          ? `Running scheduled task "${resolved.label}" now`
          : `Fetching history for "${resolved.label}"…`;
    return [{ type: "send", message }, { type: "local", text: status }];
  }
  return null;
}
