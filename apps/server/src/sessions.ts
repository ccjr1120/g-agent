import type { ServerWebSocket } from "bun";
import {
  buildAgentSystemPrompt,
  resolveActiveAgent,
  runAgent,
  type AgentConfig,
} from "@g-agent/agent";
import {
  send,
  sendAgentTasks,
  loadedAgents,
  type BackgroundAgentTask,
  type WsData,
} from "./state.js";
import { connectMcpForAgent, makeAskUserHandler, resolveProvider } from "./helpers.js";
import {
  modelLabel,
  refreshClient,
  reloadAgentsCatalog,
  sendMcpCatalog,
} from "./catalog.js";
import { scheduleManager, sendScheduledTasksToAll } from "./scheduled-runtime.js";
import { persistAgentTasks } from "./agent-tasks.js";
import { truncateError } from "./usage.js";

export async function loadStartupAgent(): Promise<{ agent: AgentConfig }> {
  await reloadAgentsCatalog();
  return { agent: resolveActiveAgent(undefined, loadedAgents).agent };
}

export async function applyAgentSwitch(
  ws: ServerWebSocket<WsData>,
  target: AgentConfig,
  options: { clearHistory: boolean; reconnectMcp?: boolean },
): Promise<void> {
  const agentChanged = target.name !== ws.data.activeAgent.name;
  if (agentChanged || options.reconnectMcp) {
    await ws.data.mcpManager.close();
    ws.data.activeAgent = target;
    ws.data.systemPrompt = buildAgentSystemPrompt(target, loadedAgents);
    ws.data.effectiveProvider = resolveProvider(target);
    ws.data.mcpManager = await connectMcpForAgent(target);
  }

  ws.data.promptQueue.length = 0;
  if (options.clearHistory) {
    ws.data.history.length = 0;
  }

  refreshClient(ws);
}

/**
 * Abort any in-flight main-session turn. `/new` must cancel the running
 * request before history is cleared: otherwise the turn finishing later would
 * re-push its old user/assistant pair into the cleared history and leak stale
 * context into the first message after the reset.
 */
export function cancelMainTurn(ws: ServerWebSocket<WsData>): void {
  ws.data.abortController?.abort();
  ws.data.cancelRequested = false;
}

/**
 * Start a clean session without restarting the server process.
 *
 * A session boundary is also a resource reload boundary: config, agents and
 * skills are re-read from disk, and MCP connections are recreated even when
 * their serialized config did not change (the MCP server implementation or
 * its advertised tools may have changed).
 *
 * Sub-agent sessions are independent of the main conversation and survive a
 * `/new`: they keep their slots and history, re-resolve their agent config
 * from the freshly loaded catalog, and stay selectable via `/<slot>`.
 */
export async function restartSession(ws: ServerWebSocket<WsData>): Promise<void> {
  cancelMainTurn(ws);
  const currentAgentName = ws.data.activeAgent.name;
  await reloadAgentsCatalog();

  const target =
    loadedAgents.agents.get(currentAgentName) ??
    resolveActiveAgent(undefined, loadedAgents).agent;

  await applyAgentSwitch(ws, target, {
    clearHistory: true,
    reconnectMcp: true,
  });
  for (const task of ws.data.agentTasks) {
    task.agent = loadedAgents.agents.get(task.agent.name) ?? task.agent;
  }
  ws.data.activeAgentTaskSlot = undefined;
  await persistAgentTasks(ws.data.agentTasks);
  sendAgentTasks(ws);
  sendScheduledTasksToAll();
}

export function sendAgentSession(
  ws: ServerWebSocket<WsData>,
  task?: BackgroundAgentTask,
): void {
  send(ws, {
    type: "agent_session",
    ...(task ? { slot: task.slot } : {}),
    agent: task?.agent.name ?? ws.data.activeAgent.name,
    model: task
      ? modelLabel(resolveProvider(task.agent))
      : modelLabel(ws.data.effectiveProvider),
    history: task
      ? task.transcript
      : ws.data.history.map((message) => ({
          role: message.role,
          content: message.content ?? "",
        })),
    ...(task?.activeTurn ? { activeTurn: task.activeTurn } : {}),
  });
}

export function createAgentSession(
  ws: ServerWebSocket<WsData>,
  agent: AgentConfig,
  activate = true,
): BackgroundAgentTask {
  const task: BackgroundAgentTask = {
    slot: nextFreeAgentSlot(ws.data.agentTasks),
    agent,
    title: "",
    status: "idle",
    activity: "Waiting for first message",
    createdAt: Date.now(),
    unread: false,
    history: [],
    transcript: [],
    promptQueue: [],
    draining: false,
  };
  ws.data.agentTasks.push(task);
  void persistAgentTasks(ws.data.agentTasks);
  if (activate) {
    ws.data.activeAgentTaskSlot = task.slot;
  }
  sendAgentTasks(ws);
  if (activate) {
    sendAgentSession(ws, task);
    sendMcpCatalog(ws);
  }
  return task;
}

