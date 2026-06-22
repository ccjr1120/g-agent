import React from "react";
import { Box, Static, Text } from "ink";
import { ChatInput } from "./components/ChatInput.js";
import { LoadingSpinner } from "./components/LoadingSpinner.js";
import { MessageLine } from "./components/MessageLine.js";
import { useAgentSocket } from "./hooks/useAgentSocket.js";

export function App({ serverUrl }: { serverUrl: string }) {
  const {
    connection,
    staticLines,
    streamingLine,
    streaming,
    pending,
    waitingForReply,
    error,
    sendMessage,
  } = useAgentSocket(serverUrl);

  const inputDisabled = connection !== "connected" || streaming || pending;
  const hasMessages = staticLines.length > 0 || streamingLine !== null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        {!hasMessages && connection === "connecting" ? (
          <LoadingSpinner label="Connecting…" />
        ) : !hasMessages ? (
          <Text dimColor>Type a message and press Enter.</Text>
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

      <ChatInput disabled={inputDisabled} onSubmit={sendMessage} />
    </Box>
  );
}
