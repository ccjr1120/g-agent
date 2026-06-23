import React, { useCallback, useMemo } from "react";
import { Box, Static, Text, useApp } from "ink";import { ChatInput, type SlashCommand } from "./components/ChatInput.js";
import { LoadingSpinner } from "./components/LoadingSpinner.js";
import { MessageLine } from "./components/MessageLine.js";
import { useAgentSocket } from "./hooks/useAgentSocket.js";

export function App({ serverUrl }: { serverUrl: string }) {
  const { exit } = useApp();
  const {
    connection,
    staticLines,
    streamingLine,
    streaming,
    pending,
    waitingForReply,
    error,
    skills,
    sendMessage,
    addLocalLine,
    resetConversation,
    dumpLog,
  } = useAgentSocket(serverUrl);

  const commands = useMemo<SlashCommand[]>(() => [
    { value: "/skills", description: "列出已加载的技能" },
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
    [exit, resetConversation, skills, sendMessage, addLocalLine, dumpLog, staticLines, streamingLine],
  );

  const inputDisabled = connection !== "connected" || streaming || pending;
  const hasMessages = staticLines.length > 0 || streamingLine !== null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        {!hasMessages && connection === "connecting" ? (
          <LoadingSpinner label="Connecting…" />
        ) : !hasMessages ? (
          <Text dimColor>Type a message and press Enter. Type / to see commands.</Text>
        ) : (
          <>
            <Static items={staticLines}>
              {(line) => <MessageLine key={line.id} line={line} />}
            </Static>
            {streamingLine ? (
              <MessageLine
                line={streamingLine}
                streaming={streaming}
                showThinking={waitingForReply && !streamingLine.text}
              />
            ) : null}
          </>
        )}
      </Box>

      {error ? <Text color="red">{error}</Text> : null}

      <ChatInput disabled={inputDisabled} commands={commands} onSubmit={handleSubmit} />
    </Box>
  );
}
