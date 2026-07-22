import { useCallback, useEffect, useRef, useState } from "react";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseServerMessage,
  type ClientMessage,
  type ConversationTurn,
  type McpServerCatalogEntry,
} from "@g-agent/shared";
import {
  listSessions,
  loadSession,
  saveSession,
  type SavedSession,
  type SavedSessionSummary,
} from "../lib/sessionStore.js";

export type ToolCallDisplay = {
  name: string;
  label: string;
};

export type ChatLine = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: ToolCallDisplay[];
  /** Elapsed wall-clock time of the assistant turn, in ms. Populated once
   * the turn completes; undefined while still streaming. */
  durationMs?: number;
};

function lineHasText(line: ChatLine): boolean {
  return line.text.trim().length > 0;
}

function lineHasContent(line: ChatLine): boolean {
  return lineHasText(line) || (line.tools?.length ?? 0) > 0;
}

export type SkillInfo = {
  name: string;
  description: string;
  source?: "builtin" | "self" | "global";
};

export type AgentInfo = {
  name: string;
  description: string;
  active: boolean;
};

export type McpServerInfo = McpServerCatalogEntry;

export type AgentFallbackInfo = {
  requested: string;
  active: string;
};

export type ContextUsage = {
  usedTokens: number;
  maxTokens: number;
  percent: number;
};

type LogEntry =
  | { type: "user"; text: string; ts: number }
  | { type: "system_prompt"; text: string; ts: number }
  | { type: "start"; ts: number }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; output: string; externalPath?: string }
  | { type: "done"; ts: number }
  | { type: "error"; message: string; ts: number };

type ConnectionState = "connecting" | "connected" | "disconnected";

type QueueItem = {
  id: string;
  userLineId: string;
  text: string;
  sent: boolean;
};

type UndoAction =
  | { kind: "chat"; userLineId: string; text: string; queueItemId: string }
  | { kind: "local"; lineId: string };

import {
  createEventLoopLagTracker,
  streamRenderInterval,
} from "../lib/streamRender.js";
import { storeToolResultOutput } from "../lib/logOutput.js";

function createLineId(): string {
  return crypto.randomUUID();
}

const HOME = homedir();

function shortenPath(path: string): string {
  if (path.startsWith(HOME)) {
    return `~${path.slice(HOME.length)}`;
  }
  return path;
}

