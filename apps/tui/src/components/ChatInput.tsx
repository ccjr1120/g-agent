import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { BlinkingCursor } from "./BlinkingCursor.js";

export type SlashCommand = {
  value: string;
  description: string;
};

export function ChatInput({
  disabled,
  commands = [],
  restoreText,
  onRestoreConsumed,
  onSubmit,
  onUndo,
}: {
  disabled: boolean;
  commands?: SlashCommand[];
  restoreText?: string | null;
  onRestoreConsumed?: () => void;
  onSubmit: (text: string) => void;
  onUndo?: () => void;
}) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [menuIndex, setMenuIndex] = useState(0);

  useEffect(() => {
    if (restoreText === undefined || restoreText === null) {
      return;
    }
    setValue(restoreText);
    setHistoryIndex(-1);
    onRestoreConsumed?.();
  }, [restoreText, onRestoreConsumed]);

  const isMenuOpen = value.startsWith("/") && !value.includes(" ");

  const filteredCommands = isMenuOpen
    ? commands.filter((cmd) =>
        cmd.value.startsWith(value.toLowerCase()),
      )
    : [];

  const clampedMenuIndex = filteredCommands.length > 0
    ? Math.min(menuIndex, filteredCommands.length - 1)
    : 0;

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
      setMenuIndex(0);
    },
    [disabled, onSubmit],
  );

  useInput(
    (input, key) => {
      if (disabled) return;

      if (isMenuOpen && filteredCommands.length > 0) {
        if (key.upArrow) {
          setMenuIndex((i) => (i <= 0 ? filteredCommands.length - 1 : i - 1));
          return;
        }

        if (key.downArrow) {
          setMenuIndex((i) => (i >= filteredCommands.length - 1 ? 0 : i + 1));
          return;
        }

        if (key.return) {
          const selected = filteredCommands[clampedMenuIndex];
          if (selected) {
            submit(selected.value);
          }
          return;
        }

        if (key.escape) {
          setValue("");
          setMenuIndex(0);
          return;
        }
      }

      if (!isMenuOpen && key.escape) {
        onUndo?.();
        return;
      }

      if (!isMenuOpen) {
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
        setValue((current) => {
          const next = current.slice(0, -1);
          if (!next.startsWith("/")) setMenuIndex(0);
          return next;
        });
        return;
      }

      if (key.ctrl && input === "u") {
        setValue("");
        setMenuIndex(0);
        return;
      }

      if (!key.ctrl && !key.meta && input) {
        setHistoryIndex(-1);
        setValue((current) => {
          const next = current + input;
          if (!next.startsWith("/")) setMenuIndex(0);
          return next;
        });
      }
    },
    { isActive: !disabled },
  );

  const inputElement = (() => {
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
  })();

  return (
    <Box flexDirection="column">
      {isMenuOpen && filteredCommands.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          {filteredCommands.map((cmd, i) => {
            const selected = i === clampedMenuIndex;
            return (
              <Box key={cmd.value} marginBottom={1}>
                <Text color={selected ? "cyan" : "white"} bold={selected}>
                  {cmd.value}
                </Text>
                {cmd.description ? (
                  <Text color="gray">{"  "}{cmd.description}</Text>
                ) : null}
              </Box>
            );
          })}
        </Box>
      )}
      {inputElement}
    </Box>
  );
}
