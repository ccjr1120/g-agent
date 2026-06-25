import React from "react";
import { Box, Text } from "ink";
import { LoadingSpinner } from "./LoadingSpinner.js";
import { MessageContent } from "./MessageContent.js";
import type { ChatLine } from "../hooks/useAgentSocket.js";

const TOOL_ICONS: Record<string, string> = {
  bash: "🐚",
  read: "📖",
  write: "📝",
  glob: "📁",
  grep: "🔍",
};

function toolIcon(name: string): string {
  return TOOL_ICONS[name] ?? "🔧";
}

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

  const hasTools = (line.tools?.length ?? 0) > 0;
  const hasText = line.text.trim().length > 0;

  if (!hasTools && !hasText) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {hasTools ? (
        <Box flexDirection="column" marginBottom={hasText ? 1 : 0}>
          {line.tools?.map((tool, index) => (
            <Text key={`${tool.name}-${index}`} dimColor wrap="truncate">
              {`${toolIcon(tool.name)} ${tool.label}`}
            </Text>
          ))}
        </Box>
      ) : null}
      {hasText ? <MessageContent role={line.role} text={line.text} /> : null}
    </Box>
  );
}
