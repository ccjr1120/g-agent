import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import stringWidth from "string-width";
import { BlinkingCursor } from "./BlinkingCursor.js";
import { blockTranscriptScrollRef } from "../lib/inputFocus.js";

const DEFAULT_MAX_MENU_ITEMS = 8;
const MIN_MAX_MENU_ITEMS = 5;
const MAX_MAX_MENU_ITEMS = 16;
const MAX_DESCRIPTION_LINES = 2;
const COMMAND_COLUMN_MIN_RATIO = 0.4;
const MENU_HORIZONTAL_PADDING = 2;
const MIN_DESCRIPTION_WIDTH = 24;

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

function previousCharacterIndex(value: string, cursorIndex: number): number {
  const previousCharacter = Array.from(value.slice(0, cursorIndex)).at(-1);
  return previousCharacter ? cursorIndex - previousCharacter.length : cursorIndex;
}

function nextCharacterIndex(value: string, cursorIndex: number): number {
  const nextCharacter = Array.from(value.slice(cursorIndex))[0];
  return nextCharacter ? cursorIndex + nextCharacter.length : cursorIndex;
}

function commandHasChildren(
  command: SlashCommand,
  openGroup: string | null,
  commandGroups: SlashCommandGroups,
): boolean {
  return !openGroup && (commandGroups[command.value]?.length ?? 0) > 0;
}

function commandLabel(
  command: SlashCommand,
  selected: boolean,
  hasChildren: boolean,
): string {
  const prefix = selected ? "❯ " : "  ";
  return `${prefix}${command.value}${hasChildren ? " ›" : ""}`;
}

function truncateToWidth(text: string, maxWidth: number, ellipsis = ""): string {
  if (stringWidth(text) <= maxWidth) {
    return text;
  }

  const target = maxWidth - stringWidth(ellipsis);
  let result = "";
  for (const char of text) {
    if (stringWidth(result + char) > target) {
      break;
    }
    result += char;
  }
  return `${result}${ellipsis}`;
}

function wrapDescription(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || !text) {
    return text ? [text] : [""];
  }

  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex]!;
    const candidate = current ? `${current} ${word}` : word;

    if (stringWidth(candidate) <= width) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(truncateToWidth(word, width, "…"));
      current = "";
    }

    if (lines.length >= maxLines) {
      const rest = current
        ? [current, ...words.slice(wordIndex + 1)].join(" ")
        : words.slice(wordIndex + 1).join(" ");
      if (rest.trim()) {
        lines[maxLines - 1] = truncateToWidth(
          `${lines[maxLines - 1] ?? ""} ${rest}`.trim(),
          width,
          "…",
        );
      }
      return lines.slice(0, maxLines);
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines.slice(0, maxLines);
}

