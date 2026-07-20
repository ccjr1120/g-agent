import React from "react";
import { Box, Text } from "ink";

export type ConnectionState = "connecting" | "connected" | "disconnected";

const CONNECTION_ICON: Record<ConnectionState, string> = {
  connecting: "●",
  connected: "●",
  disconnected: "○",
};

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
};

type ContextUsage = {
  usedTokens: number;
  maxTokens: number;
  percent: number;
};

function displayModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "—";

  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) || trimmed : trimmed;
}

function progressRing(percent: number): string {
  if (percent <= 0) return "○";
  if (percent < 25) return "◔";
  if (percent < 50) return "◑";
  if (percent < 75) return "◕";
  return "●";
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function StatusBar({
  connection,
  model,
  activeAgent,
  contextUsage,
}: {
  connection: ConnectionState;
  model: string;
  activeAgent: string;
  contextUsage: ContextUsage;
}) {
  const modelLabel = displayModel(model);
  const hasContextLimit = contextUsage.maxTokens > 0;

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="cyan">{CONNECTION_ICON[connection]}</Text> <Text dimColor>{CONNECTION_LABEL[connection]}</Text>
      </Text>
      <Text dimColor>
        Model <Text color="cyan">{modelLabel}</Text>
        {"  ·  "}
        Agent <Text color="cyan">{activeAgent || "—"}</Text>
        {"  ·  "}
        Context{" "}
        {hasContextLimit ? (
          <>
            <Text color="cyan">{progressRing(contextUsage.percent)}</Text>{" "}
            <Text color="cyan">
              {contextUsage.percent}% {formatTokenCount(contextUsage.usedTokens)}/{formatTokenCount(contextUsage.maxTokens)}
            </Text>
          </>
        ) : (
          <Text color="cyan">
            {formatTokenCount(contextUsage.usedTokens)}/inf
          </Text>
        )}
      </Text>
    </Box>
  );
}
