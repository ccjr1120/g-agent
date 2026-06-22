import React, { useCallback, useEffect, useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import {
  parseServerMessage,
  type ClientMessage,
} from "@g-agent/shared";

type ChatLine = {
  role: "user" | "assistant";
  text: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected";

function useAgentSocket(serverUrl: string) {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [streaming, setStreaming] = useState(false);
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
    };

    ws.onerror = () => {
      setError("Connection failed");
      setConnection("disconnected");
    };

    ws.onmessage = (event) => {
      const message = parseServerMessage(String(event.data));
      if (!message) return;

      switch (message.type) {
        case "ready":
          setConnection("connected");
          break;
        case "start":
          setStreaming(true);
          setLines((prev) => [...prev, { role: "assistant", text: "" }]);
          break;
        case "delta":
          setLines((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (!last || last.role !== "assistant") {
              return [...prev, { role: "assistant", text: message.text }];
            }
            next[next.length - 1] = {
              ...last,
              text: last.text + message.text,
            };
            return next;
          });
          break;
        case "done":
          setStreaming(false);
          break;
        case "error":
          setStreaming(false);
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
      if (!socket || socket.readyState !== WebSocket.OPEN || streaming) {
        return;
      }

      const payload: ClientMessage = { type: "chat", message: text };
      socket.send(JSON.stringify(payload));
      setLines((prev) => [...prev, { role: "user", text }]);
      setError(null);
    },
    [socket, streaming],
  );

  return { connection, lines, streaming, error, sendMessage };
}

export function App({
  serverUrl,
  providerName,
  configPath,
}: {
  serverUrl: string;
  providerName: string | null;
  configPath: string | null;
}) {
  const { connection, lines, streaming, error, sendMessage } =
    useAgentSocket(serverUrl);
  const [input, setInput] = useState("");

  const handleSubmit = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (connection !== "connected" || streaming) return;

    sendMessage(trimmed);
    setInput("");
  };

  const statusColor =
    connection === "connected"
      ? "green"
      : connection === "connecting"
        ? "yellow"
        : "red";

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        G-Agent
      </Text>
      <Text dimColor>
        Server: {serverUrl} ·{" "}
        <Text color={statusColor}>{connection}</Text>
        {providerName ? ` · ${providerName}` : ""}
        {streaming ? " · thinking…" : ""}
      </Text>
      {configPath ? (
        <Text dimColor>Config: {configPath}</Text>
      ) : null}

      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {lines.length === 0 ? (
          <Text dimColor>Type a message and press Enter. Ctrl+C to quit.</Text>
        ) : (
          lines.map((line, index) => (
            <Box key={`${line.role}-${index}`} flexDirection="column">
              <Text color={line.role === "user" ? "blue" : "white"}>
                {line.role === "user" ? "> " : "  "}
                {line.text || (streaming ? "…" : "")}
              </Text>
            </Box>
          ))
        )}
      </Box>

      {error ? <Text color="red">{error}</Text> : null}

      <Box marginTop={1}>
        <Text color="blue">{"> "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={
            connection === "connected" && !streaming
              ? "Message…"
              : "Waiting…"
          }
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Ctrl+C exit</Text>
      </Box>
    </Box>
  );
}