function commandColumnWidth(
  menuItems: SlashCommand[],
  openGroup: string | null,
  commandGroups: SlashCommandGroups,
  terminalColumns: number,
): number {
  const availableWidth = terminalColumns - MENU_HORIZONTAL_PADDING;

  if (menuItems.length === 0) {
    return Math.floor(availableWidth * COMMAND_COLUMN_MIN_RATIO);
  }

  const maxLabelWidth = menuItems.reduce((max, command) => {
    const hasChildren = commandHasChildren(command, openGroup, commandGroups);
    const label = `${command.value}${hasChildren ? " ›" : ""}`;
    return Math.max(max, stringWidth(label) + 2);
  }, 0);

  const minCommandWidth = Math.min(
    Math.floor(availableWidth * COMMAND_COLUMN_MIN_RATIO),
    availableWidth - MIN_DESCRIPTION_WIDTH,
  );
  const maxCommandWidth = availableWidth - MIN_DESCRIPTION_WIDTH;

  return Math.max(minCommandWidth, Math.min(maxLabelWidth, maxCommandWidth));
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
  const [cursorIndex, setCursorIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [menuIndex, setMenuIndex] = useState(0);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const { columns: terminalColumns = process.stdout.columns ?? 80, rows: terminalRows = 24 } = useWindowSize();

  useEffect(() => {
    if (restoreText === undefined || restoreText === null) return;
    setValue(restoreText);
    setCursorIndex(restoreText.length);
    setHistoryIndex(-1);
    onRestoreConsumed?.();
  }, [restoreText, onRestoreConsumed]);

  const menuLimit = Math.max(
    MIN_MAX_MENU_ITEMS,
    Math.min(MAX_MAX_MENU_ITEMS, maxMenuItems),
  );
  const isMenuOpen = value.startsWith("/") && !value.includes(" ");
  useEffect(() => {
    blockTranscriptScrollRef.current = isMenuOpen;
  }, [isMenuOpen]);
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
  const availableWidth = terminalColumns - MENU_HORIZONTAL_PADDING;
  const commandWidth = commandColumnWidth(
    menuItems,
    openGroup,
    commandGroups,
    terminalColumns,
  );
  const descriptionWidth = Math.max(10, availableWidth - commandWidth);
  const menuMaxHeight = Math.min(
    menuLimit * MAX_DESCRIPTION_LINES + 3,
    Math.max(10, terminalRows - 12),
  );

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
    setCursorIndex(0);
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
          setCursorIndex(0);
          closeMenu();
        }
        return;
      }
    }

    if (!isMenuOpen && key.escape) {
      onUndo?.();
      return;
    }

    if (!isMenuOpen && key.ctrl && (input === "p" || input === "n")) {
      if (input === "p") {
        if (history.length === 0) return;
        const nextIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(nextIndex);
        const nextValue = history[history.length - 1 - nextIndex] ?? "";
        setValue(nextValue);
        setCursorIndex(nextValue.length);
      } else if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setValue("");
        setCursorIndex(0);
      } else {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        const nextValue = history[history.length - 1 - nextIndex] ?? "";
        setValue(nextValue);
        setCursorIndex(nextValue.length);
      }
      return;
    }

    if (key.leftArrow) {
      setCursorIndex((current) => previousCharacterIndex(value, current));
      return;
    }
    if (key.rightArrow) {
      setCursorIndex((current) => nextCharacterIndex(value, current));
      return;
    }
    if (!key.ctrl && key.home) {
      const lineStart = value.lastIndexOf("\n", Math.max(0, cursorIndex - 1)) + 1;
      setCursorIndex(lineStart);
      return;
    }
    if (!key.ctrl && key.end) {
      const nextLineBreak = value.indexOf("\n", cursorIndex);
      setCursorIndex(nextLineBreak === -1 ? value.length : nextLineBreak);
      return;
    }

    if (key.return && key.shift) {
      setValue((current) =>
        `${current.slice(0, cursorIndex)}\n${current.slice(cursorIndex)}`,
      );
      setCursorIndex((current) => current + 1);
      return;
    }
    if (key.return) {
      submit(value);
      return;
    }
    if (key.backspace) {
      if (cursorIndex === 0) return;
      const previousIndex = previousCharacterIndex(value, cursorIndex);
      setValue((current) =>
        current.slice(0, previousIndex) + current.slice(cursorIndex),
      );
      setCursorIndex(previousIndex);
      return;
    }
    if (key.delete) {
      if (cursorIndex === value.length) return;
      const nextIndex = nextCharacterIndex(value, cursorIndex);
      setValue((current) =>
        current.slice(0, cursorIndex) + current.slice(nextIndex),
      );
      return;
    }
    if (key.ctrl && input === "u") {
      setValue("");
      setCursorIndex(0);
      closeMenu();
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setHistoryIndex(-1);
      setValue((current) =>
        current.slice(0, cursorIndex) + input + current.slice(cursorIndex),
      );
      setCursorIndex((current) => current + input.length);
    }
  }, { isActive: !disabled });

  const lines = value.split("\n");
  const textBeforeCursor = value.slice(0, cursorIndex);
  const cursorLineIndex = textBeforeCursor.split("\n").length - 1;
  const cursorColumn = textBeforeCursor.length - (textBeforeCursor.lastIndexOf("\n") + 1);
  const inputElement = value ? (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`${index}-${line}`} wrap="wrap" color="cyan">
          {index === 0 ? "> " : "  "}
          {index === cursorLineIndex ? line.slice(0, cursorColumn) : line}
          {index === cursorLineIndex ? <BlinkingCursor /> : null}
          {index === cursorLineIndex ? line.slice(cursorColumn) : null}
        </Text>
      ))}
    </Box>
  ) : (
    <Text color="cyan">{"> "}<BlinkingCursor /></Text>
  );

  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(0, menuItems.length - windowStart - visibleItems.length);
  const menuElement = isMenuOpen && visibleItems.length > 0 ? (
    <Box flexDirection="column" paddingX={1} width={terminalColumns}>
      <Text dimColor>
        {openGroup
          ? `${openGroup} · ↑↓ select · Enter run · Esc back`
          : "Commands · ↑↓ select · Enter open/run · Esc close"}
      </Text>
      {hiddenAbove > 0 ? <Text dimColor>{`↑ ${hiddenAbove} more`}</Text> : null}
      {visibleItems.map((command, index) => {
        const absoluteIndex = windowStart + index;
        const selected = absoluteIndex === selectedIndex;
        const hasChildren = commandHasChildren(command, openGroup, commandGroups);
        const descriptionLines = wrapDescription(
          command.description,
          descriptionWidth,
          MAX_DESCRIPTION_LINES,
        );
        return (
          <Box
            key={`${command.category}-${command.value}-${absoluteIndex}`}
            flexDirection="row"
            width={availableWidth}
          >
            <Box width={commandWidth} flexShrink={0}>
              <Text color={selected ? "cyan" : "white"} bold={selected}>
                {commandLabel(command, selected, hasChildren)}
              </Text>
            </Box>
            <Box flexGrow={1} minWidth={0} flexDirection="column">
              {descriptionLines.map((line, lineIndex) => (
                <Text key={lineIndex} dimColor>
                  {line}
                </Text>
              ))}
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
        maxHeight={6}
        overflow="hidden"
        justifyContent="flex-end"
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
          maxHeight={menuMaxHeight}
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
