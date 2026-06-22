import React, { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import { BlinkingCursor } from "./BlinkingCursor.js";

export function ChatInput({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const submit = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || disabled) return;

      setHistory((prev) => {
        if (prev.at(-1) === trimmed) return prev;
        return [...prev, trimmed];
      });
      setHistoryIndex(-1);
      onSubmit(trimmed);
      setValue("");
    },
    [disabled, onSubmit],
  );

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.upArrow) {
        if (history.length === 0) return;
        const nextIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(nextIndex);
        setValue(history[history.length - 1 - nextIndex] ?? "");
        return;
      }

      if (key.downArrow) {
        if (historyIndex <= 0) {
          setHistoryIndex(-1);
          setValue("");
          return;
        }
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setValue(history[history.length - 1 - nextIndex] ?? "");
        return;
      }

      if (key.return && key.shift) {
        setValue((current) => `${current}\n`);
        return;
      }

      if (key.return) {
        submit(value);
        return;
      }

      if (key.backspace || key.delete) {
        setValue((current) => current.slice(0, -1));
        return;
      }

      if (key.ctrl && input === "u") {
        setValue("");
        return;
      }

      if (!key.ctrl && !key.meta && input) {
        setHistoryIndex(-1);
        setValue((current) => current + input);
      }
    },
    { isActive: !disabled },
  );

  if (disabled) {
    return (
      <Text dimColor>{"> Waiting…"}</Text>
    );
  }

  if (!value) {
    return (
      <Text color="cyan">
        {"> "}
        <BlinkingCursor />
      </Text>
    );
  }

  const lines = value.split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const isLast = index === lines.length - 1;

        return (
          <Text key={`${index}-${line}`} wrap="wrap" color="cyan">
            {index === 0 ? "> " : "  "}
            {line}
            {isLast ? <BlinkingCursor /> : null}
          </Text>
        );
      })}
    </Box>
  );
}
