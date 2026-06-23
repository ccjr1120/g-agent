import React from "react";
import { Box } from "ink";
import { LoadingSpinner } from "./LoadingSpinner.js";
import { MessageContent } from "./MessageContent.js";
import type { ChatLine } from "../hooks/useAgentSocket.js";

export function MessageLine({
  line,
  showThinking = false,
}: {
  line: ChatLine;
  showThinking?: boolean;
}) {
  if (showThinking) {
    return <LoadingSpinner label="Thinking…" />;
  }

  return (
    <Box marginBottom={1}>
      <MessageContent role={line.role} text={line.text} />
    </Box>
  );
}
