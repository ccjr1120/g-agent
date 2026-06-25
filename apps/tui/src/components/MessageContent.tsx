import React from "react";
import { Box, Text } from "ink";

export function MessageContent({
  role,
  text,
}: {
  role: "user" | "assistant";
  text: string;
}) {
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

  // `❯ ` (icon + space = 2 cols) places the content at col 3, so wrapped
  // continuation lines align under the first line's content rather than
  // under the icon. flexGrow + minWidth=0 lets the content box take the
  // remaining width and wrap against it without overflowing on long tokens.
  return (
    <Box>
      <Text>{"❯ "}</Text>
      <Box flexGrow={1} minWidth={0}>
        <Text wrap="wrap">{text}</Text>
      </Box>
    </Box>
  );
}
