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

function matchingCommands(value: string, commands: SlashCommand[]): SlashCommand[] {
  const query = value.toLowerCase();
  return commands.filter((command) => command.value.toLowerCase().startsWith(query));
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
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  useEffect(() => {
    if (restoreText === undefined || restoreText === null) return;
    setValue(restoreText);
    setHistoryIndex(-1);
    onRestoreConsumed?.();
  }, [restoreText, onRestoreConsumed]);

  const menuLimit = Math.max(
    MIN_MAX_MENU_ITEMS,
    Math.min(MAX_MAX_MENU_ITEMS, maxMenuItems),
  );
  const isMenuOpen = value.startsWith("/") && !value.includes(" ");
  const rootItems = useMemo(
    () => matchingCommands(value, commands),
    [commands, value],
  );
  const activeRoot = openGroup
    ? commands.find((command) => command.value === openGroup)
    : undefined;
  const menuItems = useMemo(() => {
    if (!openGroup || !activeRoot) return rootItems;
    // Keep the group command as the first item so users can still choose the
    // original "list all" action without entering a persistent input mode.
    return [activeRoot, ...(commandGroups[openGroup] ?? [])];
  }, [activeRoot, commandGroups, openGroup, rootItems]);
  const selectedIndex = menuItems.length === 0
    ? 0
    : Math.min(menuIndex, menuItems.length - 1);
  const windowStart = Math.max(
    0,
    Math.min(
      selectedIndex - menuLimit + 1,
      Math.max(0, menuItems.length - menuLimit),
    ),
  );
  const visibleItems = menuItems.slice(windowStart, windowStart + menuLimit);

  useEffect(() => {
    setMenuIndex(0);
    setOpenGroup(null);
  }, [value]);

  const closeMenu = useCallback(() => {
    setMenuIndex(0);
    setOpenGroup(null);
  }, []);

  const submit = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed || disabled) return;
    setHistory((previous) => previous.at(-1) === trimmed
      ? previous
      : [...previous, trimmed]);
    setHistoryIndex(-1);
    setValue("");
    closeMenu();
    onSubmit(trimmed);
  }, [closeMenu, disabled, onSubmit]);

  useInput((input, key) => {
    if (disabled) return;

    if (isMenuOpen && menuItems.length > 0) {
      if (key.upArrow || key.downArrow) {
        const delta = key.upArrow ? -1 : 1;
        setMenuIndex((current) =>
          ((current + delta) % menuItems.length + menuItems.length) % menuItems.length,
        );
        return;
      }

      if (key.return) {
        const selected = menuItems[selectedIndex];
        if (!selected) return;
        const children = commandGroups[selected.value] ?? [];
        if (!openGroup && children.length > 0) {
          setOpenGroup(selected.value);
          setMenuIndex(0);
        } else {
          submit(selected.value);
        }
        return;
      }

      if (key.escape) {
        if (openGroup) {
          setOpenGroup(null);
          setMenuIndex(0);
        } else {
          setValue("");
          closeMenu();
        }
        return;
      }
    }

    if (!isMenuOpen && key.escape) {
      onUndo?.();
      return;
    }

    if (!isMenuOpen && (key.upArrow || key.downArrow)) {
      if (key.upArrow) {
        if (history.length === 0) return;
        const nextIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(nextIndex);
        setValue(history[history.length - 1 - nextIndex] ?? "");
      } else if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setValue("");
      } else {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setValue(history[history.length - 1 - nextIndex] ?? "");
      }
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
      closeMenu();
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setHistoryIndex(-1);
      setValue((current) => current + input);
    }
  }, { isActive: !disabled });

  const lines = value.split("\n");
  const inputElement = value ? (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`} wrap="wrap" color="cyan">
          {index === 0 ? "> " : "  "}
          {line}
          {index === lines.length - 1 ? <BlinkingCursor /> : null}
        </Text>
      ))}
    </Box>
  ) : (
    <Text color="cyan">{"> "}<BlinkingCursor /></Text>
  );

  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(0, menuItems.length - windowStart - visibleItems.length);
  const menuElement = isMenuOpen && visibleItems.length > 0 ? (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>
        {openGroup
          ? `${openGroup} · ↑↓ select · Enter run · Esc back`
          : "Commands · ↑↓ select · Enter open/run · Esc close"}
      </Text>
      {hiddenAbove > 0 ? <Text dimColor>{`↑ ${hiddenAbove} more`}</Text> : null}
      {visibleItems.map((command, index) => {
        const absoluteIndex = windowStart + index;
        const selected = absoluteIndex === selectedIndex;
        const hasChildren = !openGroup && (commandGroups[command.value]?.length ?? 0) > 0;
        return (
          <Box key={`${command.category}-${command.value}-${absoluteIndex}`}>
            <Text color={selected ? "cyan" : "white"} bold={selected}>
              {selected ? "❯ " : "  "}{command.value}{hasChildren ? " ›" : ""}
            </Text>
            <Box marginLeft={2} flexGrow={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{command.description}</Text>
            </Box>
          </Box>
        );
      })}
      {hiddenBelow > 0 ? <Text dimColor>{`↓ ${hiddenBelow} more`}</Text> : null}
    </Box>
  ) : null;

  return (
    <Box flexDirection="column-reverse" flexShrink={0}>
      <Box
        flexDirection="column"
        width="100%"
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        paddingX={1}
        flexShrink={0}
      >
        {inputElement}
      </Box>
      {menuElement ? (
        <Box
          flexDirection="column"
          height={menuLimit + 3}
          justifyContent="flex-end"
          overflow="hidden"
          flexShrink={0}
        >
          {menuElement}
        </Box>
      ) : null}
    </Box>
  );
}
