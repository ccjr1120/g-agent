import { useCallback, useEffect, useState } from "react";
import {
  parseServerMessage,
  type ClientMessage,
} from "@g-agent/shared";

export type ChatLine = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected";

function createLineId(): string {
  return crypto.randomUUID();
}

export function useAgentSocket(serverUrl: string) {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [staticLines, setStaticLines] = useState<ChatLine[]>([]);
  const [streamingLine, setStreamingLine] = useState<ChatLine | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(serverUrl);

    ws.onopen = () => {
      setConnection("connected");
      setError(null);
    };

    ws.onclose = () => {
      setConnection("disconnected");
      setStreaming(false);
      setPending(false);
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
      setPending(false);
    };

    ws.onmessage = (event) => {
      const message = parseServerMessage(String(event.data));
      if (!message) return;

      switch (message.type) {
        case "ready":
          setConnection("connected");
          break;
        case "start":
          setPending(false);
          setStreaming(true);
          setStreamingLine({
            id: createLineId(),
            role: "assistant",
            text: "",
          });
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
          break;
        case "done":
          setStreaming(false);
          setPending(false);
          setStreamingLine((current) => {
            if (current) {
              setStaticLines((prev) => [...prev, current]);
            }
            return null;
          });
          break;
        case "error":
          setStreaming(false);
          setPending(false);
          setStreamingLine((current) => {
            if (current?.text) {
              setStaticLines((prev) => [...prev, current]);
            }
            return null;
          });
          setError(message.message);
          break;
      }
    };

    setSocket(ws);

    return () => {
      ws.close();
    };
  }, [serverUrl]);

  const sendMessage = useCallback(
    (text: string) => {
      if (!socket || socket.readyState !== WebSocket.OPEN || streaming || pending) {
        return;
      }

      const payload: ClientMessage = { type: "chat", message: text };
      socket.send(JSON.stringify(payload));
      setStaticLines((prev) => [
        ...prev,
        { id: createLineId(), role: "user", text },
      ]);
      setPending(true);
      setError(null);
    },
    [socket, streaming, pending],
  );

  const waitingForReply =
    pending || (streaming && streamingLine !== null && !streamingLine.text);

  return {
    connection,
    staticLines,
    streamingLine,
    streaming,
    pending,
    waitingForReply,
    error,
    sendMessage,
  };
}
