import type { ServerWebSocket } from "bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildAgentSystemPrompt,
  runAgent,
  type ScheduledTaskManager,
} from "@g-agent/agent";
import {
  firstLineSummary,
  normalizePersistedTask,
  recordRun,
  SCHEDULE_AUTH_REQUIRED_MARKER,
  SCHEDULE_NO_UPDATE_MARKER,
  SCHEDULE_UPDATE_MARKER,
  scheduledTaskInfo,
  scheduledTasksPath,
  stripScheduleMarker,
  type PersistedScheduledTask,
  type ScheduledTask,
} from "./scheduled.js";
import { clients, initialAgent, loadedAgents, send, type WsData } from "./state.js";
import { connectMcpForAgent, resolveProvider } from "./helpers.js";

export function sendScheduledTasksToAll(): void {
  const tasks = scheduledTaskStore.map(scheduledTaskInfo);
  for (const ws of clients) {
    send(ws, { type: "scheduled_tasks", tasks });
  }
}

/**
 * Load persisted scheduled tasks. Invalid entries are skipped; overdue tasks
 * are pushed a full interval into the future so restart does not fire them all.
 */
async function loadScheduledTasks(): Promise<ScheduledTask[]> {
  const now = Date.now();
  try {
    const raw = await readFile(scheduledTasksPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((entry) => normalizePersistedTask(entry, now))
      .filter((task): task is ScheduledTask => task !== null);
  } catch {
    return [];
  }
}

export async function persistScheduledTasks(): Promise<void> {
  try {
    const path = scheduledTasksPath();
    await mkdir(dirname(path), { recursive: true });
    const data: PersistedScheduledTask[] = scheduledTaskStore.map(
      ({ mcpManager: _mcp, ...rest }) => rest,
    );
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  } catch (error) {
    console.warn(
      "Failed to persist scheduled tasks:",
      error instanceof Error ? error.message : error,
    );
  }
}

export const scheduledTaskStore: ScheduledTask[] = await loadScheduledTasks();

/**
 * The ScheduledTaskManager contract the agent tools rely on. Tasks live in a
 * server-wide store (persisted to disk), run on their own schedule in the
 * background and never touch the main conversation.
 */
export const scheduleManager: ScheduledTaskManager = {
  schedule({ label, prompt, intervalSeconds }) {
    const existing = scheduledTaskStore.find((task) => task.label === label);
    if (existing) {
      existing.prompt = prompt;
      existing.intervalSeconds = intervalSeconds;
      existing.nextRunAt = Date.now();
      existing.lastStatus = "scheduled";
      existing.unread = false;
      existing.authRequired = false;
      void persistScheduledTasks();
      sendScheduledTasksToAll();
      return scheduledTaskInfo(existing);
    }
    const task: ScheduledTask = {
      id: crypto.randomUUID().slice(0, 8),
      label,
      prompt,
      intervalSeconds,
      nextRunAt: Date.now() + intervalSeconds * 1000,
      running: false,
      lastStatus: "scheduled",
      unread: false,
      authRequired: false,
      runs: [],
    };
    scheduledTaskStore.push(task);
    void persistScheduledTasks();
    sendScheduledTasksToAll();
    return scheduledTaskInfo(task);
  },
  unschedule(id) {
    const index = scheduledTaskStore.findIndex((task) => task.id === id);
    if (index === -1) {
      return { ok: false, error: `Unknown scheduled task "${id}"` };
    }
    const [removed] = scheduledTaskStore.splice(index, 1);
    void removed?.mcpManager?.close();
    void persistScheduledTasks();
    sendScheduledTasksToAll();
    return { ok: true };
  },
  list() {
    return scheduledTaskStore.map(scheduledTaskInfo);
  },
};

/**
 * Run one scheduled task in the background. The agent gets the previous run's
 * output so it can compare and report only real changes; a reply starting with
 * [UPDATE] marks the task as unread in the panel. The task never enqueues
 * anything into the main conversation.
 */
export async function runScheduledTask(task: ScheduledTask): Promise<void> {
  task.running = true;
  task.lastStatus = "running";
  task.lastRunAt = Date.now();
  sendScheduledTasksToAll();

  if (!task.mcpManager) {
    task.mcpManager = await connectMcpForAgent(initialAgent);
  }

  const base = `[Scheduled task "${task.label}"] ${task.prompt}`;
  const compareNote =
    "\nIf an external tool needs a login that is missing or expired and you cannot proceed, start your reply with exactly " +
    SCHEDULE_AUTH_REQUIRED_MARKER +
    " and explain which login is needed.";
  const prompt = task.lastOutput
    ? `${base}\n\nPrevious run output (compare against it):\n---\n${task.lastOutput}\n---\nIf nothing changed and there is nothing new to report, start your reply with exactly ${SCHEDULE_NO_UPDATE_MARKER} followed by a short "no changes" note. If something changed or there is anything new, start your reply with exactly ${SCHEDULE_UPDATE_MARKER} and then summarize what is new.${compareNote}`
    : `${base}\nStart your reply with exactly ${SCHEDULE_UPDATE_MARKER} and then summarize what you found.${compareNote}`;

  const abortController = new AbortController();
  let output = "";
  let failed = false;
  try {
    await runAgent(
      prompt,
      (event) => {
        if (event.type === "delta") {
          output += event.text;
        } else if (event.type === "error") {
          failed = true;
        }
      },
      resolveProvider(initialAgent),
      buildAgentSystemPrompt(initialAgent, loadedAgents),
      [],
      {
        mcpManager: task.mcpManager,
        scheduleManager,
        signal: abortController.signal,
      },
    );
  } catch {
    failed = true;
  } finally {
    const trimmed = output.trim();
    const updated =
      !failed &&
      (trimmed.startsWith(SCHEDULE_UPDATE_MARKER) ||
        (!trimmed.startsWith(SCHEDULE_NO_UPDATE_MARKER) && trimmed.length > 0));
    const authRequired =
      !failed && trimmed.startsWith(SCHEDULE_AUTH_REQUIRED_MARKER);
    task.lastOutput = stripScheduleMarker(trimmed);
    task.lastSummary = authRequired
      ? "需要重新登录外部服务"
      : firstLineSummary(task.lastOutput, 160);
    task.lastStatus = failed || authRequired ? "error" : "ok";
    task.authRequired = authRequired;
    task.unread = updated || authRequired;
    task.running = false;
    task.nextRunAt = Date.now() + task.intervalSeconds * 1000;
    recordRun(task);
    if (task.unread) {
      for (const ws of clients) {
        send(ws, { type: "scheduled_task_update", task: scheduledTaskInfo(task) });
      }
    }
    sendScheduledTasksToAll();
    void persistScheduledTasks();
  }
}

export type { WsData };
