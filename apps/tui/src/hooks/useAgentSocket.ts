import { useCallback, useEffect, useRef, useState } from "react";
import { homedir } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseServerMessage,
  type ClientMessage,
} from "@g-agent/shared";

export type ChatLine = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

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

function formatToolCall(name: string, args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (name === "bash" && typeof parsed.command === "string") {
      return `bash(${parsed.command})`;
    }
    if (name === "read" && typeof parsed.path === "string") {
      return `read(${parsed.path})`;
    }
    if (name === "write" && typeof parsed.path === "string") {
      return `write(${parsed.path})`;
    }
    if (name === "glob" && typeof parsed.pattern === "string") {
      return `glob(${parsed.pattern})`;
    }
    if (name === "grep" && typeof parsed.pattern === "string") {
      return `grep(${parsed.pattern})`;
    }
  } catch {
    // fall through
  }
  return `${name}(…)`;
}

function formatToolResult(output: string): string {
  const line = output.split("\n")[0] ?? "";
  if (line.length > 80) {
    return `${line.slice(0, 77)}…`;
  }
  return line || "(empty)";
}

export function useAgentSocket(serverUrl: string) {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [staticLines, setStaticLines] = useState<ChatLine[]>([]);
  const [streamingLine, setStreamingLine] = useState<ChatLine | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [queueSize, setQueueSize] = useState(0);

  const queueRef = useRef<QueueItem[]>([]);
  const undoStackRef = useRef<UndoAction[]>([]);
  const processingRef = useRef(false);
  const ignoreResponseRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);

  const syncQueueSize = useCallback(() => {
    const waiting = queueRef.current.filter((item) => !item.sent).length;
    setQueueSize(waiting);
  }, []);

  const tryProcessQueue = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || processingRef.current) {
      return;
    }

    const next = queueRef.current.find((item) => !item.sent);
    if (!next) {
      syncQueueSize();
      return;
    }

    next.sent = true;
    processingRef.current = true;
    setPending(true);
    setError(null);
    syncQueueSize();
    ws.send(JSON.stringify({ type: "chat", message: next.text } satisfies ClientMessage));
  }, [syncQueueSize]);

  const finishProcessing = useCallback(() => {
    processingRef.current = false;
    setStreaming(false);
    setPending(false);
    tryProcessQueue();
  }, [tryProcessQueue]);

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
      setStreaming(false);
      setPending(false);
      queueRef.current = [];
      undoStackRef.current = [];
      syncQueueSize();
      setStreamingLine((current) => {
        if (current?.text) {
          setStaticLines((prev) => [...prev, current]);
        }
        return null;
      });
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
          setStreamingLine(null);
          finishProcessing();
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
          setPending(false);
          setStreaming(true);
          setStreamingLine({
            id: createLineId(),
            role: "assistant",
            text: "",
          });
          setLog((prev) => [...prev, { type: "start", ts: Date.now() }]);
          break;
        case "delta":
          setStreamingLine((current) => {
            if (!current) {
              return {
                id: createLineId(),
                role: "assistant",
                text: message.text,
              };
            }
            return { ...current, text: current.text + message.text };
          });
          setLog((prev) => [...prev, { type: "delta", text: message.text }]);
          break;
        case "tool_call":
          setStreamingLine((current) => {
            const base =
              current ??
              ({
                id: createLineId(),
                role: "assistant",
                text: "",
              } as ChatLine);
            return {
              ...base,
              text: `${base.text}\n⏺ ${formatToolCall(message.name, message.args)}\n`,
            };
          });
          setLog((prev) => [...prev, { type: "tool_call", name: message.name, args: message.args }]);
          break;
        case "tool_result":
          setStreamingLine((current) => {
            if (!current) return current;
            return {
              ...current,
              text: `${current.text}  ${formatToolResult(message.output)}\n`,
            };
          });
          setLog((prev) => [...prev, { type: "tool_result", name: message.name, output: message.output }]);
          break;
        case "done":
          setLog((prev) => [...prev, { type: "done", ts: Date.now() }]);
          finishProcessing();
          break;
        case "error":
          setError(message.message);
          setLog((prev) => [...prev, { type: "error", message: message.message, ts: Date.now() }]);
          finishProcessing();
          break;
      }
    };

    setSocket(ws);

    return () => {
      ws.close();
      socketRef.current = null;
    };
  }, [serverUrl, finishProcessing, syncQueueSize]);

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

      setStreamingLine((current) => {
        setStaticLines((prev) => [
          ...prev,
          ...(current ? [current] : []),
          { id: userLineId, role: "user", text },
        ]);
        return null;
      });
      setLog((prev) => [...prev, { type: "user", text, ts: Date.now() }]);
      setError(null);
      tryProcessQueue();
    },
    [tryProcessQueue],
  );

  const addLocalLine = useCallback((text: string) => {
    const lineId = createLineId();
    undoStackRef.current.push({ kind: "local", lineId });
    setStreamingLine((current) => {
      setStaticLines((prev) => [
        ...prev,
        ...(current ? [current] : []),
        { id: lineId, role: "assistant", text },
      ]);
      return null;
    });
  }, []);

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
    syncQueueSize();

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
      setStreaming(false);
      setPending(false);
      setStreamingLine(null);
      removeUserLine();
      tryProcessQueue();
      return action.text;
    }

    setStaticLines((prev) => {
      const userIndex = prev.findIndex((line) => line.id === action.userLineId);
      if (userIndex === -1) {
        return prev;
      }
      const next = prev[userIndex + 1];
      if (next?.role === "assistant") {
        return [...prev.slice(0, userIndex), ...prev.slice(userIndex + 2)];
      }
      return [...prev.slice(0, userIndex), ...prev.slice(userIndex + 1)];
    });
    setStreamingLine(null);
    return action.text;
  }, [syncQueueSize, tryProcessQueue]);

  const resetConversation = useCallback(() => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "reset" } satisfies ClientMessage));
    queueRef.current = [];
    undoStackRef.current = [];
    processingRef.current = false;
    ignoreResponseRef.current = false;
    syncQueueSize();
    setStaticLines([]);
    setStreamingLine(null);
    setStreaming(false);
    setPending(false);
    setError(null);
    setLog([]);
  }, [syncQueueSize]);

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
    pending || (streaming && streamingLine !== null && !streamingLine.text);

  return {
    connection,
    staticLines,
    streamingLine,
    streaming,
    pending,
    waitingForReply,
    queueSize,
    error,
    skills,
    sendMessage,
    addLocalLine,
    undoLastTurn,
    resetConversation,
    dumpLog,
  };
}
