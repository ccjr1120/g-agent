import React from "react";
import { Text, useStdout } from "ink";
import { StreamMarkdown } from "ink-stream-markdown";

export function MessageContent({
  role,
  text,
}: {
  role: "user" | "assistant";
  text: string;
}) {
  const { stdout } = useStdout();
  const width = stdout.columns ?? 80;

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
    <StreamMarkdown theme={{ width: Math.max(width, 40) }}>
      {text}
    </StreamMarkdown>
  );
}
