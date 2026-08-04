import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpManager } from "@g-agent/agent";
import type {
  ScheduledTaskInfo,
  ScheduledTaskRun,
  ScheduledTaskStatus,
} from "@g-agent/shared";

export const SCHEDULE_UPDATE_MARKER = "[UPDATE]";
export const SCHEDULE_NO_UPDATE_MARKER = "[NO_UPDATE]";
export const SCHEDULE_AUTH_REQUIRED_MARKER = "[AUTH_REQUIRED]";

export const MAX_RUN_HISTORY = 10;

export type ScheduledTask = {
  id: string;
  label: string;
  prompt: string;
  intervalSeconds: number;
  nextRunAt: number;
  running: boolean;
  lastRunAt?: number;
  lastStatus: ScheduledTaskStatus;
  lastSummary?: string;
  lastOutput?: string;
  unread: boolean;
  authRequired: boolean;
  runs: ScheduledTaskRun[];
  mcpManager?: McpManager;
};

export type PersistedScheduledTask = Omit<ScheduledTask, "mcpManager">;

export function scheduledTaskInfo(task: ScheduledTask): ScheduledTaskInfo {
  return {
    id: task.id,
    label: task.label,
    prompt: task.prompt,
    intervalSeconds: task.intervalSeconds,
    nextRunAt: task.nextRunAt,
    running: task.running,
    ...(task.lastRunAt !== undefined ? { lastRunAt: task.lastRunAt } : {}),
    lastStatus: task.lastStatus,
    ...(task.lastSummary ? { lastSummary: task.lastSummary } : {}),
    unread: task.unread,
    ...(task.authRequired ? { authRequired: true } : {}),
  };
}

export function scheduledTasksPath(): string {
  if (process.env.G_AGENT_HOME) {
    return join(process.env.G_AGENT_HOME, "scheduled-tasks.json");
  }
  if (process.env.G_AGENT_CONFIG) {
    return join(dirname(process.env.G_AGENT_CONFIG), "scheduled-tasks.json");
  }
  return join(homedir(), ".config", "g-agent", "scheduled-tasks.json");
}

/**
 * Validate and normalize a persisted task. Runs are debounced on restart: a
 * task whose next run is already overdue is pushed a full interval into the
 * future instead of firing immediately on boot.
 */
export function normalizePersistedTask(
  raw: unknown,
  now: number,
): ScheduledTask | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = raw as Partial<PersistedScheduledTask>;
  if (typeof entry.id !== "string" || typeof entry.prompt !== "string") {
    return null;
  }
  const intervalSeconds = Number(entry.intervalSeconds);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 30) {
    return null;
  }
  const task: ScheduledTask = {
    id: entry.id,
    label: typeof entry.label === "string" && entry.label ? entry.label : entry.id,
    prompt: entry.prompt,
    intervalSeconds,
    nextRunAt: Number.isFinite(Number(entry.nextRunAt))
      ? Number(entry.nextRunAt)
      : now + intervalSeconds * 1000,
    running: false,
    lastStatus: entry.lastStatus ?? "scheduled",
    lastSummary: typeof entry.lastSummary === "string" ? entry.lastSummary : undefined,
    lastOutput: typeof entry.lastOutput === "string" ? entry.lastOutput : undefined,
    unread: entry.unread === true,
    authRequired: entry.authRequired === true,
    runs: Array.isArray(entry.runs) ? entry.runs.slice(0, MAX_RUN_HISTORY) : [],
  };
  if (task.nextRunAt <= now) {
    task.nextRunAt = now + task.intervalSeconds * 1000;
  }
  return task;
}

export function stripScheduleMarker(output: string): string {
  const trimmed = output.trim();
  for (const marker of [
    SCHEDULE_UPDATE_MARKER,
    SCHEDULE_NO_UPDATE_MARKER,
    SCHEDULE_AUTH_REQUIRED_MARKER,
  ]) {
    if (trimmed.startsWith(marker)) {
      return trimmed.slice(marker.length).trim();
    }
  }
  return trimmed;
}

export function firstLineSummary(text: string, max: number): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export function recordRun(task: ScheduledTask): void {
  task.runs.push({
    runAt: task.lastRunAt ?? Date.now(),
    status: task.lastStatus,
    summary: task.lastSummary ?? "",
  });
  if (task.runs.length > MAX_RUN_HISTORY) {
    task.runs = task.runs.slice(-MAX_RUN_HISTORY);
  }
}