export async function runAgentSessionPrompt(
  ws: ServerWebSocket<WsData>,
  task: BackgroundAgentTask,
  prompt: string,
): Promise<void> {
  // elapsedMs describes the current (or most recently completed) turn, not
  // the lifetime of the reusable child session.
  task.createdAt = Date.now();
  task.completedAt = undefined;
  if (!task.title) {
    task.title = prompt;
  }
  const isVisible = () => ws.data.activeAgentTaskSlot === task.slot;
  if (!task.mcpManager) {
    task.status = "starting";
    task.activity = "Starting";
    sendAgentTasks(ws);
    task.mcpManager = await connectMcpForAgent(task.agent);
    if (isVisible()) {
      sendMcpCatalog(ws);
    }
  }

  task.status = "thinking";
  task.activity = "Analyzing";
  task.unread = false;
  const priorHistory = [...task.history];
  task.history.push({ role: "user", content: prompt });
  task.transcript.push({ role: "user", content: prompt });
  task.activeTurn = { content: "", thinking: "", tools: [] };
  if (isVisible()) {
    send(ws, { type: "start" });
  }
  sendAgentTasks(ws);

  let assistantText = "";
  let failed = false;
  const abortController = new AbortController();
  task.abortController = abortController;
  try {
    await runAgent(
      prompt,
      (event) => {
        const wasStatus = task.status;
        const wasActivity = task.activity;
        if (event.type === "thinking_delta") {
          task.status = "thinking";
          task.activity = "Analyzing";
          task.activeTurn!.thinking += event.text;
          if (isVisible()) send(ws, { type: "thinkingDelta", text: event.text });
        } else if (event.type === "tool_call") {
          task.status = "tool_running";
          task.activity = summarizeToolActivity(event.name, event.args);
          task.activeTurn!.tools.push({ name: event.name, args: event.args });
          if (isVisible()) {
            send(ws, { type: "tool_call", name: event.name, args: event.args });
          }
        } else if (event.type === "tool_result") {
          if (isVisible()) {
            send(ws, {
              type: "tool_result",
              name: event.name,
              output: event.output,
            });
          }
        } else if (event.type === "delta") {
          task.status = "responding";
          task.activity = "Writing response";
          assistantText += event.text;
          task.activeTurn!.content += event.text;
          if (isVisible()) send(ws, { type: "delta", text: event.text });
        } else if (event.type === "error") {
          failed = true;
          task.status = "failed";
          task.activity = "Failed";
          task.completedAt = Date.now();
          task.unread = !isVisible();
          task.history.push({
            role: "assistant",
            content: `[Previous attempt failed: ${truncateError(event.message)}]`,
          });
          const turn = task.activeTurn;
          if (turn && (turn.content.trim() || turn.thinking.trim() || turn.tools.length > 0)) {
            task.transcript.push({
              role: "assistant",
              content: turn.content,
              ...(turn.thinking ? { thinking: turn.thinking } : {}),
              ...(turn.tools.length > 0 ? { tools: turn.tools } : {}),
              durationMs: Date.now() - task.createdAt,
            });
          }
          task.activeTurn = undefined;
          if (isVisible()) send(ws, { type: "error", message: event.message });
        } else if (event.type === "cancelled") {
          failed = true;
          task.history = priorHistory;
          task.transcript.pop();
          task.activeTurn = undefined;
          task.status = "cancelled";
          task.activity = "Cancelled";
          task.completedAt = Date.now();
          if (isVisible()) send(ws, { type: "done" });
        } else if (event.type === "done") {
          if (!failed) {
            if (assistantText.trim()) {
              task.history.push({ role: "assistant", content: assistantText });
            }
            const turn = task.activeTurn;
            if (turn && (turn.content.trim() || turn.thinking.trim() || turn.tools.length > 0)) {
              task.transcript.push({
                role: "assistant",
                content: turn.content,
                ...(turn.thinking ? { thinking: turn.thinking } : {}),
                ...(turn.tools.length > 0 ? { tools: turn.tools } : {}),
                durationMs: Date.now() - task.createdAt,
              });
            }
            task.activeTurn = undefined;
            task.status = "completed";
            task.activity = "Ready";
            task.completedAt = Date.now();
            task.unread = !isVisible();
          }
          if (isVisible()) send(ws, { type: "done" });
        }
        if (
          task.status !== wasStatus ||
          task.activity !== wasActivity ||
          event.type === "done" ||
          event.type === "error"
        ) {
          sendAgentTasks(ws);
        }
      },
      resolveProvider(task.agent),
      buildAgentSystemPrompt(task.agent, loadedAgents),
      priorHistory,
      {
        mcpManager: task.mcpManager,
        scheduleManager,
        signal: abortController.signal,
        agentName: task.agent.name,
        askUser: makeAskUserHandler(ws, abortController.signal),
      },
    );
  } finally {
    if (task.abortController === abortController) {
      task.abortController = undefined;
    }
    void persistAgentTasks(ws.data.agentTasks);
  }
}

export async function drainAgentSessionQueue(
  ws: ServerWebSocket<WsData>,
  task: BackgroundAgentTask,
): Promise<void> {
  if (task.draining) return;
  task.draining = true;
  try {
    while (task.promptQueue.length > 0) {
      const prompt = task.promptQueue.shift();
      if (prompt) await runAgentSessionPrompt(ws, task, prompt);
    }
  } finally {
    task.draining = false;
  }
}

function summarizeToolActivity(name: string, argsText: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsText) as Record<string, unknown>;
  } catch {
    // Tool progress is best-effort and must never affect execution.
  }
  if (name === "read" || name === "write") {
    return `${name === "read" ? "Reading" : "Writing"} ${String(args.path ?? "file")}`;
  }
  if (name === "bash") {
    return "Running a command";
  }
  if (name === "glob" || name === "grep") {
    return "Searching files";
  }
  return `Using ${name}`;
}

/**
 * The smallest positive slot not currently used by a sub-agent, so closing an
 * agent frees its number and the next one reuses it instead of always +1.
 */
export function nextFreeAgentSlot(tasks: BackgroundAgentTask[]): number {
  const used = new Set(tasks.map((task) => task.slot));
  let slot = 1;
  while (used.has(slot)) {
    slot += 1;
  }
  return slot;
}
