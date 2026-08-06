import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentConfig, ConversationMessage, LoadedAgents } from "@g-agent/agent";
import type { AgentTaskStatus } from "@g-agent/shared";
import type { BackgroundAgentTask } from "./state.js";

const BUSY_STATUSES = new Set<AgentTaskStatus>([
  "queued",
  "starting",
  "thinking",
  "tool_running",
  "responding",
]);

/** Disk-serializable form of a sub-agent session. In-flight state (MCP
 *  connections, prompt queue, the active streaming turn) is not persisted. */
export type PersistedAgentTask = {
  slot: number;
  agent: string;
  title: string;
  status: AgentTaskStatus;
  activity?: string;
  createdAt: number;
  completedAt?: number;
  unread: boolean;
  history: ConversationMessage[];
  transcript: BackgroundAgentTask["transcript"];
};

export function agentTasksPath(): string {
  if (process.env.G_AGENT_HOME) {
    return join(process.env.G_AGENT_HOME, "agent-tasks.json");
  }
  if (process.env.G_AGENT_CONFIG) {
    return join(dirname(process.env.G_AGENT_CONFIG), "agent-tasks.json");
  }
  return join(homedir(), ".config", "g-agent", "agent-tasks.json");
}

export function toPersistedTask(task: BackgroundAgentTask): PersistedAgentTask {
  return {
    slot: task.slot,
    agent: task.agent.name,
    title: task.title,
    status: task.status,
    ...(task.activity ? { activity: task.activity } : {}),
    createdAt: task.createdAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    unread: task.unread,
    history: task.history,
    transcript: task.transcript,
  };
}

function isMessage(value: unknown): value is ConversationMessage {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<ConversationMessage>;
  return (
    (entry.role === "user" || entry.role === "assistant") &&
    typeof entry.content === "string"
  );
}

function isTranscriptEntry(value: unknown): BackgroundAgentTask["transcript"][number] | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    (entry.role !== "user" && entry.role !== "assistant") ||
    typeof entry.content !== "string"
  ) {
    return null;
  }
  const result: BackgroundAgentTask["transcript"][number] = {
    role: entry.role,
    content: entry.content,
  };
  if (typeof entry.thinking === "string") result.thinking = entry.thinking;
  if (Array.isArray(entry.tools)) {
    const tools = entry.tools.filter(
      (tool): tool is { name: string; args: string } =>
        !!tool &&
        typeof tool === "object" &&
        typeof (tool as { name?: unknown }).name === "string" &&
        typeof (tool as { args?: unknown }).args === "string",
    );
    if (tools.length > 0) result.tools = tools;
  }
  if (typeof entry.durationMs === "number") result.durationMs = entry.durationMs;
  return result;
}

/** Validate and normalize one persisted sub-agent. Busy statuses are reset to
 *  `idle` because an in-flight turn cannot be resumed mid-stream. */
export function normalizePersistedTask(raw: unknown): PersistedAgentTask | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Partial<PersistedAgentTask>;
  if (
    typeof entry.slot !== "number" ||
    !Number.isInteger(entry.slot) ||
    entry.slot <= 0 ||
    typeof entry.agent !== "string" ||
    entry.agent.length === 0
  ) {
    return null;
  }
  const status = (BUSY_STATUSES.has(entry.status ?? "idle") ? "idle" : entry.status ?? "idle") as AgentTaskStatus;
  const history = Array.isArray(entry.history) ? entry.history.filter(isMessage) : [];
  const transcript = Array.isArray(entry.transcript)
    ? entry.transcript
        .map(isTranscriptEntry)
        .filter((entry): entry is BackgroundAgentTask["transcript"][number] => entry !== null)
    : [];
  return {
    slot: entry.slot,
    agent: entry.agent,
    title: typeof entry.title === "string" ? entry.title : "",
    status,
    ...(typeof entry.activity === "string" ? { activity: entry.activity } : {}),
    createdAt: typeof entry.createdAt === "number" ? entry.createdAt : Date.now(),
    ...(typeof entry.completedAt === "number" ? { completedAt: entry.completedAt } : {}),
    unread: entry.unread === true,
    history,
    transcript,
  };
}

/** Reconstruct an in-memory sub-agent session from its persisted form.
 *  The MCP manager is intentionally absent and reconnects lazily on the next
 *  prompt; queued prompts and the active streaming turn are dropped. */
export function hydrateAgentTask(
  persisted: PersistedAgentTask,
  agent: AgentConfig,
): BackgroundAgentTask {
  return {
    slot: persisted.slot,
    agent,
    title: persisted.title,
    status: persisted.status,
    ...(persisted.activity ? { activity: persisted.activity } : {}),
    createdAt: persisted.createdAt,
    ...(persisted.completedAt !== undefined ? { completedAt: persisted.completedAt } : {}),
    unread: persisted.unread,
    history: persisted.history,
    transcript: persisted.transcript,
    promptQueue: [],
    draining: false,
  };
}

/** Load persisted sub-agent sessions and resolve each one's agent config from
 *  the current catalog. Entries whose agent no longer exists are skipped. */
export async function loadPersistedAgentTasks(
  loaded: LoadedAgents,
): Promise<BackgroundAgentTask[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(agentTasksPath(), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tasks: BackgroundAgentTask[] = [];
  for (const raw of parsed) {
    const persisted = normalizePersistedTask(raw);
    if (!persisted) continue;
    const agent = loaded.agents.get(persisted.agent);
    if (!agent) continue;
    tasks.push(hydrateAgentTask(persisted, agent));
  }
  tasks.sort((a, b) => a.slot - b.slot);
  return tasks;
}

export async function persistAgentTasks(tasks: BackgroundAgentTask[]): Promise<void> {
  try {
    const path = agentTasksPath();
    await mkdir(dirname(path), { recursive: true });
    const data = tasks.map(toPersistedTask);
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  } catch (error) {
    console.warn(
      "Failed to persist agent tasks:",
      error instanceof Error ? error.message : error,
    );
  }
}
