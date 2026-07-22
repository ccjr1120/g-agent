import React, { useMemo, useRef } from "react";
import { Box, Text } from "ink";
import { StreamMarkdown } from "ink-stream-markdown";
import { contentHash } from "../lib/contentHash.js";
import { hasMarkdownSyntax, splitStreamingMarkdown } from "../lib/streamingMarkdown.js";

const StableMarkdown = React.memo(function StableMarkdown({
  text,
  width,
}: {
  text: string;
  width: number;
}) {
  const theme = useMemo(() => ({ width }), [width]);
  if (!text) return null;
  if (!hasMarkdownSyntax(text)) {
    return <StreamMarkdown theme={theme}>{text}</StreamMarkdown>;
  }
  return <StreamMarkdown theme={theme}>{text}</StreamMarkdown>;
});

function StreamingAssistantMarkdown({
  text,
  width,
}: {
  text: string;
  width: number;
}) {
  const stablePrefixRef = useRef("");
  const split = splitStreamingMarkdown(text, stablePrefixRef.current);
  if (split.stablePrefix.length >= stablePrefixRef.current.length) {
    stablePrefixRef.current = split.stablePrefix;
  }

  const theme = useMemo(() => ({ width }), [width]);
  const stableKey = contentHash(stablePrefixRef.current);

  return (
    <Box flexDirection="column">
      {stablePrefixRef.current ? (
        <StableMarkdown key={stableKey} text={stablePrefixRef.current} width={width} />
      ) : null}
      {split.unstableSuffix ? (
        <StreamMarkdown theme={theme}>{split.unstableSuffix}</StreamMarkdown>
      ) : null}
    </Box>
  );
}

export function MessageContent({
  role,
  text,
  streaming = false,
}: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}) {
  const markdownWidth = Math.max(20, (process.stdout.columns ?? 80) - 4);

  if (!text) {
    return null;
  }

  if (role === "user") {
    return (
      <Text wrap="wrap" color="cyan">
        {"> "}
        {text}
      </Text>
    );
  }

  return (
    <Box>
      <Text>{"❯ "}</Text>
      <Box flexGrow={1} minWidth={0}>
        {streaming ? (
          <StreamingAssistantMarkdown text={text} width={markdownWidth} />
        ) : (
          <StableMarkdown text={text} width={markdownWidth} />
        )}
      </Box>
    </Box>
  );
}
