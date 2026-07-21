import React from "react";
import { Box, Text } from "ink";
import { formatElapsed, LoadingSpinner } from "./LoadingSpinner.js";
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

export const MessageLine = React.memo(function MessageLine({
  line,
  showThinking = false,
  streaming = false,
  turnStartMs,
}: {
  line: ChatLine;
  showThinking?: boolean;
  streaming?: boolean;
  turnStartMs?: number | null;
}) {
  if (showThinking) {
    return <LoadingSpinner label="Thinking…" startMs={turnStartMs ?? undefined} />;
  }

  const hasTools = (line.tools?.length ?? 0) > 0;
  const hasText = line.text.trim().length > 0;

  if (!hasTools && !hasText) {
    return null;
  }

  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
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
      <TimingFootnote
        streaming={streaming}
        turnStartMs={turnStartMs}
        finalMs={line.durationMs}
      />
    </Box>
  );
});

function TimingFootnote({
  streaming,
  turnStartMs,
  finalMs,
}: {
  streaming: boolean;
  turnStartMs?: number | null;
  finalMs?: number;
}) {
  // One blank line between the reply content and the timing line, present in
  // both the streaming and finished states so the streaming→done transition
  // doesn't shift. The spinner re-renders on its own interval and recomputes
  // the elapsed value from turnStartMs, so the time stays live here.
  if (streaming) {
    return (
      <Box marginTop={1}>
        <LoadingSpinner label="" dim startMs={turnStartMs ?? undefined} />
      </Box>
    );
  }

  // Once committed, leave a subtle final duration with a leading `· ` so the
  // icon (col 1) and the value (col 3) align with the assistant `❯` gutter
  // and content above.
  if (finalMs !== undefined && finalMs > 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>{`· ${formatElapsed(finalMs)}`}</Text>
      </Box>
    );
  }

  return null;
}
