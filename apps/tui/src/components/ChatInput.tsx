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
type GroupTrigger = (typeof GROUP_TRIGGERS)[number];

function isGroupTrigger(value: string): value is GroupTrigger {
  return GROUP_TRIGGERS.includes(value as GroupTrigger);
}

function hasGroupChildren(
  trigger: string,
  groups: SlashCommandGroups,
): boolean {
  return (groups[trigger]?.length ?? 0) > 0;
}

function buildExpandedMenu(
  rootItems: SlashCommand[],
  groups: SlashCommandGroups,
  expandedRootIndex: number,
): SlashCommand[] {
  const items: SlashCommand[] = [];
  for (let i = 0; i < rootItems.length; i++) {
    items.push(rootItems[i]);
    const root = rootItems[i];
    if (
      i === expandedRootIndex &&
      isGroupTrigger(root.value) &&
      hasGroupChildren(root.value, groups)
    ) {
      items.push(...groups[root.value]!);
    }
  }
  return items;
}

function navigateSlashMenu(
  delta: number,
  menuIndex: number,
  expandedRootIndex: number,
  rootItems: SlashCommand[],
  groups: SlashCommandGroups,
): { menuIndex: number; expandedRootIndex: number } {
  const items = buildExpandedMenu(rootItems, groups, expandedRootIndex);
  if (items.length === 0) {
    return { menuIndex: 0, expandedRootIndex: -1 };
  }

  const wrap = (index: number) =>
    ((index % items.length) + items.length) % items.length;

  const current = items[menuIndex];
  const currentRootIndex = current
    ? rootItems.findIndex((item) => item.value === current.value)
    : -1;

  if (
    delta > 0 &&
    currentRootIndex >= 0 &&
    expandedRootIndex !== currentRootIndex &&
    isGroupTrigger(current.value) &&
    hasGroupChildren(current.value, groups)
  ) {
    return {
      menuIndex: currentRootIndex + 1,
      expandedRootIndex: currentRootIndex,
    };
  }

  if (delta < 0 && expandedRootIndex >= 0) {
    if (menuIndex === expandedRootIndex + 1) {
      return { menuIndex: expandedRootIndex, expandedRootIndex };
    }
    if (menuIndex === expandedRootIndex) {
      return { menuIndex: expandedRootIndex, expandedRootIndex: -1 };
    }
  }

  const nextIndex = wrap(menuIndex + delta);
  const selected = items[nextIndex];
  if (!selected) {
    return { menuIndex: nextIndex, expandedRootIndex };
  }

  const selectedRootIndex = rootItems.findIndex((item) => item.value === selected.value);
  if (selectedRootIndex >= 0) {
    if (
      isGroupTrigger(selected.value) &&
      hasGroupChildren(selected.value, groups)
    ) {
      return { menuIndex: nextIndex, expandedRootIndex: selectedRootIndex };
    }

    const collapsedIndex = selectedRootIndex;
    return { menuIndex: collapsedIndex, expandedRootIndex: -1 };
  }

  for (let rootIndex = 0; rootIndex < rootItems.length; rootIndex++) {
    const children = groups[rootItems[rootIndex]!.value] ?? [];
    if (children.some((child) => child.value === selected.value)) {
      return { menuIndex: nextIndex, expandedRootIndex: rootIndex };
    }
  }

  return { menuIndex: nextIndex, expandedRootIndex: -1 };
}

function resolveRootMenuItems(
  value: string,
  commands: SlashCommand[],
  groups: SlashCommandGroups,
): SlashCommand[] {
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
  const [expandedRootIndex, setExpandedRootIndex] = useState(-1);

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

  const rootMenuItems = useMemo(
    () => resolveRootMenuItems(value, commands, commandGroups),
    [value, commands, commandGroups],
  );

  const matchedCommands = useMemo(
    () => buildExpandedMenu(rootMenuItems, commandGroups, expandedRootIndex),
    [commandGroups, expandedRootIndex, rootMenuItems],
  );

  const clampedMenuIndex = matchedCommands.length > 0
    ? Math.min(menuIndex, matchedCommands.length - 1)
    : 0;

  const focusedRootIndex = expandedRootIndex >= 0
    ? expandedRootIndex
    : rootMenuItems.findIndex((item) => item.value === matchedCommands[clampedMenuIndex]?.value);
  const focusedRoot = focusedRootIndex >= 0 ? rootMenuItems[focusedRootIndex] : undefined;
  const isGroupExpanded =
    expandedRootIndex >= 0 &&
    focusedRoot !== undefined &&
    isGroupTrigger(focusedRoot.value) &&
    hasGroupChildren(focusedRoot.value, commandGroups);
  const expandedChildren = isGroupExpanded && focusedRoot
    ? commandGroups[focusedRoot.value] ?? []
    : [];
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
    setExpandedRootIndex(-1);
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

  // Reserve fixed height while the menu is open so expand/collapse does not move the input.
  const reservedMenuRows = menuLimit * 2 + 3;

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

  const moveMenuIndex = useCallback((delta: number) => {
    const next = navigateSlashMenu(
      delta,
      menuIndex,
      expandedRootIndex,
      rootMenuItems,
      commandGroups,
    );
    setMenuIndex(next.menuIndex);
    setExpandedRootIndex(next.expandedRootIndex);
  }, [commandGroups, expandedRootIndex, menuIndex, rootMenuItems]);

  useInput(
    (input, key) => {
      if (disabled) return;

      if (isMenuOpen && matchedCommands.length > 0) {
        if (key.upArrow) {
          moveMenuIndex(-1);
          return;
        }

        if (key.downArrow) {
          moveMenuIndex(1);
          return;
        }

        if (key.return) {
          const selected = matchedCommands[clampedMenuIndex];
          if (!selected) {
            return;
          }

          submit(selected.value);
          return;
        }

        if (key.escape) {
          setValue("");
          setMenuIndex(0);
          setExpandedRootIndex(-1);
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

  const menuElement = isMenuOpen && visibleCommands.length > 0 ? (
    <Box flexDirection="column" paddingX={1}>
      {isGroupExpanded && focusedRoot ? (
        <Text color="gray" dimColor>
          {`${focusedRoot.value} — ↑↓ browse · Enter select · Esc close`}
        </Text>
      ) : null}
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
        const isGroupHeader = isGroupExpanded
          && focusedRoot !== undefined
          && cmd.value === focusedRoot.value;
        const isGroupChild = expandedChildren.some((child) => child.value === cmd.value);
        return (
          <Box key={`${cmd.category}-${cmd.value}-${row.index}-${cmd.description}`} paddingLeft={isGroupChild ? 2 : 0}>
            <Box flexShrink={0} marginRight={2}>
              <Text
                color={selected ? "cyan" : isGroupHeader ? "gray" : "white"}
                bold={selected}
                dimColor={isGroupHeader && !selected}
              >
                {isGroupHeader ? `${cmd.value} · list all` : cmd.value}
              </Text>
            </Box>
            {cmd.description ? (
              <Box flexGrow={1} minWidth={0}>
                <Text color="gray" wrap="truncate-end" dimColor={isGroupHeader && !selected}>
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
          height={reservedMenuRows}
          justifyContent="flex-end"
          flexShrink={0}
        >
          {menuElement}
        </Box>
      ) : null}
    </Box>
  );
}
