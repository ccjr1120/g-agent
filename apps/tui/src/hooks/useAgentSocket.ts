import { useCallback, useEffect, useRef, useState } from "react";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseServerMessage,
  type ClientMessage,
} from "@g-agent/shared";

export type ToolCallDisplay = {
  name: string;
  label: string;
};

export type ChatLine = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools?: ToolCallDisplay[];
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
};

type LogEntry =
  | { type: "user"; text: string; ts: number }
  | { type: "system_prompt"; text: string; ts: number }
  | { type: "start"; ts: number }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; output: string }
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

export function useAgentSocket(serverUrl: string) {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [staticLines, setStaticLines] = useState<ChatLine[]>([]);
  const [streamingLine, setStreamingLine] = useState<ChatLine | null>(null);
  const [streaming, setIsStreaming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<{ id: string; text: string }[]>([]);

  const queueRef = useRef<QueueItem[]>([]);
  const undoStackRef = useRef<UndoAction[]>([]);
  const processingRef = useRef(false);
  const ignoreResponseRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const streamingRef = useRef<ChatLine | null>(null);

  const syncQueue = useCallback(() => {
    const waiting = queueRef.current
      .filter((item) => !item.sent)
      .map((item) => ({ id: item.id, text: item.text }));
    setQueuedMessages(waiting);
  }, []);

  const updateStreamingLine = useCallback((line: ChatLine | null) => {
    streamingRef.current = line;
    setStreamingLine(line);
  }, []);

  const commitTurn = useCallback(() => {
    const line = streamingRef.current;
    if (line && lineHasContent(line)) {
      setStaticLines((prev) => [...prev, line]);
    }
    updateStreamingLine(null);
  }, [updateStreamingLine]);

  const finishTurn = useCallback(() => {
    commitTurn();
    processingRef.current = false;
    setIsStreaming(false);
    setPending(false);
    queueMicrotask(() => {
      tryProcessQueueRef.current();
    });
  }, [commitTurn]);

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
    syncQueue();

    setStaticLines((prev) => [
      ...prev,
      { id: next.userLineId, role: "user", text: next.text },
    ]);

    setLog((prev) => [...prev, { type: "user", text: next.text, ts: Date.now() }]);
    ws.send(JSON.stringify({ type: "chat", message: next.text } satisfies ClientMessage));
  }, [syncQueue]);

  tryProcessQueueRef.current = tryProcessQueue;

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
      commitTurn();
    };

    ws.onerror = () => {
      setError("Connection failed");
      setConnection("disconnected");
      processingRef.current = false;
      setPending(false);
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
        case "skills":
          setSkills(message.skills);
          break;
        case "system_prompt":
          setLog((prev) => [...prev, { type: "system_prompt", text: message.text, ts: Date.now() }]);
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
          setLog((prev) => [...prev, { type: "start", ts: Date.now() }]);
          break;
        case "delta":
          if (!processingRef.current) return;
          setStreamingLine((current) => {
            const base =
              current ??
              ({
                id: createLineId(),
                role: "assistant",
                text: message.text,
                tools: [],
              } as ChatLine);
            const next =
              current == null
                ? base
                : { ...current, text: current.text + message.text };
            streamingRef.current = next;
            return next;
          });
          setLog((prev) => [...prev, { type: "delta", text: message.text }]);
          break;
        case "tool_call":
          if (!processingRef.current) return;
          setStreamingLine((current) => {
            const base =
              current ??
              ({
                id: createLineId(),
                role: "assistant",
                text: "",
                tools: [],
              } as ChatLine);
            const label = formatToolCall(message.name, message.args);
            const next = {
              ...base,
              tools: [...(base.tools ?? []), { name: message.name, label }],
            };
            streamingRef.current = next;
            return next;
          });
          setLog((prev) => [...prev, { type: "tool_call", name: message.name, args: message.args }]);
          break;
        case "tool_result":
          if (!processingRef.current) return;
          setLog((prev) => [...prev, { type: "tool_result", name: message.name, output: message.output }]);
          break;
        case "done":
          if (!processingRef.current) return;
          setLog((prev) => [...prev, { type: "done", ts: Date.now() }]);
          finishTurn();
          break;
        case "error":
          if (!processingRef.current) return;
          setError(message.message);
          setLog((prev) => [...prev, { type: "error", message: message.message, ts: Date.now() }]);
          finishTurn();
          break;
      }
    };

    setSocket(ws);

    return () => {
      ws.close();
      socketRef.current = null;
    };
  }, [serverUrl, finishTurn, syncQueue, commitTurn, updateStreamingLine]);

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
  }, [syncQueue, tryProcessQueue, updateStreamingLine]);

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
    setLog([]);
  }, [syncQueue, updateStreamingLine]);

  const dumpLog = useCallback(async (): Promise<string> => {
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
  }, [log]);

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
    queuedMessages,
    error,
    skills,
    sendMessage,
    addLocalLine,
    undoLastTurn,
    resetConversation,
    dumpLog,
  };
}
