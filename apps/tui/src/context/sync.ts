import { createRoot, createSignal, createMemo } from "solid-js";
import { createStore } from "solid-js/store";
import type {
  ActiveAgentTurn,
  AgentTaskInfo,
  ClientMessage,
  ConversationTurn,
  ScheduledTaskInfo,
  ScheduledTaskRun,
  ServerMessage,
} from "@g-agent/shared";
import { AgentClient } from "./sdk.js";
import {
  lineToTurn,
  newLineId,
  type ChatLine,
  type PlanDisplay,
  type TurnSegment,
} from "../model.js";
import { parsePlan } from "./plan.js";
import { handleServerEvent, completePlanIfDone } from "./sync-events.js";
import { applyDispatchActions, pushFeedbackLine } from "./sync-actions.js";
import type { DispatchAction } from "../commands/dispatch.js";
import type { EventHandlerContext, TurnStatus } from "./sync-types.js";
export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

export type ClientLike = {
  send: (message: ClientMessage) => void;
  on: (handler: (event: ServerMessage) => void) => () => void;
  connect: () => void;
  close: () => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export type PendingAsk = {
  id: string;
  question: string;
  options?: string[];
};

function createSyncStoreImpl(url: string, bannerInput: string[], clientInput?: ClientLike) {
  const client: ClientLike = clientInput ?? new AgentClient(url);

  const [connState, setConnState] = createSignal<ConnectionState>("connecting");
  const [banner] = createSignal<string[]>(bannerInput);
  const [turnStatus, setTurnStatus] = createSignal<TurnStatus>("idle");
  const [activeAgent, setActiveAgent] = createSignal("");
  const [activeModel, setActiveModel] = createSignal("");
  const [activeSlot, setActiveSlot] = createSignal<number | undefined>(undefined);
  const [sessionAgent, setSessionAgent] = createSignal("");
  const [sessionModel, setSessionModel] = createSignal("");
  const [context, setContext] = createSignal({ usedTokens: 0, maxTokens: 0, percent: 0 });
  const [asks, setAsks] = createSignal<PendingAsk[]>([]);
  const [activeAsk, setActiveAsk] = createSignal(0);
  const [isReady, setIsReady] = createSignal(false);
  const [sessionStarted, setSessionStarted] = createSignal(false);
  const [sessionKey, setSessionKey] = createSignal("main");
  const [pendingComplete, setPendingComplete] = createSignal<string | undefined>(undefined);
  const [pendingOpen, setPendingOpen] = createSignal<number | undefined>(undefined);
  const [lastUserLineId, setLastUserLineId] = createSignal<string | undefined>(undefined);

  const [catalog, setCatalog] = createStore({
    agents: [] as Array<{ name: string; description: string; active: boolean }>,
    skills: [] as Array<{ name: string; description: string; source: string }>,
    mcp: [] as import("@g-agent/shared").McpServerCatalogEntry[],
  });

  const [agentTasks, setAgentTasks] = createSignal<AgentTaskInfo[]>([]);
  const [scheduledTasks, setScheduledTasks] = createSignal<ScheduledTaskInfo[]>([]);
  const [lines, setLines] = createSignal<ChatLine[]>([]);
  const [streaming, setStreaming] = createSignal<ChatLine | null>(null);
  const [queuedLines, setQueuedLines] = createSignal<ChatLine[]>([]);
  const [plans, setPlans] = createStore<Record<string, PlanDisplay | undefined>>({});
  const [turnStartedAt, setTurnStartedAt] = createSignal<number | null>(null);
  const [toolStartedAt, setToolStartedAt] = createSignal<number | null>(null);

  function pushLine(line: ChatLine) {
    setLines((prev) => [...prev, line]);
  }

  function pushStreamingLine() {
    const line: ChatLine = {
      id: newLineId(),
      role: "assistant",
      text: "",
      segments: [],
      pendingThinking: "",
      pendingText: "",
      queued: false,
      slot: activeSlot(),
    };
    setStreaming(line);
    setTurnStartedAt(Date.now());
    return line;
  }

  function dequeueFirstQueued() {
    const first = queuedLines()[0];
    if (!first) return;
    setQueuedLines((prev) => prev.slice(1));
    setLines((prev) => prev.map((l) => (l.id === first.id && l.queued ? { ...l, queued: false } : l)));
  }

  function flushPending(live: ChatLine): ChatLine {
    const segments = [...live.segments];
    if (live.pendingThinking) segments.push({ type: "thinking", text: live.pendingThinking });
    if (live.pendingText) segments.push({ type: "text", text: live.pendingText });
    return { ...live, segments, pendingThinking: "", pendingText: "" };
  }

  function finishActiveTurn() {
    const live = streaming();
    if (!live) return;
    const committed = flushPending(live);
    if (turnStartedAt() !== null) committed.durationMs = Date.now() - (turnStartedAt() ?? Date.now());
    pushLine(committed);
    setStreaming(null);
    setTurnStartedAt(null);
    setToolStartedAt(null);
    setTurnStatus("idle");
  }

  function finishTurnWithError(message: string) {
    finishActiveTurn();
    pushFeedbackLine(setLines, "error", message, activeSlot());
    setTurnStatus("idle");
  }

  function markToolResult(name: string, ok: boolean, output: string) {
    const live = streaming();
    if (!live) return;
    let matched = false;
    const segments = live.segments.map((segment) => {
      if (matched) return segment;
      if (segment.type === "tool" && segment.name === name && segment.status === "running") {
        matched = true;
        return {
          ...segment,
          status: ok ? ("ok" as const) : ("error" as const),
          output,
          durationMs: toolStartedAt() !== null ? Date.now() - (toolStartedAt() ?? 0) : undefined,
        };
      }
      return segment;
    });
    setStreaming({ ...live, segments });
    setToolStartedAt(null);
    if (turnStatus() === "tool_running") setTurnStatus("active");
  }

  function handleThinkingDelta(text: string) {
    const live = streaming() ?? pushStreamingLine();
    setTurnStatus("active");
    if (live.pendingText) {
      const flushed = flushPending(live);
      setStreaming({ ...flushed, pendingThinking: flushed.pendingThinking + text });
    } else {
      setStreaming({ ...live, pendingThinking: live.pendingThinking + text });
    }
  }

  function handleDelta(text: string) {
    const live = streaming() ?? pushStreamingLine();
    setTurnStatus("active");
    if (live.pendingThinking) {
      const flushed = flushPending(live);
      setStreaming({
        ...flushed,
        pendingText: flushed.pendingText + text,
        text: live.text + text,
      });
    } else {
      setStreaming({ ...live, pendingText: live.pendingText + text, text: live.text + text });
    }
  }

  function handleToolCall(name: string, args: string) {
    if (name === "update_plan") {
      const plan = parsePlan(args);
      completePlanIfDone(eventCtx(), plan, args, sessionKey());
      return;
    }
    if (name === "ask_user") return;
    const live = streaming() ?? pushStreamingLine();
    setToolStartedAt(Date.now());
    setTurnStatus("tool_running");
    setStreaming({
      ...live,
      segments: [
        ...flushPending(live).segments,
        { type: "tool", name, args, status: "running" },
      ],
      pendingThinking: "",
      pendingText: "",
    });
  }

  function handleToolResult(name: string, output: string) {
    const ok = !output.toLowerCase().includes("error") || output.length === 0;
    markToolResult(name, ok, output);
  }

  function handleAskUserEvent(id: string, question: string, options?: string[]) {
    if (!question) return;
    setAsks((prev) => [...prev, { id, question, options }]);
    const live = streaming() ?? pushStreamingLine();
    setStreaming({
      ...live,
      segments: [
        ...flushPending(live).segments,
        { type: "ask", id, question, options } as TurnSegment,
      ],
      pendingThinking: "",
      pendingText: "",
    });
    setTurnStatus("asking");
  }

  function flushPendingOpen() {
    const slot = pendingOpen();
    if (slot !== undefined && turnStatus() === "idle" && streaming() === null) {
      setPendingOpen(undefined);
      send({ type: "agent_task", slot });
    }
  }

  function pushStatus(text: string) {
    pushFeedbackLine(setLines, "status", text, activeSlot());
  }

  function pushAssistantSummary(text: string) {
    pushLine({
      id: newLineId(),
      role: "assistant",
      text,
      segments: [{ type: "text", text }],
      pendingThinking: "",
      pendingText: "",
      queued: false,
      slot: activeSlot(),
    });
  }

  function historyToLines(history: ConversationTurn[]): ChatLine[] {
    const out: ChatLine[] = [];
    for (const turn of history) {
      if (turn.role === "user") {
        out.push({
          id: newLineId(),
          role: "user",
          text: turn.content,
          sentContent: turn.content,
          segments: [],
          pendingThinking: "",
          pendingText: "",
          queued: false,
          slot: activeSlot(),
        });
        continue;
      }
      const segments: TurnSegment[] = [];
      if (turn.thinking) segments.push({ type: "thinking", text: turn.thinking });
      if (turn.content) segments.push({ type: "text", text: turn.content });
      if (turn.tools) {
        for (const tool of turn.tools) {
          segments.push({ type: "tool", name: tool.name, args: tool.args, status: "ok" });
        }
      }
      if (segments.length > 0) {
        out.push({
          id: newLineId(),
          role: "assistant",
          text: turn.content,
          segments,
          pendingThinking: "",
          pendingText: "",
          durationMs: turn.durationMs,
          queued: false,
          slot: activeSlot(),
        });
      }
    }
    return out;
  }

  function activeTurnToLine(active: ActiveAgentTurn, slot?: number): ChatLine {
    const segments: TurnSegment[] = [];
    if (active.thinking) segments.push({ type: "thinking", text: active.thinking });
    for (const tool of active.tools) {
      segments.push({ type: "tool", name: tool.name, args: tool.args, status: "running" });
    }
    if (active.content) segments.push({ type: "text", text: active.content });
    return {
      id: newLineId(),
      role: "assistant",
      text: active.content,
      segments,
      pendingThinking: "",
      pendingText: "",
      queued: false,
      slot,
    };
  }

  function handleAgentSession(event: Extract<ServerMessage, { type: "agent_session" }>) {
    const slot = event.slot;
    setActiveSlot(slot);
    setSessionKey(slot === undefined ? "main" : `sub-${slot}`);
    setSessionAgent(event.agent);
    setSessionModel(event.model);
    const restored = historyToLines(event.history);
    const active = event.activeTurn;
    if (active && (active.content || active.thinking || active.tools.length > 0)) {
      setStreaming(activeTurnToLine(active, slot));
      setTurnStatus("active");
    } else {
      setStreaming(null);
      setTurnStatus("idle");
    }
    setLines(restored);
    setQueuedLines([]);
    setPendingOpen(undefined);
  }

  function updateScheduledTask(task: ScheduledTaskInfo) {
    setScheduledTasks((prev) => {
      const idx = prev.findIndex((t) => t.id === task.id);
      if (idx === -1) return [...prev, task];
      const next = [...prev];
      next[idx] = task;
      return next;
    });
  }

  function showScheduledHistory(id: string, runs: ScheduledTaskRun[]) {
    const task = scheduledTasks().find((t) => t.id === id);
    const label = task?.label ?? id;
    if (runs.length === 0) {
      pushFeedbackLine(setLines, "local", `No history for "${label}".`, activeSlot());
      return;
    }
    const body = runs
      .slice(-10)
      .map((run) => {
        const when = new Date(run.runAt).toISOString().slice(0, 16).replace("T", " ");
        return `  ${when} · ${run.status} · ${run.summary}`;
      })
      .join("\n");
    pushFeedbackLine(setLines, "local", `History for "${label}":\n${body}`, activeSlot());
  }

  function eventCtx(): EventHandlerContext {
    return {
      streaming,
      sessionKey,
      activeSlot,
      turnStatus,
      setIsReady,
      setCatalog,
      setActiveAgent,
      setActiveModel,
      setSessionAgent,
      setSessionModel,
      setContext,
      setSessionStarted,
      setTurnStatus,
      setAgentTasks,
      setScheduledTasks,
      setPlans: (key, plan) => setPlans(key, plan),
      dequeueFirstQueued,
      pushStreamingLine,
      handleThinkingDelta,
      handleDelta,
      handleToolCall,
      handleToolResult,
      handleAskUserEvent,
      finishActiveTurn,
      finishTurnWithError,
      flushPendingOpen,
      handleAgentSession,
      updateScheduledTask,
      showScheduledHistory,
      pushStatus,
      pushAssistantSummary,
    };
  }

  function send(message: ClientMessage) {
    client.send(message);
  }

  function submit(text: string) {
    const content = text.trim();
    if (!content) return;
    const turnBusy = streaming() !== null || turnStatus() !== "idle";
    const line: ChatLine = {
      id: newLineId(),
      role: "user",
      text: content,
      sentContent: content,
      segments: [],
      pendingThinking: "",
      pendingText: "",
      queued: turnBusy,
      slot: activeSlot(),
    };
    pushLine(line);
    setLastUserLineId(line.id);
    if (turnBusy) setQueuedLines((prev) => [...prev, line]);
    send({ type: "chat", message: content });
  }

  function submitAskReply(reply: string) {
    const pending = asks()[activeAsk()];
    if (!pending) return;
    send({ type: "ask_user_reply", id: pending.id, reply });
    setAsks((prev) => prev.filter((a) => a.id !== pending.id));
    setActiveAsk(Math.max(0, activeAsk() - 1));
    const live = streaming();
    if (live) {
      setStreaming({
        ...live,
        segments: [...flushPending(live).segments, { type: "reply", text: reply }],
      });
    }
    setTurnStatus("active");
  }

  function skipAsk() {
    const pending = asks()[activeAsk()];
    if (!pending) return;
    send({ type: "ask_user_reply", id: pending.id, reply: "skip" });
    setAsks((prev) => prev.filter((a) => a.id !== pending.id));
    setActiveAsk(Math.max(0, activeAsk() - 1));
  }

  function cancel() {
    send({ type: "cancel" });
    setQueuedLines([]);
    setLines((prev) => prev.map((l) => (l.queued ? { ...l, queued: false } : l)));
    setStreaming(null);
    setTurnStartedAt(null);
    setToolStartedAt(null);
    setTurnStatus("idle");
    setAsks([]);
  }

  function cancelTurn(): string | null {
    const queued = queuedLines();
    if (queued.length > 0) {
      const last = queued[queued.length - 1];
      setQueuedLines((prev) => prev.slice(0, -1));
      setLines((prev) => prev.filter((l) => l.id !== last.id));
      pushStatus("Removed queued message — restored to editor");
      return last.sentContent ?? last.text;
    }
    if (streaming() !== null || turnStatus() !== "idle") {
      const userId = lastUserLineId();
      let restore: string | null = null;
      if (userId) {
        const userLine = lines().find((l) => l.id === userId);
        restore = userLine?.sentContent ?? userLine?.text ?? null;
        setLines((prev) => prev.filter((l) => l.id !== userId));
      }
      cancel();
      pushStatus("Turn cancelled — your prompt was restored to the editor");
      return restore;
    }
    return null;
  }

  function reset() {
    send({ type: "reset" });
    setLines([]);
    setStreaming(null);
    setQueuedLines([]);
    setTurnStatus("idle");
    setAsks([]);
    setPendingOpen(undefined);
    setActiveSlot(undefined);
    setSessionKey("main");
  }

  function runActions(actions: DispatchAction[]): boolean {
    return applyDispatchActions(
      {
        activeSlot,
        send,
        submit,
        reset,
        setLines,
        setPendingComplete,
        setPendingOpen,
      },
      actions,
    );
  }

  function transcriptForExport() {
    return lines().map((line) => ({ role: line.role, text: line.text }));
  }

  function connect() {
    client.onOpen = () => setConnState("connected");
    client.onClose = () => {
      const had = connState() === "connected";
      setConnState(had ? "reconnecting" : "connecting");
    };
    client.on((event) => handleServerEvent(eventCtx(), event));
    client.connect();
  }

  function disconnect() {
    client.close();
  }

  const serializeSession = createMemo(() => {
    const history: ConversationTurn[] = lines()
      .map(lineToTurn)
      .filter((turn) => turn.role === "user" || turn.role === "assistant");
    const live = streaming();
    if (live) history.push(lineToTurn(flushPending(live)));
    return history;
  });

  const isTurnBusy = () => streaming() !== null || turnStatus() !== "idle";

  return {
    connState,
    banner,
    isReady,
    turnStatus,
    activeAgent,
    activeModel,
    sessionAgent,
    sessionModel,
    activeSlot,
    sessionKey,
    context,
    asks,
    activeAsk,
    setActiveAsk,
    catalog,
    agentTasks,
    scheduledTasks,
    lines,
    streaming,
    queuedLines,
    plans,
    sessionStarted,
    turnStartedAt,
    serializeSession,
    pendingComplete,
    setPendingComplete,
    send,
    submit,
    submitAskReply,
    skipAsk,
    cancel,
    cancelTurn,
    reset,
    runActions,
    transcriptForExport,
    isTurnBusy,
    connect,
    disconnect,
  };
}

export type Sync = ReturnType<typeof createSyncStoreImpl>;

let root: Sync | undefined;
let rootUrl = "";

export function createSyncStore(url: string, banner: string[], clientInput?: ClientLike): Sync {
  return createSyncStoreImpl(url, banner, clientInput);
}

export function getSync(url: string, banner: string[]): Sync {
  if (!root || rootUrl !== url) {
    if (root) root.disconnect();
    rootUrl = url;
    root = createRoot(() => {
      const sync = createSyncStoreImpl(url, banner);
      sync.connect();
      return sync;
    });
  }
  return root;
}
