import { createSignal } from "solid-js";

/** A subset of TextBufferOptions used as a semantic style token. */
export type Style = {
  fg?: string;
  bg?: string;
  attributes?: number;
  wrapMode?: "none" | "char" | "word";
};

export type Theme = {
  background: string;
  muted: Style;
  text: Style;
  border: Style;
  brand: Style;
  success: Style;
  error: Style;
  userMessage: Style;
  thinking: Style;
  toolCall: Style;
  toolRunning: Style;
  warning: Style;
  ask: Style;
  askHint: Style;
  question: Style;
  options: Style;
  spinnerFrame: Style;
  spinnerLabel: Style;
  statusConnected: Style;
  statusDisconnected: Style;
  statusMeta: Style;
  statusLabel: Style;
  banner: Style;
  welcome: Style;
  timing: Style;
  menuSelected: Style;
  menuDescription: Style;
  composerActive: Style;
  planTitle: Style;
  assistantBullet: Style;
};

/** Ratatui-style terminal palette (Cyan/Green/Yellow/Red/DarkGray). */
const DARK: Theme = {
  background: "#000000",
  muted: { fg: "#808080" },
  text: { fg: "#c0c0c0" },
  border: { fg: "#808080" },
  brand: { fg: "#00ffff" },
  success: { fg: "#00ff00" },
  error: { fg: "#ff0000" },
  userMessage: { fg: "#00ffff" },
  thinking: { fg: "#808080", attributes: 2 },
  toolCall: { fg: "#808080" },
  toolRunning: { fg: "#ffff00" },
  warning: { fg: "#ffff00" },
  ask: { fg: "#00ffff", attributes: 1 },
  askHint: { fg: "#808080" },
  question: { fg: "#00ffff", attributes: 1 },
  options: { fg: "#c0c0c0" },
  spinnerFrame: { fg: "#ffff00" },
  spinnerLabel: { fg: "#808080" },
  statusConnected: { fg: "#00ffff" },
  statusDisconnected: { fg: "#808080" },
  statusMeta: { fg: "#808080" },
  statusLabel: { fg: "#808080" },
  banner: { fg: "#00ffff", attributes: 1 },
  welcome: { fg: "#808080" },
  timing: { fg: "#00ffff" },
  menuSelected: { fg: "#00ffff", attributes: 1 },
  menuDescription: { fg: "#808080" },
  composerActive: { fg: "#00ffff" },
  planTitle: { fg: "#00ffff" },
  assistantBullet: { fg: "#c0c0c0", attributes: 1 },
};

const LIGHT: Theme = {
  background: "#fafafa",
  muted: { fg: "#57606a" },
  text: { fg: "#1f2328" },
  border: { fg: "#d0d7de" },
  brand: { fg: "#0969da" },
  success: { fg: "#1a7f37" },
  error: { fg: "#cf222e" },
  userMessage: { fg: "#096214", attributes: 1 },
  thinking: { fg: "#57606a", attributes: 2 },
  toolCall: { fg: "#8250df" },
  toolRunning: { fg: "#9a6700" },
  warning: { fg: "#9a6700" },
  ask: { fg: "#9a6700" },
  askHint: { fg: "#57606a" },
  question: { fg: "#9a6700" },
  options: { fg: "#1f2328" },
  spinnerFrame: { fg: "#0969da" },
  spinnerLabel: { fg: "#57606a" },
  statusConnected: { fg: "#1a7f37" },
  statusDisconnected: { fg: "#57606a" },
  statusMeta: { fg: "#57606a" },
  statusLabel: { fg: "#57606a" },
  banner: { fg: "#0969da", attributes: 1 },
  welcome: { fg: "#57606a" },
  timing: { fg: "#0969da" },
  menuSelected: { fg: "#1f2328", attributes: 1 },
  menuDescription: { fg: "#57606a" },
  composerActive: { fg: "#1f2328" },
  planTitle: { fg: "#0969da" },
  assistantBullet: { fg: "#1f2328", attributes: 1 },
};

export function createThemeStore(mode: "dark" | "light") {
  const [theme, setTheme] = createSignal(mode === "light" ? LIGHT : DARK);
  return {
    theme,
    setTheme,
  };
}

/** Return a semantic style for a context-usage percentage (color ring). */
export function contextUsageStyle(percent: number): Style {
  if (percent >= 90) return { fg: "#ff0000", attributes: 1 };
  if (percent >= 75) return { fg: "#ffff00" };
  return { fg: "#00ffff" };
}