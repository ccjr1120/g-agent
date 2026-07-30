#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_AGENTS_DIR = join(homedir(), ".config", "g-agent", "agents");
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function usage(exitCode = 0) {
  console.log(`Usage:
  agent.mjs paths [--json]
  agent.mjs list [--json]
  agent.mjs get <name> [--json]
  agent.mjs create <name> --description <text> [--system <markdown>] [--provider <provider/model>] [--providers-json <json>] [--skills-json <json>] [--mcp-servers-json <json>] [--json]
  agent.mjs update <name> [--description <text>] [--system <markdown> | --remove-system] [--provider <provider/model> | --remove-provider] [--providers-json <json> | --remove-providers] [--skills-json <json> | --remove-skills-config] [--mcp-servers-json <json> | --remove-mcp-servers] [--json]
  agent.mjs remove <name> --yes [--json]
  agent.mjs builtin-skill list <agent> [--json]
  agent.mjs builtin-skill get <agent> <skill> [--json]
  agent.mjs builtin-skill add <agent> <skill> --description <text> [--body <markdown>] [--json]
  agent.mjs builtin-skill set <agent> <skill> [--description <text>] [--body <markdown>] [--json]
  agent.mjs builtin-skill remove <agent> <skill> --yes [--json]

Environment:
  G_AGENT_AGENTS_DIR  Override the user agents directory.
  G_AGENT_HOME        Use <G_AGENT_HOME>/agents when G_AGENT_AGENTS_DIR is unset.`);
  process.exit(exitCode);
}

function agentsDir() {
  if (process.env.G_AGENT_AGENTS_DIR) return process.env.G_AGENT_AGENTS_DIR;
  if (process.env.G_AGENT_HOME) return join(process.env.G_AGENT_HOME, "agents");
  return DEFAULT_AGENTS_DIR;
}

function validateName(value, label = "name") {
  if (!NAME_RE.test(value ?? "")) {
    throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
  }
  return value;
}

function agentDir(name) {
  return join(agentsDir(), validateName(name, "agent name"));
}

