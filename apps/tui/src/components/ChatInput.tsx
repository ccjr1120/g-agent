import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { BlinkingCursor } from "./BlinkingCursor.js";

const DEFAULT_MAX_MENU_ITEMS = 8;
const MIN_MAX_MENU_ITEMS = 5;
const MAX_MAX_MENU_ITEMS = 16;

export type SlashCommand = {
  value: string;
  description: string;
  category: string;
};

export type SlashCommandGroups = Record<string, SlashCommand[]>;

const GROUP_TRIGGERS = ["/skills", "/agent", "/mcp", "/resume"] as const;

function resolveMenuItems(
  value: string,
  commands: SlashCommand[],
  groups: SlashCommandGroups,
): SlashCommand[] {
  if (!value.startsWith("/") || value.includes(" ")) {
    return [];
  }

  for (const trigger of GROUP_TRIGGERS) {
    if (value === trigger) {
      const header = commands.find((cmd) => cmd.value === trigger);
      const children = groups[trigger] ?? [];
      return header ? [header, ...children] : children;
    }
  }

  const topMatches = commands.filter((cmd) =>
    cmd.value.toLowerCase().startsWith(value.toLowerCase()),
  );

  if (value.length <= 1) {
    return topMatches;
  }

  const childMatches: SlashCommand[] = [];
  for (const children of Object.values(groups)) {
    for (const cmd of children) {
      if (cmd.value.toLowerCase().startsWith(value.toLowerCase())) {
        childMatches.push(cmd);
      }
    }
  }

  if (childMatches.length === 0) {
    return topMatches;
  }

  const seen = new Set<string>();
  const merged: SlashCommand[] = [];
  for (const cmd of [...topMatches, ...childMatches]) {
    if (seen.has(cmd.value)) continue;
    seen.add(cmd.value);
    merged.push(cmd);
  }
  return merged;
}

export function ChatInput({
  disabled,
  commands = [],
  commandGroups = {},
  maxMenuItems = DEFAULT_MAX_MENU_ITEMS,
  restoreText,
  onRestoreConsumed,
  onSubmit,
  onUndo,
}: {
  disabled: boolean;
  commands?: SlashCommand[];
  commandGroups?: SlashCommandGroups;
  maxMenuItems?: number;
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

  const menuLimit = Math.max(
    MIN_MAX_MENU_ITEMS,
    Math.min(MAX_MAX_MENU_ITEMS, maxMenuItems),
  );

  const isMenuOpen = value.startsWith("/") && !value.includes(" ");

  const matchedCommands = useMemo(
    () => resolveMenuItems(value, commands, commandGroups),
    [value, commands, commandGroups],
  );

  const clampedMenuIndex = matchedCommands.length > 0
    ? Math.min(menuIndex, matchedCommands.length - 1)
    : 0;
  const windowStart = Math.max(
    0,
    Math.min(
      clampedMenuIndex - menuLimit + 1,
      Math.max(0, matchedCommands.length - menuLimit),
    ),
  );
  const visibleCommands = matchedCommands.slice(
    windowStart,
    windowStart + menuLimit,
  );
  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(0, matchedCommands.length - windowStart - visibleCommands.length);

  useEffect(() => {
    setMenuIndex(0);
  }, [value]);

  const menuRows = visibleCommands.flatMap((cmd, index) => {
    const previous = visibleCommands[index - 1];
    const commandIndex = windowStart + index;
    return previous?.category === cmd.category
      ? [{ type: "command" as const, command: cmd, index: commandIndex }]
      : [
          { type: "category" as const, label: cmd.category },
          { type: "command" as const, command: cmd, index: commandIndex },
        ];
  });

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

  const expandGroup = useCallback((trigger: string) => {
    setValue(trigger);
    setMenuIndex(0);
  }, []);

  useInput(
    (input, key) => {
      if (disabled) return;

      if (isMenuOpen && matchedCommands.length > 0) {
        if (key.upArrow) {
          setMenuIndex((i) => (i <= 0 ? matchedCommands.length - 1 : i - 1));
          return;
        }

        if (key.downArrow) {
          setMenuIndex((i) => (i >= matchedCommands.length - 1 ? 0 : i + 1));
          return;
        }

        if (key.return) {
          const selected = matchedCommands[clampedMenuIndex];
          if (!selected) {
            return;
          }

          const isGroupTrigger = GROUP_TRIGGERS.includes(
            selected.value as (typeof GROUP_TRIGGERS)[number],
          );
          const hasGroupChildren = (commandGroups[selected.value]?.length ?? 0) > 0;

          if (isGroupTrigger && hasGroupChildren && value !== selected.value) {
            expandGroup(selected.value);
            return;
          }

          submit(selected.value);
          return;
        }

        if (key.escape) {
          if (GROUP_TRIGGERS.includes(value as (typeof GROUP_TRIGGERS)[number])) {
            setValue("/");
            setMenuIndex(0);
            return;
          }
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
    <Box flexDirection="column" flexShrink={0}>
      {isMenuOpen && visibleCommands.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {hiddenAbove > 0 ? (
            <Text color="gray" dimColor>
              {`↑ ${hiddenAbove} more — use ↑↓ to scroll`}
            </Text>
          ) : null}
          {menuRows.map((row) => {
            if (row.type === "category") {
              return (
                <Box key={`category-${row.label}`}>
                  <Text color="gray" bold>
                    {row.label}
                  </Text>
                </Box>
              );
            }

            const selected = row.index === clampedMenuIndex;
            const cmd = row.command;
            return (
              <Box key={`${cmd.category}-${cmd.value}-${cmd.description}`}>
                <Box flexShrink={0} marginRight={2}>
                  <Text color={selected ? "cyan" : "white"} bold={selected}>
                    {cmd.value}
                  </Text>
                </Box>
                {cmd.description ? (
                  <Box flexGrow={1} minWidth={0}>
                    <Text color="gray" wrap="truncate-end">
                      {cmd.description}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
          {hiddenBelow > 0 ? (
            <Text color="gray" dimColor>
              {`↓ ${hiddenBelow} more — use ↑↓ to scroll`}
            </Text>
          ) : null}
        </Box>
      )}
      <Box
        flexDirection="column"
        width="100%"
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        paddingX={1}
      >
        {inputElement}
      </Box>
    </Box>
  );
}
