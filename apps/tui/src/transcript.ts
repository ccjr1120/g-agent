import type { ChatLine } from "./model.js";

export type DisplayBlock =
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; ok?: boolean; timing?: string }
  | { kind: "ask"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "queued"; text: string }
  | { kind: "error"; text: string }
  | { kind: "status"; text: string };

/**
 * Pure function: expand a ChatLine's segments into ordered display blocks.
 * `segments` is the single source of display order (thinking → text → tools),
 * matching the Iron Rule in AGENTS.md. The renderer is responsible for blank
 * lines *between* block groups (tools stay compact; thinking stays compact).
 */
export function lineToBlocks(line: ChatLine, includeTrailingText = true): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];

  for (const segment of line.segments) {
    switch (segment.type) {
      case "thinking":
        blocks.push({ kind: "thinking", text: segment.text });
        break;
      case "text":
        blocks.push({ kind: "text", text: segment.text });
        break;
      case "tool":
        blocks.push({
          kind: "tool",
          name: segment.name,
          ok: segment.status !== "error",
          timing: segment.durationMs !== undefined ? `· ${formatMs(segment.durationMs)}` : undefined,
        });
        break;
      case "ask":
        blocks.push({ kind: "ask", text: segment.question });
        break;
      case "reply":
        blocks.push({ kind: "reply", text: segment.text });
        break;
    }
  }

  if (includeTrailingText && line.text) {
    const hasSegments = line.segments.length > 0;
    const last = hasSegments ? line.segments[line.segments.length - 1] : undefined;
    const needsTrailing =
      !last || last.type === "thinking" || last.type === "tool" || (last.type === "text" && line.text !== last.text);
    if (needsTrailing) {
      blocks.push({ kind: "text", text: line.text });
    }
  }

  return blocks;
}

/** A user/error/status line has no segments — just its own text. */
export function simpleLineBlock(kind: "user" | "error" | "status", text: string): DisplayBlock {
  return { kind, text };
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

export function formatMmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function truncateToWidth(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Center a line within the viewport, accounting for left padding. */
export function centerLine(text: string, viewportWidth: number, leftPadding = 1): string {
  const width = Math.max(1, viewportWidth - leftPadding);
  if (text.length >= width) return text;
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return `${" ".repeat(pad)}${text}`;
}