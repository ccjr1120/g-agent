#!/usr/bin/env node
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "g-agent");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const legacyMemoryPath = join(scriptDir, "..", "memory.md");

function usage(exitCode = 0) {
  const text = `Usage:
  memory.mjs paths [--json]
  memory.mjs list [--json]
  memory.mjs search <query> [--json]
  memory.mjs get <id> [--json]
  memory.mjs add <content...> [--date YYYY-MM-DD] [--json]
  memory.mjs update <id> <content...> [--date YYYY-MM-DD] [--json]
  memory.mjs delete <id> [--json]

Notes:
  - memories are stored per agent under ~/.config/g-agent/agents/<agent>/memory.md
  - override with G_AGENT_MEMORY_PATH`;
  console.log(text);
  process.exit(exitCode);
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function configCandidates() {
  const home = homedir();
  const candidates = [];
  if (process.env.G_AGENT_CONFIG) candidates.push(process.env.G_AGENT_CONFIG);
  if (process.env.G_AGENT_HOME) candidates.push(join(process.env.G_AGENT_HOME, "config.json"));
  candidates.push(join(home, ".config", "g-agent", "config.json"));
  candidates.push(join(home, ".local", "share", "g-agent", "config.json"));
  return [...new Set(candidates)];
}

function agentsBaseDir() {
  if (process.env.G_AGENT_HOME) return join(process.env.G_AGENT_HOME, "agents");
  return join(DEFAULT_CONFIG_DIR, "agents");
}

async function resolveActiveAgent() {
  if (process.env.G_AGENT_AGENT?.trim()) {
    return process.env.G_AGENT_AGENT.trim();
  }

  for (const path of configCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const config = JSON.parse(await readFile(path, "utf8"));
      if (typeof config.agent === "string" && config.agent.trim()) {
        return config.agent.trim();
      }
    } catch {
      // ignore invalid config
    }
  }

  return "default";
}

async function resolveMemoryPath() {
  if (process.env.G_AGENT_MEMORY_PATH?.trim()) {
    return expandHome(process.env.G_AGENT_MEMORY_PATH.trim());
  }

  const agent = await resolveActiveAgent();
  return join(agentsBaseDir(), agent, "memory.md");
}

async function ensureMemoryPath() {
  const memoryPath = await resolveMemoryPath();
  if (!existsSync(memoryPath) && existsSync(legacyMemoryPath)) {
    await mkdir(dirname(memoryPath), { recursive: true });
    await copyFile(legacyMemoryPath, memoryPath);
  }
  return memoryPath;
}

function today() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseOptions(args) {
  const values = [];
  const options = { json: false, date: null };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--date") {
      const value = args[++i];
      if (!value) {
        throw new Error("--date requires a value");
      }
      options.date = value;
      continue;
    }
    values.push(arg);
  }

  return { values, options };
}

async function loadEntries(memoryPath) {
  let content = "";
  try {
    content = await readFile(memoryPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+(.*)$/);
    if (!match) {
      continue;
    }
    entries.push({
      id: entries.length + 1,
      date: match[1],
      content: match[2],
    });
  }
  return entries;
}

async function saveEntries(memoryPath, entries) {
  await mkdir(dirname(memoryPath), { recursive: true });
  const content = entries
    .map((entry) => `- [${entry.date}] ${entry.content}`)
    .join("\n");
  await writeFile(memoryPath, content ? `${content}\n` : "", "utf8");
}

function parseId(value, entries) {
  const id = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(id) || id < 1 || id > entries.length) {
    throw new Error(`invalid memory id: ${value}`);
  }
  return id;
}

function printEntries(entries, json) {
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log("(empty)");
    return;
  }
  for (const entry of entries) {
    console.log(`#${entry.id} [${entry.date}] ${entry.content}`);
  }
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.message);
}

async function cmdPaths(options) {
  const agent = await resolveActiveAgent();
  const memoryPath = await resolveMemoryPath();
  const result = {
    agent,
    memoryPath,
    agentsBaseDir: agentsBaseDir(),
    legacySkillPath: legacyMemoryPath,
    legacyExists: existsSync(legacyMemoryPath),
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`agent: ${result.agent}`);
  console.log(`memory: ${result.memoryPath}`);
  console.log(`agents base: ${result.agentsBaseDir}`);
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    usage(command ? 0 : 1);
  }

  const { values, options } = parseOptions(rawArgs);

  if (command === "paths") {
    await cmdPaths(options);
    return;
  }

  const memoryPath = await ensureMemoryPath();
  const entries = await loadEntries(memoryPath);

  if (command === "list") {
    printEntries(entries, options.json);
    return;
  }

  if (command === "search") {
    const query = values.join(" ").trim().toLowerCase();
    if (!query) {
      throw new Error("search requires a query");
    }
    const matches = entries.filter((entry) =>
      `${entry.date} ${entry.content}`.toLowerCase().includes(query),
    );
    printEntries(matches, options.json);
    return;
  }

  if (command === "get") {
    const id = parseId(values[0], entries);
    printEntries([entries[id - 1]], options.json);
    return;
  }

  if (command === "add") {
    const content = values.join(" ").trim();
    if (!content) {
      throw new Error("add requires content");
    }
    const entry = {
      id: entries.length + 1,
      date: options.date ?? today(),
      content,
    };
    entries.push(entry);
    await saveEntries(memoryPath, entries);
    printResult({ ok: true, entry, message: `Added #${entry.id}: ${entry.content}` }, options.json);
    return;
  }

  if (command === "update") {
    const id = parseId(values[0], entries);
    const content = values.slice(1).join(" ").trim();
    if (!content) {
      throw new Error("update requires content");
    }
    const entry = entries[id - 1];
    entry.date = options.date ?? entry.date;
    entry.content = content;
    await saveEntries(memoryPath, entries);
    printResult({ ok: true, entry, message: `Updated #${entry.id}: ${entry.content}` }, options.json);
    return;
  }

  if (command === "delete" || command === "remove") {
    const id = parseId(values[0], entries);
    const [deleted] = entries.splice(id - 1, 1);
    entries.forEach((entry, index) => {
      entry.id = index + 1;
    });
    await saveEntries(memoryPath, entries);
    printResult({ ok: true, entry: deleted, message: `Deleted #${id}: ${deleted.content}` }, options.json);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