function parseArgs(args) {
  const values = [];
  const options = {
    json: false,
    yes: false,
    removeSystem: false,
    removeProvider: false,
    removeProviders: false,
    removeSkillsConfig: false,
    removeMcpServers: false,
  };
  const valueFlags = new Map([
    ["--description", "description"],
    ["--system", "system"],
    ["--provider", "provider"],
    ["--providers-json", "providersJson"],
    ["--skills-json", "skillsJson"],
    ["--mcp-servers-json", "mcpServersJson"],
    ["--body", "body"],
  ]);
  const booleanFlags = new Map([
    ["--json", "json"],
    ["--yes", "yes"],
    ["--remove-system", "removeSystem"],
    ["--remove-provider", "removeProvider"],
    ["--remove-providers", "removeProviders"],
    ["--remove-skills-config", "removeSkillsConfig"],
    ["--remove-mcp-servers", "removeMcpServers"],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (booleanFlags.has(arg)) {
      options[booleanFlags.get(arg)] = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      options[valueFlags.get(arg)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
    values.push(arg);
  }
  return { values, options };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseObject(value, flag) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${flag} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function optionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function buildSkillFile(name, description, body = "") {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
}

function parseSkillFile(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { description: "", body: content.trim() };
  let description = "";
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    if (line.slice(0, separator).trim() === "description") {
      description = line.slice(separator + 1).trim();
    }
  }
  return { description, body: match[2].trim() };
}

function print(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.message ?? JSON.stringify(result, null, 2));
}

async function loadAgent(name) {
  const dir = agentDir(name);
  const configPath = join(dir, "agent.json");
  if (!existsSync(configPath)) throw new Error(`user agent not found: ${name}`);
  return { dir, configPath, config: await readJson(configPath) };
}

async function skillNames(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

async function getAgentResult(name) {
  const { dir, configPath, config } = await loadAgent(name);
  const systemPath = join(dir, "system.md");
  return {
    name,
    path: dir,
    configPath,
    config,
    systemPath,
    system: await optionalText(systemPath),
    builtinSkills: await skillNames(join(dir, "builtin-skills")),
    selfSkills: await skillNames(join(dir, "skills")),
  };
}

async function cmdList(options) {
  const dir = agentsDir();
  if (!existsSync(dir)) {
    print({ agentsDir: dir, agents: [], message: "No user agents found." }, options.json);
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const agents = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NAME_RE.test(entry.name)) continue;
    const configPath = join(dir, entry.name, "agent.json");
    if (!existsSync(configPath)) continue;
    const config = await readJson(configPath);
    agents.push({ name: entry.name, description: String(config.description ?? ""), path: join(dir, entry.name) });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  print({ agentsDir: dir, agents, message: agents.length ? agents.map((item) => `${item.name} — ${item.description}`).join("\n") : "No user agents found." }, options.json);
}

function applyConfigOptions(config, options, creating = false) {
  if (options.description !== undefined) {
    const description = options.description.trim();
    if (!description) throw new Error("--description cannot be empty");
    config.description = description;
  } else if (creating) {
    throw new Error("create requires --description");
  }

  const objectOptions = [
    ["providers", "providersJson", "--providers-json", "removeProviders"],
    ["skills", "skillsJson", "--skills-json", "removeSkillsConfig"],
    ["mcpServers", "mcpServersJson", "--mcp-servers-json", "removeMcpServers"],
  ];
  for (const [field, option, flag, removeOption] of objectOptions) {
    if (options[option] !== undefined && options[removeOption]) {
      throw new Error(`${flag} conflicts with --${removeOption.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    }
    if (options[option] !== undefined) config[field] = parseObject(options[option], flag);
    if (options[removeOption]) delete config[field];
  }

  if (options.provider !== undefined && options.removeProvider) {
    throw new Error("--provider conflicts with --remove-provider");
  }
  if (options.provider !== undefined) {
    const provider = options.provider.trim();
    if (!provider.includes("/")) throw new Error("--provider must use provider/model format");
    config.provider = provider;
  }
  if (options.removeProvider) delete config.provider;
}

async function writeSystem(dir, options) {
  const path = join(dir, "system.md");
  if (options.system !== undefined && options.removeSystem) {
    throw new Error("--system conflicts with --remove-system");
  }
  if (options.system !== undefined) {
    await writeFile(path, `${options.system.trim()}\n`, "utf8");
  }
  if (options.removeSystem) await rm(path, { force: true });
}

async function cmdCreate(name, options) {
  validateName(name, "agent name");
  const dir = agentDir(name);
  if (existsSync(dir)) throw new Error(`user agent already exists: ${name}`);
  const config = {};
  applyConfigOptions(config, options, true);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "agent.json"), config);
  await writeSystem(dir, options);
  print({ ok: true, ...(await getAgentResult(name)), message: `Created user agent "${name}" in ${dir}` }, options.json);
}

async function cmdUpdate(name, options) {
  const { dir, configPath, config } = await loadAgent(name);
  applyConfigOptions(config, options);
  await writeJson(configPath, config);
  await writeSystem(dir, options);
  print({ ok: true, ...(await getAgentResult(name)), message: `Updated user agent "${name}" in ${dir}` }, options.json);
}

async function cmdRemove(name, options) {
  validateName(name, "agent name");
  if (name === "default") throw new Error('refusing to remove user override "default"');
  if (!options.yes) throw new Error('remove requires --yes after explicit user confirmation');
  const dir = agentDir(name);
  if (!existsSync(join(dir, "agent.json"))) throw new Error(`user agent not found: ${name}`);
  await rm(dir, { recursive: true, force: false });
  print({ ok: true, name, path: dir, message: `Removed user agent "${name}" from ${dir}` }, options.json);
}

async function cmdBuiltinSkill(action, values, options) {
  const [agentName, skillName] = values;
  const { dir } = await loadAgent(agentName);
  const root = join(dir, "builtin-skills");

  if (action === "list") {
    const skills = await skillNames(root);
    print({ agent: agentName, path: root, skills, message: skills.length ? skills.join("\n") : "No builtin skills found." }, options.json);
    return;
  }

  validateName(skillName, "skill name");
  const skillDir = join(root, skillName);
  const skillPath = join(skillDir, "SKILL.md");

  if (action === "get") {
    if (!existsSync(skillPath)) throw new Error(`builtin skill not found: ${agentName}/${skillName}`);
    const content = await readFile(skillPath, "utf8");
    print({ agent: agentName, name: skillName, path: skillPath, content, ...parseSkillFile(content), message: content }, options.json);
    return;
  }

  if (action === "remove") {
    if (!options.yes) throw new Error('builtin-skill remove requires --yes after explicit user confirmation');
    if (!existsSync(skillPath)) throw new Error(`builtin skill not found: ${agentName}/${skillName}`);
    await rm(skillDir, { recursive: true, force: false });
    print({ ok: true, agent: agentName, name: skillName, path: skillDir, message: `Removed builtin skill "${skillName}" from agent "${agentName}"` }, options.json);
    return;
  }

  if (!["add", "set"].includes(action)) throw new Error(`unknown builtin-skill action: ${action}`);
  const exists = existsSync(skillPath);
  if (action === "add" && exists) throw new Error(`builtin skill already exists: ${agentName}/${skillName}`);
  if (action === "set" && !exists) throw new Error(`builtin skill not found: ${agentName}/${skillName}`);
  const current = exists ? parseSkillFile(await readFile(skillPath, "utf8")) : { description: "", body: "" };
  const description = options.description?.trim() ?? current.description;
  const body = options.body ?? current.body;
  if (!description) throw new Error(`${action} requires --description`);
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, buildSkillFile(skillName, description, body), "utf8");
  print({ ok: true, agent: agentName, name: skillName, path: skillPath, description, body, message: `${action === "add" ? "Added" : "Updated"} builtin skill "${skillName}" for agent "${agentName}"` }, options.json);
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") usage(command ? 0 : 1);
  const { values, options } = parseArgs(rawArgs);

  if (command === "paths") {
    print({ agentsDir: agentsDir(), message: agentsDir() }, options.json);
    return;
  }
  if (command === "list") return cmdList(options);
  if (command === "get") return print(await getAgentResult(values[0]), options.json);
  if (command === "create") return cmdCreate(values[0], options);
  if (command === "update") return cmdUpdate(values[0], options);
  if (command === "remove") return cmdRemove(values[0], options);
  if (command === "builtin-skill") {
    const [action, ...rest] = values;
    return cmdBuiltinSkill(action, rest, options);
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
