import type { AgentTaskInfo, McpServerCatalogEntry, ScheduledTaskInfo } from "@g-agent/shared";
import type { SavedSessionSummary } from "../sessions.js";
import { formatSessionAge } from "../sessions.js";

export type SlashCommand = {
  value: string;
  label: string;
  description: string;
  chatOther?: boolean;
};

export type MenuContext = {
  agents: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description: string }>;
  mcp: McpServerCatalogEntry[];
  agentTasks: AgentTaskInfo[];
  savedSessions: SavedSessionSummary[];
  activeAgent: string;
};

const BASE_COMMANDS: SlashCommand[] = [
  { value: "/skills", label: "/skills", description: "Select and run a skill" },
  { value: "/back", label: "/back", description: "Return to the main session (⌘0 / Alt+0 / /0)" },
  { value: "/resume", label: "/resume", description: "Select and resume a saved session" },
  { value: "/mcp", label: "/mcp", description: "Select an MCP server and view its tools" },
  { value: "/tasks", label: "/tasks", description: "Show background agent tasks" },
  { value: "/scheduled", label: "/scheduled", description: "Show recurring scheduled tasks" },
  { value: "/new", label: "/new", description: "Start a new conversation" },
  { value: "/reload", label: "/reload", description: "Hot-reload config, agents and skills" },
  { value: "/log", label: "/log", description: "Export the full conversation log" },
  { value: "/help", label: "/help", description: "Show commands and keyboard shortcuts" },
  { value: "/quit", label: "/quit", description: "Exit g-agent" },
];

function filterByPrefix(items: SlashCommand[], partial: string): SlashCommand[] {
  const query = partial.toLowerCase();
  return items.filter((item) => item.value.toLowerCase().includes(query));
}

export const CHAT_OTHER_COMMAND: SlashCommand = {
  value: "/chat-other",
  label: "Chat other…",
  description: "Type a message instead of a command",
  chatOther: true,
};

function withChatOther(items: SlashCommand[]): SlashCommand[] {
  return [...items, CHAT_OTHER_COMMAND];
}

export function buildMenuItems(text: string, ctx: MenuContext): SlashCommand[] {
  const raw = text.trim();
  if (!raw.startsWith("/")) return [];

  if (raw.startsWith("/agent ")) {
    const partial = raw.slice("/agent ".length);
    return withChatOther(
      filterByPrefix(
        ctx.agents
          .filter((a) => a.name !== "default")
          .map((a) => ({
            value: `/agent ${a.name} `,
            label: `/agent ${a.name}`,
            description: `add a message · ${a.description}`,
          })),
        partial,
      ),
    );
  }

  if (raw.startsWith("/mcp auth ")) {
    const partial = raw.slice("/mcp auth ".length);
    return withChatOther(
      filterByPrefix(
        ctx.mcp.map((s) => ({
          value: `/mcp auth ${s.name}`,
          label: `/mcp auth ${s.name}`,
          description: s.connected ? "connected" : s.authRequired ? "auth required" : "not connected",
        })),
        partial,
      ),
    );
  }

  if (raw.startsWith("/mcp ")) {
    const partial = raw.slice("/mcp ".length);
    return withChatOther(
      filterByPrefix(
        ctx.mcp.map((s) => ({
          value: `/mcp ${s.name}`,
          label: `/mcp ${s.name}`,
          description: s.connected
            ? `connected · ${s.toolCount} tools`
            : s.authRequired
              ? "auth required"
              : s.error ?? "not connected",
        })),
        partial,
      ),
    );
  }

  if (raw.startsWith("/resume ")) {
    const partial = raw.slice("/resume ".length);
    return withChatOther(
      filterByPrefix(
        ctx.savedSessions
          .filter((s) => s.agent === ctx.activeAgent)
          .map((s) => ({
            value: `/resume ${s.id}`,
            label: `/resume ${s.id}`,
            description: `${s.preview} · ${formatSessionAge(s.updatedAt)} · ${s.turnCount} msgs`,
          })),
        partial,
      ),
    );
  }

  if (raw.startsWith("/skill ")) {
    const partial = raw.slice("/skill ".length);
    return withChatOther(
      filterByPrefix(
        ctx.skills.map((s) => ({
          value: `/skill ${s.name}`,
          label: `/skill ${s.name}`,
          description: s.description,
        })),
        partial,
      ),
    );
  }

  if (raw.includes(" ")) return [];

  const query = raw.slice(1).toLowerCase();
  const items = [...BASE_COMMANDS];

  for (const task of ctx.agentTasks) {
    const title = task.title.split(/\s+/).join(" ");
    items.push({
      value: `/${task.slot}`,
      label: `/${task.slot}`,
      description: title,
    });
  }

  for (const agent of ctx.agents.filter((a) => a.name !== "default")) {
    items.push({
      value: `/agent ${agent.name} `,
      label: `/agent ${agent.name}`,
      description: `run in background · add a message · ${agent.description}`,
    });
  }

  for (const skill of ctx.skills) {
    items.push({
      value: `/${skill.name}`,
      label: `/${skill.name}`,
      description: skill.description,
    });
  }

  return withChatOther(items.filter((item) => item.value.slice(1).toLowerCase().startsWith(query)));
}

export function formatHelp(skillCount: number): string {
  const lines = ["Commands:"];
  for (const command of BASE_COMMANDS) {
    lines.push(`  ${command.label.padEnd(12)} ${command.description}`);
  }
  lines.push(`  /<skill>     Run a skill directly (${skillCount} loaded)`);
  lines.push("  /scheduled cancel <number|id>  Cancel a scheduled task");
  lines.push("  /scheduled run <number|id>  Run a scheduled task now");
  lines.push("  /scheduled history <number|id>  Show past runs of a scheduled task");
  lines.push("");
  lines.push("Keys:");
  lines.push("  Enter send · Shift+Enter newline · Tab complete command");
  lines.push("  ↑/↓ recall previous prompts · menu when open");
  lines.push("  PageUp/PageDown scroll conversation");
  lines.push("  Ctrl+C cancel the running/queued turn · Esc undo last send / cancel");
  lines.push("  Ctrl+T expand or collapse long thinking blocks");
  lines.push("  Tab cycles focus through panels (↑↓/PgUp/PgDn scroll, Esc returns)");
  lines.push("  While an Ask question is pending: ↑/↓ pick option · Enter answer · Chat other… custom reply · Esc skip");
  lines.push("  Every selection menu offers a Chat other… fallback for typing your own input");
  lines.push("  Cmd+0 or Alt+0 return to the main agent");
  lines.push("  exit — quit TUI (main) or close sub-session (sub)");
  return lines.join("\n");
}

export function resolveScheduledTask(
  tasks: ScheduledTaskInfo[],
  arg: string,
): { id: string; label: string } | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  const index = Number.parseInt(trimmed, 10);
  if (Number.isInteger(index) && index >= 1 && index <= tasks.length) {
    const task = tasks[index - 1];
    return { id: task.id, label: task.label };
  }
  const task = tasks.find((t) => t.id === trimmed || t.id.startsWith(trimmed));
  return task ? { id: task.id, label: task.label } : null;
}
