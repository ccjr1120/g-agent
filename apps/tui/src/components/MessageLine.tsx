import React from "react";
import { Box } from "ink";
import { LoadingSpinner } from "./LoadingSpinner.js";
import { MessageContent } from "./MessageContent.js";
import type { ChatLine } from "../hooks/useAgentSocket.js";

export function MessageLine({
  line,
  streaming = false,
  showThinking = false,
}: {
  line: ChatLine;
  streaming?: boolean;
  showThinking?: boolean;
}) {
  if (showThinking) {
    return <LoadingSpinner label="Thinking…" />;
  }

  const gapAfter = !streaming;

  return (
    <Box marginBottom={gapAfter ? 1 : 0}>
      <MessageContent role={line.role} text={line.text} streaming={streaming} />
    </Box>
  );
}
