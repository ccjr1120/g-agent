import { Show } from "solid-js";
import { useTheme } from "../context/theme.js";
import { useSync } from "../persistence.js";
import { contextUsageStyle } from "../theme/index.js";
import type { Style } from "../theme/index.js";

const SECTION_GAP = "  ";

export function StatusBar() {
  const sync = useSync();
  const theme = useTheme();
  const t = theme.theme;

  const connLabel = () => {
    switch (sync.connState()) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting…";
      case "reconnecting":
        return "Reconnecting…";
      default:
        return "Disconnected";
    }
  };
  const connIcon = () => (sync.connState() === "disconnected" ? "○" : "●");

  const ctx = sync.context;
  const percent = () => ctx().percent ?? 0;
  const ringStyle = (): Style => contextUsageStyle(percent());
  const model = () => displayModel(sync.sessionModel());
  const agent = () => sync.sessionAgent();

  return (
    <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text style={t().statusConnected}>{connIcon()}</text>
      <text style={t().statusLabel}>{` ${connLabel()}`}</text>
      <box flexGrow={1} />
      <Show when={agent()}>
        <text style={t().statusLabel}>◎ </text>
        <text style={t().statusMeta}>{agent()}</text>
        <text style={t().statusMeta}>{SECTION_GAP}</text>
      </Show>
      <Show when={model()}>
        <text style={t().statusLabel}>◇ </text>
        <text style={t().statusMeta}>{model()}</text>
      </Show>
      <text style={t().statusMeta}>{`${SECTION_GAP}${percent()}%`}</text>
      <text style={ringStyle()}>{` ${ringGlyph(percent())}`}</text>
    </box>
  );
}

function displayModel(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}

function ringGlyph(percent: number): string {
  if (percent >= 90) return "●";
  if (percent >= 75) return "◕";
  if (percent >= 50) return "◑";
  if (percent >= 25) return "◔";
  return "○";
}
