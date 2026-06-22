import React from "react";
import { Text } from "ink";

export function MessageContent({
  role,
  text,
  streaming = false,
}: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}) {
  if (!text && streaming) {
    return null;
  }

  return (
    <Text wrap="wrap" color={role === "user" ? "cyan" : undefined}>
      {role === "user" ? "> " : ""}
      {text}
    </Text>
  );
}