function compactPath(path: string, maxLen = 48): string {
  const short = shortenPath(path);
  if (short.length <= maxLen) {
    return short;
  }
  const parts = short.split("/");
  if (parts.length <= 2) {
    return short.length > maxLen ? `…${short.slice(-(maxLen - 1))}` : short;
  }
  const tail = parts.slice(-2).join("/");
  return tail.length >= maxLen - 1 ? `…/${tail.slice(-(maxLen - 2))}` : `…/${tail}`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen - 1)}…`;
}

function shortenHomeInText(text: string): string {
  return text.split(HOME).join("~");
}

function formatToolCall(name: string, args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (name === "bash" && typeof parsed.command === "string") {
      return truncate(shortenHomeInText(parsed.command), 64);
    }
    if (
      (name === "read" || name === "write") &&
      typeof parsed.path === "string"
    ) {
      return compactPath(parsed.path);
    }
    if (name === "glob" && typeof parsed.pattern === "string") {
      return truncate(parsed.pattern, 48);
    }
    if (name === "grep" && typeof parsed.pattern === "string") {
      return truncate(parsed.pattern, 48);
    }
  } catch {
    // fall through
  }
  return "…";
}

function staticLinesToHistory(lines: ChatLine[]): ConversationTurn[] {
  return lines
    .filter((line) => line.role === "user" || line.role === "assistant")
    .filter((line) => line.text.trim().length > 0)
    .map((line) => ({ role: line.role, content: line.text }));
}

function historyToStaticLines(history: ConversationTurn[]): ChatLine[] {
  return history.map((message) => ({
    id: createLineId(),
    role: message.role,
    text: message.content,
  }));
}

function historyToLog(history: ConversationTurn[], startedAt: number): LogEntry[] {
  const entries: LogEntry[] = [];
  let ts = startedAt;

  for (const message of history) {
    if (message.role === "user") {
      entries.push({ type: "user", text: message.content, ts });
      entries.push({ type: "start", ts });
      ts += 1;
      continue;
    }

    entries.push({ type: "delta", text: message.content });
    entries.push({ type: "done", ts });
    ts += 1;
  }

  return entries;
}

function buildSessionPreview(history: ConversationTurn[]): string {
  const firstUser = history.find((message) => message.role === "user");
  if (!firstUser) {
    return "Untitled session";
  }
  return truncate(firstUser.content.replace(/\s+/g, " ").trim(), 60);
}

export function useAgentSocket(serverUrl: string) {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [staticLines, setStaticLines] = useState<ChatLine[]>([]);
  const [streamingLine, setStreamingLine] = useState<ChatLine | null>(null);
  const [streaming, setIsStreaming] = useState(false);
  const [pending, setPending] = useState(false);
  const [turnStartMs, setTurnStartMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeAgent, setActiveAgent] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [contextUsage, setContextUsage] = useState<ContextUsage>({
    usedTokens: 0,
    maxTokens: 0,
    percent: 0,
  });
  const [agentFallback, setAgentFallback] = useState<AgentFallbackInfo | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<{ id: string; text: string }[]>([]);
  const [savedSessions, setSavedSessions] = useState<SavedSessionSummary[]>([]);

  const queueRef = useRef<QueueItem[]>([]);
  const undoStackRef = useRef<UndoAction[]>([]);
  const processingRef = useRef(false);
  const ignoreResponseRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef<ChatLine | null>(null);
  const pendingDeltaRef = useRef("");
  const streamRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Conversation logs do not affect rendering. Keeping them outside React
  // avoids an extra state update and an ever-growing array copy per delta.
  const logRef = useRef<LogEntry[]>([]);
  const prevActiveAgentRef = useRef<string>("");
  const turnStartMsRef = useRef<number | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionStartedAtRef = useRef<number>(0);
  const resumingRef = useRef(false);
  const pendingResumeRef = useRef<SavedSession | null>(null);
  const eventLoopLagRef = useRef(createEventLoopLagTracker());

  const refreshSavedSessions = useCallback(async () => {
    const sessions = await listSessions();
    setSavedSessions(sessions);
  }, []);

  const resetTurnTiming = useCallback(() => {
    turnStartMsRef.current = null;
    setTurnStartMs(null);
  }, []);

  const stopTurnTiming = useCallback(() => {
    if (turnStartMsRef.current !== null) {
      const durationMs = Date.now() - turnStartMsRef.current;
      const current = streamingRef.current;
      if (current) {
        const stamped = { ...current, durationMs };
        streamingRef.current = stamped;
        setStreamingLine(stamped);
      }
    }
    turnStartMsRef.current = null;
    setTurnStartMs(null);
  }, []);

  const syncQueue = useCallback(() => {
    const waiting = queueRef.current
      .filter((item) => !item.sent)
      .map((item) => ({ id: item.id, text: item.text }));
    setQueuedMessages(waiting);
  }, []);

  const cancelPendingStreamRender = useCallback(() => {
    if (streamRenderTimerRef.current !== null) {
      clearTimeout(streamRenderTimerRef.current);
      streamRenderTimerRef.current = null;
    }
    pendingDeltaRef.current = "";
  }, []);

  const flushPendingStreamRender = useCallback(() => {
    if (streamRenderTimerRef.current !== null) {
      clearTimeout(streamRenderTimerRef.current);
      streamRenderTimerRef.current = null;
    }

    const delta = pendingDeltaRef.current;
    pendingDeltaRef.current = "";
    if (!delta) return;

    const current = streamingRef.current;
    const next: ChatLine = current
      ? { ...current, text: current.text + delta }
      : {
          id: createLineId(),
          role: "assistant",
          text: delta,
          tools: [],
        };
    streamingRef.current = next;
    setStreamingLine(next);
    logRef.current.push({ type: "delta", text: delta });
  }, []);

  const scheduleStreamRender = useCallback(() => {
    if (streamRenderTimerRef.current !== null) return;
    const bufferedLength =
      (streamingRef.current?.text.length ?? 0) + pendingDeltaRef.current.length;
    streamRenderTimerRef.current = setTimeout(() => {
      streamRenderTimerRef.current = null;
      flushPendingStreamRender();
    }, streamRenderInterval(bufferedLength, eventLoopLagRef.current.sample()));
  }, [flushPendingStreamRender]);

  const updateStreamingLine = useCallback((line: ChatLine | null) => {
    if (line === null) {
      cancelPendingStreamRender();
    }
    streamingRef.current = line;
    setStreamingLine(line);
  }, [cancelPendingStreamRender]);

  const commitTurn = useCallback(() => {
    const line = streamingRef.current;
    if (line && lineHasContent(line)) {
      setStaticLines((prev) => [...prev, line]);
    }
    updateStreamingLine(null);
  }, [updateStreamingLine]);

  const finishTurn = useCallback(() => {
    flushPendingStreamRender();
    stopTurnTiming();
    commitTurn();
    processingRef.current = false;
    setIsStreaming(false);
    setPending(false);
    queueMicrotask(() => {
      tryProcessQueueRef.current();
    });
  }, [commitTurn, flushPendingStreamRender, stopTurnTiming]);

  const tryProcessQueueRef = useRef<() => void>(() => {});

  const tryProcessQueue = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || processingRef.current) {
      return;
    }

    const next = queueRef.current.find((item) => !item.sent);
    if (!next) {
      syncQueue();
      return;
    }

    next.sent = true;
    processingRef.current = true;
    setPending(true);
    setError(null);
    const start = Date.now();
    turnStartMsRef.current = start;
    setTurnStartMs(start);
    syncQueue();

    setStaticLines((prev) => [
      ...prev,
      { id: next.userLineId, role: "user", text: next.text },
    ]);

    logRef.current.push({ type: "user", text: next.text, ts: Date.now() });
    ws.send(JSON.stringify({ type: "chat", message: next.text } satisfies ClientMessage));
  }, [syncQueue]);

  tryProcessQueueRef.current = tryProcessQueue;

  useEffect(() => {
    void refreshSavedSessions();
  }, [refreshSavedSessions]);

  useEffect(() => {
    if (pending || streaming) {
      return;
    }
    if (staticLines.length === 0 || !activeAgent) {
      return;
    }

    const history = staticLinesToHistory(staticLines);
    if (history.length === 0) {
      return;
    }

    if (!sessionIdRef.current) {
      sessionIdRef.current = crypto.randomUUID();
      sessionStartedAtRef.current = Date.now();
    }

    const session: SavedSession = {
      id: sessionIdRef.current,
      agent: activeAgent,
      model,
      startedAt: sessionStartedAtRef.current,
      updatedAt: Date.now(),
      preview: buildSessionPreview(history),
      turnCount: history.length,
      history,
    };

    void saveSession(session).then(() => refreshSavedSessions());
  }, [staticLines, activeAgent, model, pending, streaming, refreshSavedSessions]);

  useEffect(() => {
    const ws = new WebSocket(serverUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setConnection("connected");
      setError(null);
    };

    ws.onclose = () => {
      setConnection("disconnected");
      processingRef.current = false;
      ignoreResponseRef.current = false;
      setIsStreaming(false);
      setPending(false);
      queueRef.current = [];
      undoStackRef.current = [];
      syncQueue();
      resetTurnTiming();
      commitTurn();
    };

    ws.onerror = () => {
      setError("Connection failed");
      setConnection("disconnected");
      processingRef.current = false;
      setPending(false);
      resetTurnTiming();
    };

    ws.onmessage = (event) => {
      const message = parseServerMessage(String(event.data));
      if (!message) return;

      if (ignoreResponseRef.current) {
        if (message.type === "done" || message.type === "error") {
          ignoreResponseRef.current = false;
          updateStreamingLine(null);
          finishTurn();
        }
        return;
      }

      switch (message.type) {
        case "ready":
          setConnection("connected");
          break;
        case "agents": {
          setAgents(message.agents);
          const newActive = message.active;
          // The "agents" message arrives both on socket open and after a
          // server-side switch. Only clear the local conversation when the
          // active agent actually changes AND we have seen one before
          // (prevActive !== "" means not the initial open).
          if (
            prevActiveAgentRef.current !== "" &&
            prevActiveAgentRef.current !== newActive &&
            !resumingRef.current
          ) {
            queueRef.current = [];
            undoStackRef.current = [];
            processingRef.current = false;
            ignoreResponseRef.current = false;
            syncQueue();
            setStaticLines([]);
            updateStreamingLine(null);
            setIsStreaming(false);
            setPending(false);
            setError(null);
            logRef.current = [];
            setContextUsage({ usedTokens: 0, maxTokens: 0, percent: 0 });
            resetTurnTiming();
            setAgentFallback(null);
          }
          prevActiveAgentRef.current = newActive;
          setActiveAgent(newActive);
          setModel(message.model);
          break;
        }
        case "agent_fallback":
          // Startup-only hint: the configured agent didn't exist and the server
          // fell back to the built-in default. Cleared on any runtime switch.
          setAgentFallback({
            requested: message.requested,
            active: message.active,
          });
          break;
        case "skills":
          setSkills(message.skills);
          break;
        case "mcp":
          setMcpServers(message.servers);
          break;
        case "context":
          setContextUsage({
            usedTokens: message.usedTokens,
            maxTokens: message.maxTokens,
            percent: message.percent,
          });
          break;
        case "system_prompt":
          logRef.current.push({ type: "system_prompt", text: message.text, ts: Date.now() });
          break;
        case "start":
          if (!processingRef.current) return;
          setPending(false);
          setIsStreaming(true);
          updateStreamingLine({
            id: createLineId(),
            role: "assistant",
            text: "",
            tools: [],
          });
          logRef.current.push({ type: "start", ts: Date.now() });
          break;
        case "delta":
          if (!processingRef.current) return;
          pendingDeltaRef.current += message.text;
          scheduleStreamRender();
          break;
        case "tool_call":
          if (!processingRef.current) return;
          flushPendingStreamRender();
          {
            const base = streamingRef.current ?? {
              id: createLineId(),
              role: "assistant" as const,
              text: "",
              tools: [],
            };
            const next = {
              ...base,
              tools: [
                ...(base.tools ?? []),
                { name: message.name, label: formatToolCall(message.name, message.args) },
              ],
            };
            streamingRef.current = next;
            setStreamingLine(next);
          }
          logRef.current.push({ type: "tool_call", name: message.name, args: message.args });
          break;
        case "tool_result":
          if (!processingRef.current) return;
          void storeToolResultOutput(message.name, message.output, Date.now()).then((stored) => {
            logRef.current.push({
              type: "tool_result",
              name: message.name,
              output: stored.inline,
              ...(stored.externalPath ? { externalPath: stored.externalPath } : {}),
            });
          });
          break;
        case "done":
          if (!processingRef.current) return;
          flushPendingStreamRender();
          logRef.current.push({ type: "done", ts: Date.now() });
          finishTurn();
          break;
        case "error":
          if (resumingRef.current) {
            resumingRef.current = false;
            pendingResumeRef.current = null;
            setError(message.message);
            break;
          }
          if (!processingRef.current) return;
          setError(message.message);
          flushPendingStreamRender();
          logRef.current.push({ type: "error", message: message.message, ts: Date.now() });
          finishTurn();
          break;
        case "resumed": {
          const session = pendingResumeRef.current;
          pendingResumeRef.current = null;
          resumingRef.current = false;

          if (session) {
            sessionIdRef.current = session.id;
            sessionStartedAtRef.current = session.startedAt;
            queueRef.current = [];
            undoStackRef.current = [];
            processingRef.current = false;
            ignoreResponseRef.current = false;
            syncQueue();
            setStaticLines(historyToStaticLines(session.history));
            logRef.current = historyToLog(session.history, session.startedAt);
            updateStreamingLine(null);
            setIsStreaming(false);
            setPending(false);
            setError(null);
            resetTurnTiming();
            setAgentFallback(null);
          }
          break;
        }
      }
    };

    setSocket(ws);

    return () => {
      cancelPendingStreamRender();
      eventLoopLagRef.current.stop();
      ws.close();
      socketRef.current = null;
    };
  }, [serverUrl, finishTurn, syncQueue, commitTurn, updateStreamingLine, resetTurnTiming, flushPendingStreamRender, scheduleStreamRender, cancelPendingStreamRender]);

  const sendMessage = useCallback(
    (text: string) => {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      const userLineId = createLineId();
      const queueItem: QueueItem = {
        id: createLineId(),
        userLineId,
        text,
        sent: false,
      };
      queueRef.current.push(queueItem);
      undoStackRef.current.push({
        kind: "chat",
        userLineId,
        text,
        queueItemId: queueItem.id,
      });

      setError(null);
      syncQueue();
      tryProcessQueue();
    },
    [syncQueue, tryProcessQueue],
  );

  const addLocalLine = useCallback((text: string) => {
    const lineId = createLineId();
    undoStackRef.current.push({ kind: "local", lineId });
    commitTurn();
    setStaticLines((prev) => [
      ...prev,
      { id: lineId, role: "assistant", text },
    ]);
  }, [commitTurn]);

  const undoLastTurn = useCallback((): string | null => {
    const action = undoStackRef.current.pop();
    if (!action) {
      return null;
    }

    if (action.kind === "local") {
      setStaticLines((prev) => prev.filter((line) => line.id !== action.lineId));
      setStreamingLine((current) => (current?.id === action.lineId ? null : current));
      return "";
    }

    const queueIndex = queueRef.current.findIndex((item) => item.id === action.queueItemId);
    if (queueIndex === -1) {
      return null;
    }

    const queueItem = queueRef.current[queueIndex];
    queueRef.current.splice(queueIndex, 1);
    syncQueue();

    const removeUserLine = () => {
      setStaticLines((prev) => prev.filter((line) => line.id !== action.userLineId));
    };

    if (!queueItem.sent) {
      removeUserLine();
      return action.text;
    }

    if (processingRef.current) {
      ignoreResponseRef.current = true;
      processingRef.current = false;
      setIsStreaming(false);
      setPending(false);
      resetTurnTiming();
      updateStreamingLine(null);
      removeUserLine();
      tryProcessQueue();
      return action.text;
    }

    setStaticLines((prev) => {
      const userIndex = prev.findIndex((line) => line.id === action.userLineId);
      if (userIndex === -1) {
        return prev;
      }
      let endIndex = userIndex + 1;
      while (endIndex < prev.length && prev[endIndex]?.role === "assistant") {
        endIndex += 1;
      }
      return [...prev.slice(0, userIndex), ...prev.slice(endIndex)];
    });
    updateStreamingLine(null);
    return action.text;
  }, [syncQueue, tryProcessQueue, updateStreamingLine, resetTurnTiming]);

  const resetConversation = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "reset" } satisfies ClientMessage));
    queueRef.current = [];
    undoStackRef.current = [];
    processingRef.current = false;
    ignoreResponseRef.current = false;
    syncQueue();
    setStaticLines([]);
    updateStreamingLine(null);
    setIsStreaming(false);
    setPending(false);
    setError(null);
    logRef.current = [];
    setContextUsage({ usedTokens: 0, maxTokens: 0, percent: 0 });
    resetTurnTiming();
    sessionIdRef.current = null;
    sessionStartedAtRef.current = 0;
  }, [syncQueue, updateStreamingLine, resetTurnTiming]);

  const resumeSession = useCallback(async (idOrPrefix: string): Promise<boolean> => {
    const session = await loadSession(idOrPrefix);
    if (!session) {
      return false;
    }

    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    resumingRef.current = true;
    pendingResumeRef.current = session;
    setError(null);

    ws.send(
      JSON.stringify({
        type: "resume",
        agent: session.agent,
        history: session.history,
      } satisfies ClientMessage),
    );

    return true;
  }, []);

  const switchAgent = useCallback((name?: string) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({ type: "agent", ...(name ? { name } : {}) } satisfies ClientMessage),
    );
  }, []);

  const runSkill = useCallback((name: string) => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "skill", name } satisfies ClientMessage));
  }, []);

  const listMcp = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "mcp" } satisfies ClientMessage));
  }, []);

  const dumpLog = useCallback(async (): Promise<string> => {
    const log = logRef.current;
    const startedAt = log.find((e) => e.type === "user")?.ts ?? Date.now();
    const systemPrompt = [...log]
      .reverse()
      .find((e): e is Extract<LogEntry, { type: "system_prompt" }> => e.type === "system_prompt")
      ?.text;
    const lines: string[] = [
      `# Conversation Log`,
      ``,
      `${new Date(startedAt).toLocaleString()}`,
      ``,
    ];

    if (systemPrompt) {
      lines.push(`## ⚙️ System Prompt`);
      lines.push(``);
      lines.push("```");
      lines.push(systemPrompt);
      lines.push("```");
      lines.push(``);
    }

    lines.push(`---`, ``);

    let assistantText = "";
    let turnStartTs = 0;

    for (const entry of log) {
      switch (entry.type) {
        case "system_prompt":
          break;
        case "user":
          lines.push(`## 🧑 User  <sub>${new Date(entry.ts).toLocaleTimeString()}</sub>`);
          lines.push(``);
          lines.push(entry.text);
          lines.push(``);
          break;
        case "start":
          turnStartTs = entry.ts;
          assistantText = "";
          break;
        case "delta":
          assistantText += entry.text;
          break;
        case "tool_call": {
          if (assistantText.trim()) {
            lines.push(`## 🤖 Assistant  <sub>${new Date(turnStartTs).toLocaleTimeString()}</sub>`);
            lines.push(``);
            lines.push(assistantText.trim());
            lines.push(``);
            assistantText = "";
            turnStartTs = 0;
          }
          let prettyArgs: string;
          try {
            prettyArgs = JSON.stringify(JSON.parse(entry.args), null, 2);
          } catch {
            prettyArgs = entry.args;
          }
          lines.push(`### ⏺ Tool Call: \`${entry.name}\``);
          lines.push(``);
          lines.push("```json");
          lines.push(prettyArgs);
          lines.push("```");
          lines.push(``);
          break;
        }
        case "tool_result":
          lines.push(`### ↩ Tool Result: \`${entry.name}\``);
          lines.push(``);
          if (entry.externalPath) {
            lines.push(`> Full output: ${entry.externalPath}`);
            lines.push(``);
          }
          lines.push("```");
          lines.push(entry.output);
          lines.push("```");
          lines.push(``);
          break;
        case "done":
          if (assistantText.trim()) {
            lines.push(`## 🤖 Assistant  <sub>${new Date(turnStartTs).toLocaleTimeString()}</sub>`);
            lines.push(``);
            lines.push(assistantText.trim());
            lines.push(``);
            assistantText = "";
            turnStartTs = 0;
          }
          lines.push(`---`);
          lines.push(``);
          break;
        case "error":
          lines.push(`## ❌ Error  <sub>${new Date(entry.ts).toLocaleTimeString()}</sub>`);
          lines.push(``);
          lines.push(`> ${entry.message}`);
          lines.push(``);
          lines.push(`---`);
          lines.push(``);
          break;
      }
    }

    const logDir = join(homedir(), ".config", "g-agent", "logs");
    await mkdir(logDir, { recursive: true });
    const filename = `conversation-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.md`;
    const logPath = join(logDir, filename);
    await writeFile(logPath, lines.join("\n"), "utf8");
    return logPath;
  }, []);

  // True while the model is working but has not yet emitted any visible
  // content (pending or streaming with an empty line). The UI renders a
  // "Thinking…" spinner in this state.
  const waitingForReply =
    (pending || streaming) &&
    (streamingLine === null || !lineHasContent(streamingLine));

  return {
    connection,
    staticLines,
    streamingLine,
    streaming,
    pending,
    waitingForReply,
    turnStartMs,
    queuedMessages,
    error,
    skills,
    mcpServers,
    agents,
    activeAgent,
    model,
    contextUsage,
    agentFallback,
    savedSessions,
    sendMessage,
    addLocalLine,
    undoLastTurn,
    resetConversation,
    resumeSession,
    refreshSavedSessions,
    switchAgent,
    runSkill,
    listMcp,
    dumpLog,
  };
}
