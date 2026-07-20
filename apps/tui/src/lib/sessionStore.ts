import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { ConversationTurn } from "@g-agent/shared";

const SESSIONS_DIR = join(homedir(), ".config", "g-agent", "sessions");

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

export type SavedSessionSummary = Pick<
  SavedSession,
  "id" | "agent" | "model" | "startedAt" | "updatedAt" | "preview" | "turnCount"
>;

async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

function isSavedSession(value: unknown): value is SavedSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const session = value as SavedSession;
  return (
    typeof session.id === "string" &&
    typeof session.agent === "string" &&
    typeof session.model === "string" &&
    typeof session.startedAt === "number" &&
    typeof session.updatedAt === "number" &&
    typeof session.preview === "string" &&
    typeof session.turnCount === "number" &&
    Array.isArray(session.history)
  );
}

function toSummary(session: SavedSession): SavedSessionSummary {
  return {
    id: session.id,
    agent: session.agent,
    model: session.model,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    preview: session.preview,
    turnCount: session.turnCount,
  };
}

export async function saveSession(session: SavedSession): Promise<void> {
  await ensureSessionsDir();
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf8");
}

export async function listSessions(options?: {
  agent?: string;
}): Promise<SavedSessionSummary[]> {
  await ensureSessionsDir();
  const files = await readdir(SESSIONS_DIR);
  const sessions: SavedSessionSummary[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const raw = await readFile(join(SESSIONS_DIR, file), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isSavedSession(parsed)) {
        continue;
      }
      if (options?.agent && parsed.agent !== options.agent) {
        continue;
      }
      if (parsed.history.length === 0) {
        continue;
      }
      sessions.push(toSummary(parsed));
    } catch {
      // Skip unreadable session files.
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readSessionById(id: string): Promise<SavedSession | null> {
  try {
    const raw = await readFile(sessionPath(id), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isSavedSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function loadSession(idOrPrefix: string): Promise<SavedSession | null> {
  const trimmed = idOrPrefix.trim();
  if (!trimmed) {
    return null;
  }

  const exact = await readSessionById(trimmed);
  if (exact) {
    return exact;
  }

  const sessions = await listSessions();
  const matches = sessions.filter(
    (session) => session.id.startsWith(trimmed) || session.id.startsWith(trimmed.toLowerCase()),
  );
  if (matches.length === 1) {
    return readSessionById(matches[0]!.id);
  }

  return null;
}

export function formatSessionAge(updatedAt: number): string {
  const diffMs = Date.now() - updatedAt;
  if (diffMs < 60_000) {
    return "just now";
  }
  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)}m ago`;
  }
  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)}h ago`;
  }
  return new Date(updatedAt).toLocaleDateString();
}

export function formatSessionLabel(session: SavedSessionSummary): string {
  const shortId = session.id.slice(0, 8);
  return `[${session.agent}] ${shortId} — ${session.preview} · ${formatSessionAge(session.updatedAt)} · ${session.turnCount} msgs`;
}
