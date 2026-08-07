import { spawn, execSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { configDir, repoRoot, serverEntry, serverUrl } from "./config.js";

const POLL_MS = 100;
const POLL_ATTEMPTS = 50;
const LAUNCHD_LABEL = "com.ccjr.g-agent.server";

function healthUrl(url: string): string {
  return url.replace(/^ws/, "http");
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isUp(url: string): Promise<boolean> {
  try {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 300);
    const res = await fetch(healthUrl(url), { signal: timeout.signal });
    clearTimeout(timer);
    return res.status >= 200;
  } catch {
    return false;
  }
}

function pidPath(): string {
  return join(configDir(), "server.pid");
}

function logPath(): string {
  return join(configDir(), "logs", "server.log");
}

function readPid(): number | null {
  if (!existsSync(pidPath())) return null;
  try {
    const pid = Number.parseInt(readFileSync(pidPath(), "utf8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function pidOnPort(url: string): number | null {
  try {
    const port = new URL(healthUrl(url)).port;
    const out = execSync(`lsof -nP -tiTCP:${port} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (!out) return null;
    const pid = Number.parseInt(out.split("\n")[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function findServerPid(url: string): number | null {
  const fromFile = readPid();
  if (fromFile !== null && isPidAlive(fromFile)) return fromFile;
  return pidOnPort(url);
}

function isPidAlive(pid: number): boolean {
  try {
    return execSync(`kill -0 ${pid}`, { stdio: "ignore" }).toString().length >= 0;
  } catch {
    return false;
  }
}

function bunBinary(): string {
  const candidates = [join(homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun", "bun"];
  return candidates.find((candidate) => candidate === "bun" || existsSync(candidate)) ?? "bun";
}

function spawnServer(): Promise<void> {
  const root = repoRoot();
  if (!root) throw new Error("could not locate @g-agent/server entry; set G_AGENT_HOME to your g-agent checkout");
  const entry = serverEntry(root);
  if (!existsSync(entry)) throw new Error(`server entry not found at ${entry}`);

  mkdirSync(dirname(logPath()), { recursive: true });
  const logFd = openSync(logPath(), "a");
  const child = spawn(bunBinary(), [entry], {
    cwd: root,
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  closeSync(logFd);

  if (child.pid) writeFileSync(pidPath(), String(child.pid));
  child.unref();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    resolve();
  });
}

async function stopPid(pid: number) {
  try {
    execSync(`kill ${pid}`, { stdio: "ignore" });
  } catch {
    // ignore
  }
  let attempts = 0;
  while (isPidAlive(pid) && attempts++ < 30) {
    // wait for graceful exit
    waitSync(POLL_MS);
  }
  if (isPidAlive(pid)) {
    try {
      execSync(`kill -9 ${pid}`, { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
}

function waitSync(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait — only used in CLI (non-TUI) paths
  }
}

async function stopViaPidFile(url: string) {
  const pid = findServerPid(url);
  if (pid !== null) stopPid(pid);
  try {
    rmSync(pidPath(), { force: true });
  } catch {
    // ignore
  }
}

async function waitForDown(url: string): Promise<boolean> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (!(await isUp(url))) return true;
    await wait(POLL_MS);
  }
  return !(await isUp(url));
}

export async function ensureServerRunning(url: string): Promise<void> {
  if (await isUp(url)) return;
  const pid = readPid();
  if (!(pid !== null && isPidAlive(pid))) {
    await spawnServer();
  }
  await ensureResponseUp(url);
}

async function ensureResponseUp(url: string): Promise<void> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    if (await isUp(url)) return;
    await wait(POLL_MS);
  }
  throw new Error(`server did not become ready at ${url}`);
}

export async function stopServer(url: string): Promise<void> {
  if (await isUp(url)) {
    let stopped = false;
    await waitViaPid(url);
    stopped = await waitForDown(url);
    if (!stopped) throw new Error(`failed to stop existing server at ${url}`);
  } else {
    await stopViaPidFile(url);
  }
}

async function waitViaPid(url: string) {
  const pid = findServerPid(url);
  if (pid !== null) stopPid(pid);
  await wait(50);
}

export async function restartServer(url: string): Promise<void> {
  await stopServer(url);
  await spawnServer();
  await ensureResponseUp(url);
}

export async function serverStatus(url: string): Promise<string> {
  const up = await isUp(url);
  const pid = readPid();
  const alive = pid !== null && isPidAlive(pid);
  let line = `g-agent: ${up ? "server running at " + url : "server not running"}`;
  if (pid !== null && alive) line += up ? ` (pid ${pid})` : " (process alive, not answering)";
  return line + `\ng-agent: log file ${logPath()}`;
}

export async function tailLogs(follow: boolean): Promise<void> {
  const path = logPath();
  if (!existsSync(path)) throw new Error(`no log file at ${path}`);
  const args = follow ? ["-f", path] : ["-n", "200", path];
  execSync(`tail ${args.join(" ")}`, { stdio: "inherit" });
}

export async function runServerForeground(): Promise<void> {
  const root = repoRoot();
  if (!root) throw new Error("could not locate g-agent repo");
  const entry = serverEntry(root);
  const result = execSync(`${bunBinary()} ${entry}`, { cwd: root, stdio: "inherit" });
  void result;
}

// ---- launchd autostart (macOS) ----

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export async function enableAutostart(): Promise<string[]> {
  const exe = process.execPath;
  const log = logPath();
  mkdirSync(dirname(log), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${exe}</string>
        <string>server</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${log}</string>
    <key>StandardErrorPath</key>
    <string>${log}</string>
</dict>
</plist>
`;
  try {
    execSync(`launchctl unload -w ${plistPath()}`, { stdio: "ignore" });
  } catch {
    // ignore
  }
  writeFileSync(plistPath(), plist);
  await stopViaPidFile(serverUrl());
  execSync(`launchctl load -w ${plistPath()}`, { stdio: "inherit" });
  return [
    `g-agent: autostart enabled (${plistPath()})`,
    "g-agent: the server now starts at login and restarts if it crashes",
  ];
}

export async function disableAutostart(): Promise<string[]> {
  const path = plistPath();
  if (!existsSync(path)) return ["g-agent: autostart is not enabled"];
  try {
    execSync(`launchctl unload -w ${path}`, { stdio: "ignore" });
  } catch {
    // ignore
  }
  rmSync(path, { force: true });
  return ["g-agent: autostart disabled"];
}

export async function autostartStatus(): Promise<string> {
  const path = plistPath();
  if (!existsSync(path)) return "g-agent: autostart disabled";
  let loaded = false;
  try {
    execSync(`launchctl list ${LAUNCHD_LABEL}`, { stdio: "ignore" });
    loaded = true;
  } catch {
    loaded = false;
  }
  return `g-agent: autostart enabled (${path}) — launchd job ${loaded ? "loaded" : "not loaded"}`;
}