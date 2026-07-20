import React, { useCallback, useMemo, useState } from "react";
import { Box, Text, useApp, useStdout, useWindowSize } from "ink";
import { ChatInput, type SlashCommand } from "./components/ChatInput.js";
import { LoadingSpinner } from "./components/LoadingSpinner.js";
import { MessageLine } from "./components/MessageLine.js";
import { StatusBar } from "./components/StatusBar.js";
import { useAgentSocket, type McpServerInfo } from "./hooks/useAgentSocket.js";
import { formatSessionAge, formatSessionLabel } from "./lib/sessionStore.js";

const SKILL_CATEGORY_LABEL = {
  builtin: "Built-in Skills",
  global: "Global Skills",
  self: "Self Skills",
} as const;

const SKILL_SOURCE_ORDER = {
  builtin: 0,
  global: 1,
  self: 2,
} as const;

function skillCategory(source: keyof typeof SKILL_CATEGORY_LABEL | undefined): string {
  return source ? SKILL_CATEGORY_LABEL[source] : "Skills";
}

function skillSourceOrder(source: keyof typeof SKILL_SOURCE_ORDER | undefined): number {
  return source ? SKILL_SOURCE_ORDER[source] : 3;
}

function formatMcpList(servers: McpServerInfo[]): string {
  if (servers.length === 0) {
    return "No MCP servers configured.";
  }

  return servers
    .map((server) => {
      const status = server.connected
        ? `connected, ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`
        : `failed${server.error ? `: ${server.error}` : ""}`;
      const lines = [
        `• [${server.source}] ${server.name} (${server.transport}) — ${status}`,
        `  ${server.target}`,
      ];

      for (const tool of server.tools) {
        lines.push(
          `  - ${tool.name}${tool.description ? ` — ${tool.description}` : ""}`,
        );
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

export function App({
  serverUrl,
  banner,
}: {
  serverUrl: string;
  banner: string[];
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { rows: terminalRows } = useWindowSize();
  const [restoreText, setRestoreText] = useState<string | null>(null);
  const {
    connection,
    staticLines,
    streamingLine,
    waitingForReply,
    streaming,
    turnStartMs,
    pending,
    queuedMessages,
    error,
    skills,
    mcpServers,
    agents,
    activeAgent,
    model,
    contextUsage,
    agentFallback,
    sendMessage,
    addLocalLine,
    undoLastTurn,
    resetConversation,
    switchAgent,
    runSkill,
    listMcp,
    dumpLog,
    resumeSession,
    savedSessions,
  } = useAgentSocket(serverUrl);

  const commands = useMemo<SlashCommand[]>(() => [
    { value: "/skills", description: "Browse skills", category: "Commands" },
    { value: "/mcp", description: "Browse MCP servers", category: "Commands" },
    { value: "/agent", description: "Browse agents", category: "Commands" },
    { value: "/resume", description: "Browse saved sessions", category: "Commands" },
    { value: "/new", description: "Start a new conversation", category: "Commands" },
    { value: "/log", description: "Export the full conversation log", category: "Commands" },
  ], []);

  const commandGroups = useMemo(() => ({
    "/skills": [...skills]
      .sort((a, b) =>
        skillSourceOrder(a.source) - skillSourceOrder(b.source) ||
        a.name.localeCompare(b.name),
      )
      .map((skill) => ({
        value: `/${skill.name}`,
        description: skill.description || "Run skill",
        category: skillCategory(skill.source),
      })),
    "/agent": [...agents]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => ({
        value: `/agent ${agent.name}`,
        description: agent.active
          ? `${agent.description || "Switch agent"} (current)`
          : agent.description || "Switch agent",
        category: "Agents",
      })),
    "/mcp": mcpServers
      .map((server) => ({
        value: "/mcp",
        description: `[${server.source}] ${server.name} — ${
          server.connected
            ? `connected, ${server.toolCount} tools`
            : `failed${server.error ? `: ${server.error}` : ""}`
        }`,
        category: "MCP Servers",
      })),
    "/resume": [
      {
        value: "/resume all",
        description: "List saved sessions from all agents",
        category: "Sessions",
      },
      ...savedSessions
        .filter((session) => session.agent === activeAgent)
        .map((session) => ({
          value: `/resume ${session.id}`,
          description: `${session.preview} · ${formatSessionAge(session.updatedAt)} · ${session.turnCount} msgs`,
          category: activeAgent ? `Sessions (${activeAgent})` : "Sessions",
        })),
    ],
  }), [skills, agents, mcpServers, savedSessions, activeAgent]);

  const menuItemLimit = Math.max(5, Math.min(16, (stdout.rows ?? 24) - 12));

  const handleSubmit = useCallback(
    (text: string) => {
      if (text === "exit") {
        exit();
        return;
      }
      if (text === "/new") {
        resetConversation();
        return;
      }
      if (text === "/skills") {
        if (skills.length === 0) {
          addLocalLine("No skills loaded.");
        } else {
          const lines = skills
            .map((s) => `• [${s.source ?? "unknown"}] ${s.name}${s.description ? ` — ${s.description}` : ""}`)
            .join("\n");
          addLocalLine(lines);
        }
        return;
      }
      if (text === "/mcp") {
        listMcp();
        addLocalLine(formatMcpList(mcpServers));
        return;
      }
      if (text.startsWith("/skill ")) {
        const name = text.slice("/skill ".length).trim();
        if (!name) {
          addLocalLine("Usage: /skill <name>");
          return;
        }
        runSkill(name);
        return;
      }
      if (text === "/agent") {
        if (agents.length === 0) {
          addLocalLine("No agents loaded.");
        } else {
          const lines = agents
            .map((a) => `${a.active ? "* " : "  "}${a.name}${a.description ? ` — ${a.description}` : ""}`)
            .join("\n");
          addLocalLine(lines);
        }
        return;
      }
      if (text.startsWith("/agent ")) {
        const name = text.slice("/agent ".length).trim();
        if (!name) {
          addLocalLine("Usage: /agent <name>");
          return;
        }
        switchAgent(name);
        return;
      }
      if (text === "/log") {
        if (staticLines.length === 0 && !streamingLine) {
          addLocalLine("No conversation to log yet.");
        } else {
          dumpLog().then((path) => {
            addLocalLine(`Log saved to: ${path}`);
          }).catch((err: unknown) => {
            addLocalLine(`Failed to save log: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        return;
      }
      if (text === "/resume all") {
        if (savedSessions.length === 0) {
          addLocalLine("No saved sessions.");
        } else {
          addLocalLine(savedSessions.map((session) => `• ${formatSessionLabel(session)}`).join("\n"));
        }
        return;
      }
      if (text === "/resume") {
        const agentSessions = savedSessions.filter((session) => session.agent === activeAgent);
        if (agentSessions.length === 0) {
          addLocalLine(`No saved sessions for agent "${activeAgent || "—"}". Use /resume all to see other agents.`);
        } else {
          addLocalLine(agentSessions.map((session) => `• ${formatSessionLabel(session)}`).join("\n"));
        }
        return;
      }
      if (text.startsWith("/resume ")) {
        const id = text.slice("/resume ".length).trim();
        if (!id) {
          addLocalLine("Usage: /resume <session-id>");
          return;
        }
        resumeSession(id).then((ok) => {
          if (!ok) {
            addLocalLine(`Session not found: ${id}`);
          }
        }).catch((err: unknown) => {
          addLocalLine(`Failed to resume session: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      if (text.startsWith("/")) {
        const skillName = text.slice(1);
        if (skills.some((skill) => skill.name === skillName)) {
          runSkill(skillName);
          return;
        }
      }
      sendMessage(text);
    },
    [exit, resetConversation, switchAgent, runSkill, listMcp, skills, mcpServers, agents, sendMessage, addLocalLine, dumpLog, resumeSession, savedSessions, activeAgent, staticLines, streamingLine],
  );

  const handleUndo = useCallback(() => {
    const text = undoLastTurn();
    if (text !== null) {
      setRestoreText(text);
    }
  }, [undoLastTurn]);

  const inputDisabled = connection !== "connected";
  const hasMessages = staticLines.length > 0 || streamingLine !== null;
  const bannerBlock = banner.length > 0 ? (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      {banner.map((line, i) => (
        <Text key={i} color="cyan" bold>{line}</Text>
      ))}
    </Box>
  ) : null;

  const welcomeContent = connection === "connecting" ? (
    <LoadingSpinner label="Connecting…" />
  ) : (
    <Box flexDirection="column">
      <Text dimColor>
        Active agent: <Text color="cyan">{activeAgent || "—"}</Text>. Type a message and press Enter. Type / to see commands. Esc to undo.
      </Text>
      {agentFallback ? (
        <Text color="yellow">
          {`Configured agent "${agentFallback.requested}" not found, using built-in "${agentFallback.active}".`}
        </Text>
      ) : null}
    </Box>
  );

  const liveTurnContent = streamingLine ? (
    <MessageLine
      line={streamingLine}
      showThinking={waitingForReply}
      streaming={streaming && !waitingForReply}
      turnStartMs={turnStartMs}
    />
  ) : waitingForReply ? (
    <LoadingSpinner label="Thinking…" startMs={turnStartMs ?? undefined} />
  ) : null;

  return (
    <Box
      flexDirection="column"
      height={terminalRows}
      minHeight={terminalRows}
      flexShrink={0}
    >
        {!hasMessages ? (
          <Box
            flexDirection="column"
            flexGrow={1}
            minHeight={0}
            paddingX={1}
            marginBottom={1}
          >
            <Box flexGrow={1} />
            {bannerBlock}
            <Box flexDirection="column" justifyContent="flex-end">
              {welcomeContent}
            </Box>
          </Box>
        ) : (
          <Box
            flexDirection="column"
            flexGrow={1}
            minHeight={0}
            overflow="hidden"
            justifyContent="flex-end"
            paddingX={1}
            marginBottom={1}
          >
            {bannerBlock}
            <Box flexDirection="column" flexShrink={0} marginBottom={1}>
              {welcomeContent}
            </Box>
            {staticLines.map((line) => (
              <Box key={line.id} flexShrink={0}>
                <MessageLine line={line} />
              </Box>
            ))}
            {liveTurnContent ?? null}
          </Box>
        )}

        {error ? (
          <Box paddingX={1} flexShrink={0}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}
        {queuedMessages.length > 0 ? (
          <Box flexDirection="column" marginBottom={1} paddingX={1} flexShrink={0}>
            {queuedMessages.map((msg) => (
              <Text key={msg.id} dimColor wrap="truncate-end">
                {"· "}
                {msg.text}
              </Text>
            ))}
          </Box>
        ) : null}

        <Box flexShrink={0} flexDirection="column">
          <StatusBar
            connection={connection}
            model={model}
            activeAgent={activeAgent}
            contextUsage={contextUsage}
          />
          <ChatInput
            disabled={inputDisabled}
            commands={commands}
            commandGroups={commandGroups}
            maxMenuItems={menuItemLimit}
            restoreText={restoreText}
            onRestoreConsumed={() => setRestoreText(null)}
            onSubmit={handleSubmit}
            onUndo={handleUndo}
          />
        </Box>
    </Box>
  );
}
