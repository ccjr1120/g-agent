import React from "react";
import { Text } from "ink";

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

  return <Text wrap="wrap">{text}</Text>;
}
