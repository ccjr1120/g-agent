import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR = join(homedir(), ".config", "g-agent");
const LOG_PATH = join(CONFIG_DIR, "logs", "server.log");
const PID_PATH = join(CONFIG_DIR, "server.pid");

const POLL_INTERVAL_MS = 100;
const POLL_ATTEMPTS = 50;

function toHealthCheckUrl(serverUrl: string): string {
  return serverUrl.replace(/^ws/, "http");
}

async function isServerUp(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(300) });
    return res.ok;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hasLiveServerLock(): Promise<boolean> {
  try {
    const raw = await readFile(PID_PATH, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && isPidAlive(pid);
  } catch {
    return false;
  }
}

async function readServerPid(): Promise<number | null> {
  try {
    const raw = await readFile(PID_PATH, "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function waitForPidExit(pid: number, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return !isPidAlive(pid);
}

async function stopServerFromPidFile(): Promise<"stopped" | "not-running" | "stale-pid"> {
  const pid = await readServerPid();
  if (pid === null) {
    return "not-running";
  }

  if (!isPidAlive(pid)) {
    await rm(PID_PATH, { force: true });
    return "stale-pid";
  }

  process.kill(pid, "SIGTERM");
  if (!(await waitForPidExit(pid, 30))) {
    process.kill(pid, "SIGKILL");
    await waitForPidExit(pid, 20);
  }
  await rm(PID_PATH, { force: true });
  return "stopped";
}

/**
 * `apps/server` always sits next to `apps/tui` in the repo/install layout,
 * but the number of directory levels between this module and the repo root
 * differs between dev (running from `src/lib`) and the bundled install
 * (`dist/cli.js`), so walk up looking for it instead of hard-coding a depth.
 */
function findServerEntry(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "apps", "server", "src", "index.ts");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function spawnServer(): Promise<void> {
  const entry = findServerEntry(dirname(fileURLToPath(import.meta.url)));
  if (!entry) {
    console.error("g-agent: could not locate @g-agent/server entry point");
    return;
  }

  await mkdir(dirname(LOG_PATH), { recursive: true });
  const logSink = Bun.file(LOG_PATH);
  const proc = Bun.spawn([process.execPath, entry], {
    stdio: ["ignore", logSink, logSink],
    detached: true,
  });
  await writeFile(PID_PATH, String(proc.pid), "utf8");
  proc.unref();
}

/**
 * Ensures a `@g-agent/server` instance is reachable at `serverUrl`, spawning
 * one as a detached background process if nothing answers yet. Safe to call
 * from multiple concurrent `g-agent` invocations: only one will spawn, the
 * rest detect the live pid file and just wait for it to become ready.
 */
export async function ensureServerRunning(serverUrl: string): Promise<void> {
  const healthUrl = toHealthCheckUrl(serverUrl);

  if (await isServerUp(healthUrl)) {
    return;
  }

  if (!(await hasLiveServerLock())) {
    await spawnServer();
  }

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (await isServerUp(healthUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function restartServer(serverUrl: string): Promise<void> {
  const healthUrl = toHealthCheckUrl(serverUrl);
  const stopResult = await stopServerFromPidFile();

  if (stopResult === "not-running" && (await isServerUp(healthUrl))) {
    throw new Error(
      `server is already running at ${serverUrl}, but ${PID_PATH} is missing; cannot safely restart it`,
    );
  }

  await spawnServer();

  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (await isServerUp(healthUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`server did not become ready at ${serverUrl}`);
}
