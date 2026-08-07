import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationTurn } from "@g-agent/shared";
import { configDir } from "./config.js";
import { truncateToWidth } from "./transcript.js";

export type SavedSession = {
  id: string;
  agent: string;
  model: string;
  startedAt: number;
  updatedAt: number;
  preview: string;
  turnCount: number;
  history: ConversationTurn[];
};

export type SavedSessionSummary = {
  id: string;
  agent: string;
  preview: string;
  updatedAt: number;
  turnCount: number;
};

function sessionsDir(): string {
  return join(configDir(), "sessions");
}

function sessionPath(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

export function listSessions(): SavedSessionSummary[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];

  const sessions: SavedSessionSummary[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = readFileSync(join(dir, name), "utf8");
      const session = JSON.parse(raw) as SavedSession;
      sessions.push({
        id: session.id,
        agent: session.agent,
        preview: session.preview,
        updatedAt: session.updatedAt,
        turnCount: session.turnCount,
      });
    } catch {
      // skip corrupt files
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

export function loadSession(idOrPrefix: string): SavedSession | null {
  const dir = sessionsDir();
  if (!existsSync(dir)) return null;

  const trimmed = idOrPrefix.trim();
  let exact: string | null = null;
  const prefixMatches: string[] = [];

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const stem = name.slice(0, -".json".length);
    if (stem === trimmed) {
      exact = join(dir, name);
      break;
    }
    if (stem.startsWith(trimmed)) prefixMatches.push(join(dir, name));
  }

  const path = exact ?? prefixMatches.sort()[0];
  if (!path) return null;

  try {
    return JSON.parse(readFileSync(path, "utf8")) as SavedSession;
  } catch {
    return null;
  }
}

export function saveSession(session: SavedSession): void {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(sessionPath(session.id), JSON.stringify(session, null, 2));
}

export function formatSessionAge(updatedAt: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - updatedAt);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

export function buildSessionPreview(history: ConversationTurn[]): string {
  const first = history.find((turn) => turn.role === "user");
  const content = first?.content.replace(/\n/g, " ").trim();
  if (!content) return "Untitled session";
  return truncateToWidth(content, 60);
}

export function formatSessionLabel(summary: SavedSessionSummary): string {
  return `${summary.preview} · ${formatSessionAge(summary.updatedAt)} · ${summary.turnCount} msgs · ${summary.id}`;
}
