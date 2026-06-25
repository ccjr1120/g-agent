import React, { useCallback, useMemo, useState } from "react";
import { Box, Static, Text, useApp } from "ink";
import { ChatInput, type SlashCommand } from "./components/ChatInput.js";
import { LoadingSpinner } from "./components/LoadingSpinner.js";
import { MessageLine } from "./components/MessageLine.js";
import { useAgentSocket } from "./hooks/useAgentSocket.js";

export function App({
  serverUrl,
  banner,
}: {
  serverUrl: string;
  banner: string[];
}) {
  const { exit } = useApp();
  const [restoreText, setRestoreText] = useState<string | null>(null);
  const {
    connection,
    staticLines,
    streamingLine,
    waitingForReply,
    streaming,
    turnStartMs,
    pending,
    queuedMessages,
    error,
    skills,
    agents,
    activeAgent,
    agentFallback,
    sendMessage,
    addLocalLine,
    undoLastTurn,
    resetConversation,
    switchAgent,
    dumpLog,
  } = useAgentSocket(serverUrl);

  const commands = useMemo<SlashCommand[]>(() => [
    { value: "/skills", description: "列出已加载的技能" },
    { value: "/agent", description: "列出或切换 agent" },
    { value: "/new", description: "开启新对话" },
    { value: "/log", description: "导出完整对话记录到文件" },
  ], []);

  const handleSubmit = useCallback(
    (text: string) => {
      if (text === "exit") {
        exit();
        return;
      }
      if (text === "/new") {
        resetConversation();
        return;
      }
      if (text === "/skills") {
        if (skills.length === 0) {
          addLocalLine("No skills loaded.");
        } else {
          const lines = skills
            .map((s) => `• ${s.name}${s.description ? ` — ${s.description}` : ""}`)
            .join("\n");
          addLocalLine(lines);
        }
        return;
      }
      if (text === "/agent") {
        if (agents.length === 0) {
          addLocalLine("No agents loaded.");
        } else {
          const lines = agents
            .map((a) => `${a.active ? "* " : "  "}${a.name}${a.description ? ` — ${a.description}` : ""}`)
            .join("\n");
          addLocalLine(lines);
        }
        return;
      }
      if (text.startsWith("/agent ")) {
        const name = text.slice("/agent ".length).trim();
        if (!name) {
          addLocalLine("Usage: /agent <name>");
          return;
        }
        switchAgent(name);
        return;
      }
      if (text === "/log") {
        if (staticLines.length === 0 && !streamingLine) {
          addLocalLine("No conversation to log yet.");
        } else {
          dumpLog().then((path) => {
            addLocalLine(`Log saved to: ${path}`);
          }).catch((err: unknown) => {
            addLocalLine(`Failed to save log: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        return;
      }
      sendMessage(text);
    },
    [exit, resetConversation, switchAgent, skills, agents, sendMessage, addLocalLine, dumpLog, staticLines, streamingLine],
  );

  const handleUndo = useCallback(() => {
    const text = undoLastTurn();
    if (text !== null) {
      setRestoreText(text);
    }
  }, [undoLastTurn]);

  const inputDisabled = connection !== "connected";
  const hasMessages = staticLines.length > 0 || streamingLine !== null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {!hasMessages && banner.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {banner.map((line, i) => (
            <Text key={i} color="cyan" bold>{line}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginBottom={1}>
        {!hasMessages && connection === "connecting" ? (
          <LoadingSpinner label="Connecting…" />
        ) : !hasMessages ? (
          <Box flexDirection="column">
            <Text dimColor>
              Active agent: <Text color="cyan">{activeAgent || "—"}</Text>. Type a message and press Enter. Type / to see commands. Esc to undo.
            </Text>
            {agentFallback ? (
              <Text color="yellow">
                {`Configured agent "${agentFallback.requested}" not found, using built-in "${agentFallback.active}".`}
              </Text>
            ) : null}
          </Box>
        ) : (
          <>
            <Static items={staticLines}>
              {(line) => (
                <Box key={line.id}>
                  <MessageLine line={line} />
                </Box>
              )}
            </Static>
            {streamingLine ? (
              <MessageLine
                line={streamingLine}
                showThinking={waitingForReply}
                streaming={streaming && !waitingForReply}
                turnStartMs={turnStartMs}
              />
            ) : waitingForReply ? (
              <LoadingSpinner label="Thinking…" startMs={turnStartMs ?? undefined} />
            ) : null}
          </>
        )}
      </Box>

      {error ? <Text color="red">{error}</Text> : null}
      {queuedMessages.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {queuedMessages.map((msg) => (
            <Text key={msg.id} dimColor wrap="truncate-end">
              {"· "}
              {msg.text}
            </Text>
          ))}
        </Box>
      ) : null}

      <ChatInput
        disabled={inputDisabled}
        commands={commands}
        restoreText={restoreText}
        onRestoreConsumed={() => setRestoreText(null)}
        onSubmit={handleSubmit}
        onUndo={handleUndo}
      />
    </Box>
  );
}
