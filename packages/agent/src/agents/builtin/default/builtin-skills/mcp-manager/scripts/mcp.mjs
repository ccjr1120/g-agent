#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "g-agent");

function usage(exitCode = 0) {
  const text = `Usage:
  mcp.mjs paths [--json]
  mcp.mjs list [--agent <name>] [--json]
  mcp.mjs get global <name> [--json]
  mcp.mjs get agent <agent> <name> [--json]
  mcp.mjs add global <name> (--config '<json>' | --stdio <command> [--arg <arg>...] [--env K=V] [--cwd <path>] | --url <url> [--header K=V] [--oauth]) [--json]
  mcp.mjs add agent <agent> <name> (...same transport flags...) [--json]
  mcp.mjs set global <name> (--config '<json>' | transport flags...) [--json]
  mcp.mjs set agent <agent> <name> (--config '<json>' | transport flags...) [--json]
  mcp.mjs remove global <name> [--json]
  mcp.mjs remove agent <agent> <name> [--json]

Notes:
  - global writes to config.json mcpServers
  - agent writes to ~/.config/g-agent/agents/<agent>/agent.json mcpServers
  - after changes, run: g-agent server restart`;
  console.log(text);
  process.exit(exitCode);
}

function configCandidates() {
  const home = homedir();
  const candidates = [];
  if (process.env.G_AGENT_CONFIG) {
    candidates.push(process.env.G_AGENT_CONFIG);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "config.json"));
  }
  candidates.push(join(home, ".config", "g-agent", "config.json"));
  candidates.push(join(home, ".local", "share", "g-agent", "config.json"));
  return [...new Set(candidates)];
}

function agentsDirCandidates() {
  const home = homedir();
  const candidates = [];
  if (process.env.G_AGENT_AGENTS_DIR) {
    candidates.push(process.env.G_AGENT_AGENTS_DIR);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "agents"));
  }
  candidates.push(join(home, ".config", "g-agent", "agents"));
  candidates.push(join(home, ".local", "share", "g-agent", "agents"));
  return [...new Set(candidates)];
}

function resolveConfigPath(forWrite = false) {
  for (const path of configCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  if (forWrite) {
    if (process.env.G_AGENT_CONFIG) {
      return process.env.G_AGENT_CONFIG;
    }
    return join(DEFAULT_CONFIG_DIR, "config.json");
  }
  return null;
}

function resolveAgentsDir(forWrite = false) {
  for (const path of agentsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  if (forWrite) {
    return join(DEFAULT_CONFIG_DIR, "agents");
  }
  return null;
}

async function readJson(path, fallback = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function validateServerConfig(name, config) {
  if (!name?.trim()) {
    throw new Error("server name is required");
  }
  if (typeof config !== "object" || config == null || Array.isArray(config)) {
    throw new Error("server config must be an object");
  }

  const command = typeof config.command === "string" ? config.command.trim() : "";
  const url = typeof config.url === "string" ? config.url.trim() : "";
  const hasCommand = Boolean(command);
  const hasUrl = Boolean(url);

  if (hasCommand === hasUrl) {
    throw new Error(
      `server "${name}" must specify exactly one of "command" (stdio) or "url" (HTTP)`,
    );
  }

  const normalized = {};
  if (hasCommand) {
    normalized.command = command;
    if (Array.isArray(config.args)) {
      normalized.args = config.args.map(String);
    } else if (config.args !== undefined) {
      throw new Error(`server "${name}".args must be an array`);
    }
    if (config.env !== undefined) {
      if (typeof config.env !== "object" || config.env == null || Array.isArray(config.env)) {
        throw new Error(`server "${name}".env must be an object`);
      }
      normalized.env = Object.fromEntries(
        Object.entries(config.env).map(([key, value]) => [String(key), String(value)]),
      );
    }
    if (typeof config.cwd === "string" && config.cwd.trim()) {
      normalized.cwd = config.cwd.trim();
    }
  } else {
    normalized.url = url;
    if (config.headers !== undefined) {
      if (
        typeof config.headers !== "object" ||
        config.headers == null ||
        Array.isArray(config.headers)
      ) {
        throw new Error(`server "${name}".headers must be an object`);
      }
      normalized.headers = Object.fromEntries(
        Object.entries(config.headers).map(([key, value]) => [String(key), String(value)]),
      );
    }
    if (config.oauth !== undefined) {
      normalized.oauth = normalizeOAuthConfig(name, config.oauth);
    }
  }

  return normalized;
}

function normalizeOAuthConfig(name, value) {
  if (value === true) {
    return true;
  }
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`server "${name}".oauth must be true or an object`);
  }

  const normalized = {};
  if (value.enabled === false) normalized.enabled = false;
  if (typeof value.redirectUrl === "string" && value.redirectUrl.trim()) {
    normalized.redirectUrl = value.redirectUrl.trim();
  }
  if (typeof value.clientId === "string" && value.clientId.trim()) {
    normalized.clientId = value.clientId.trim();
  }
  if (typeof value.clientSecret === "string" && value.clientSecret.trim()) {
    normalized.clientSecret = value.clientSecret.trim();
  }
  if (typeof value.clientSecretEnv === "string" && value.clientSecretEnv.trim()) {
    normalized.clientSecretEnv = value.clientSecretEnv.trim();
  }
  if (typeof value.scope === "string" && value.scope.trim()) {
    normalized.scope = value.scope.trim();
  }
  if (typeof value.clientName === "string" && value.clientName.trim()) {
    normalized.clientName = value.clientName.trim();
  }
  if (value.grant === "authorization_code" || value.grant === "client_credentials") {
    normalized.grant = value.grant;
  } else if (value.grant !== undefined) {
    throw new Error(
      `server "${name}".oauth.grant must be "authorization_code" or "client_credentials"`,
    );
  }

  return Object.keys(normalized).length > 0 ? normalized : true;
}

function describeServer(config) {
  if (config.command) {
    const args = config.args?.length ? ` ${config.args.join(" ")}` : "";
    return `stdio: ${config.command}${args}`;
  }
  const oauth = config.oauth ? " oauth" : "";
  return `url: ${config.url}${oauth}`;
}

function parseFlagOptions(args) {
  const values = [];
  const options = {
    json: false,
    agent: null,
    config: null,
    stdio: null,
    url: null,
    args: [],
    env: {},
    headers: {},
    cwd: null,
    oauth: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--agent") {
      options.agent = args[++i];
      if (!options.agent) throw new Error("--agent requires a value");
      continue;
    }
    if (arg === "--config") {
      options.config = args[++i];
      if (!options.config) throw new Error("--config requires a JSON value");
      continue;
    }
    if (arg === "--stdio") {
      options.stdio = args[++i];
      if (!options.stdio) throw new Error("--stdio requires a command");
      continue;
    }
    if (arg === "--arg") {
      const value = args[++i];
      if (value === undefined) throw new Error("--arg requires a value");
      options.args.push(value);
      continue;
    }
    if (arg === "--env") {
      const value = args[++i];
      if (!value || !value.includes("=")) {
        throw new Error("--env requires KEY=VALUE");
      }
      const eq = value.indexOf("=");
      options.env[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    if (arg === "--header") {
      const value = args[++i];
      if (!value || !value.includes("=")) {
        throw new Error("--header requires KEY=VALUE");
      }
      const eq = value.indexOf("=");
      options.headers[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = args[++i];
      if (!options.cwd) throw new Error("--cwd requires a value");
      continue;
    }
    if (arg === "--url") {
      options.url = args[++i];
      if (!options.url) throw new Error("--url requires a value");
      continue;
    }
    if (arg === "--oauth") {
      options.oauth = true;
      continue;
    }
    values.push(arg);
  }

  return { values, options };
}

function configFromOptions(options) {
  if (options.config) {
    return JSON.parse(options.config);
  }

  if (options.stdio) {
    const config = { command: options.stdio };
    if (options.args.length > 0) config.args = options.args;
    if (Object.keys(options.env).length > 0) config.env = options.env;
    if (options.cwd) config.cwd = options.cwd;
    return config;
  }

  if (options.url) {
    const config = { url: options.url };
    if (Object.keys(options.headers).length > 0) config.headers = options.headers;
    if (options.oauth) config.oauth = true;
    return config;
  }

  throw new Error("provide --config, or --stdio/--url transport flags");
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.message);
}

async function loadGlobalConfig(forWrite = false) {
  const path = resolveConfigPath(forWrite);
  if (!path) {
    throw new Error("config.json not found");
  }
  const config = await readJson(path, {});
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  return { path, config };
}

async function loadAgentConfig(agentName, forWrite = false) {
  const agentsDir = resolveAgentsDir(forWrite);
  if (!agentsDir) {
    throw new Error("agents directory not found");
  }
  const agentDir = join(agentsDir, agentName);
  const path = join(agentDir, "agent.json");
  const config = await readJson(path, { description: "" });
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  return { path, config, agentDir };
}

function listEntries(servers, source) {
  return Object.entries(servers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => ({
      name,
      source,
      transport: config.command ? "stdio" : "url",
      target: describeServer(config),
      config,
    }));
}

async function cmdPaths(options) {
  const result = {
    configPath: resolveConfigPath(),
    configWritePath: resolveConfigPath(true),
    agentsDir: resolveAgentsDir(),
    agentsWriteDir: resolveAgentsDir(true),
  };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`config: ${result.configPath ?? "(none)"}`);
  console.log(`config (write): ${result.configWritePath}`);
  console.log(`agents: ${result.agentsDir ?? "(none)"}`);
  console.log(`agents (write): ${result.agentsWriteDir}`);
}

async function cmdList(values, options) {
  const { path, config } = await loadGlobalConfig();
  const globalEntries = listEntries(config.mcpServers ?? {}, "global");

  if (!options.agent) {
    if (options.json) {
      console.log(
        JSON.stringify({ configPath: path, servers: globalEntries }, null, 2),
      );
      return;
    }
    if (globalEntries.length === 0) {
      console.log(`(empty) config: ${path}`);
      return;
    }
    for (const entry of globalEntries) {
      console.log(`[global] ${entry.name} (${entry.transport}) — ${entry.target}`);
    }
    console.log(`config: ${path}`);
    return;
  }

  const agentName = options.agent;
  let agentEntries = [];
  let merged = { ...(config.mcpServers ?? {}) };
  let agentPath = null;

  try {
    const agent = await loadAgentConfig(agentName);
    agentPath = agent.path;
    agentEntries = listEntries(agent.config.mcpServers ?? {}, "agent");
    merged = { ...merged, ...(agent.config.mcpServers ?? {}) };
  } catch {
    agentEntries = [];
  }

  const effective = listEntries(merged, "merged").map((entry) => {
    const inAgent = agentEntries.some((item) => item.name === entry.name);
    const inGlobal = globalEntries.some((item) => item.name === entry.name);
    return {
      ...entry,
      source: inAgent ? "agent" : inGlobal ? "global" : "agent",
    };
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          configPath: path,
          agentPath,
          agent: agentName,
          global: globalEntries,
          agentServers: agentEntries,
          effective,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Agent: ${agentName}`);
  console.log("Global:");
  if (globalEntries.length === 0) console.log("  (empty)");
  for (const entry of globalEntries) {
    console.log(`  [global] ${entry.name} (${entry.transport}) — ${entry.target}`);
  }
  console.log("Agent:");
  if (agentEntries.length === 0) console.log("  (empty)");
  for (const entry of agentEntries) {
    console.log(`  [agent] ${entry.name} (${entry.transport}) — ${entry.target}`);
  }
  console.log("Effective merge (agent overrides global):");
  if (effective.length === 0) console.log("  (empty)");
  for (const entry of effective) {
    console.log(`  [${entry.source}] ${entry.name} (${entry.transport}) — ${entry.target}`);
  }
  console.log(`config: ${path}`);
  if (agentPath) console.log(`agent: ${agentPath}`);
}

async function cmdGet(scope, values, options) {
  if (scope === "global") {
    const [name] = values;
    const { path, config } = await loadGlobalConfig();
    const server = config.mcpServers?.[name];
    if (!server) throw new Error(`global MCP server not found: ${name}`);
    const result = { scope: "global", path, name, config: server };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`[global] ${name} — ${describeServer(server)}`);
    console.log(JSON.stringify(server, null, 2));
    console.log(`config: ${path}`);
    return;
  }

  const [agentName, name] = values;
  const { path, config } = await loadAgentConfig(agentName, true);
  const server = config.mcpServers?.[name];
  if (!server) throw new Error(`agent MCP server not found: ${agentName}/${name}`);
  const result = { scope: "agent", path, agent: agentName, name, config: server };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[agent:${agentName}] ${name} — ${describeServer(server)}`);
  console.log(JSON.stringify(server, null, 2));
  console.log(`agent: ${path}`);
}

async function cmdWrite(scope, mode, values, options) {
  const normalizedConfig = validateServerConfig(
    scope === "global" ? values[0] : values[1],
    configFromOptions(options),
  );

  if (scope === "global") {
    const [name] = values;
    const { path, config } = await loadGlobalConfig(true);
    if (mode === "add" && config.mcpServers[name]) {
      throw new Error(`global MCP server already exists: ${name}`);
    }
    config.mcpServers[name] = normalizedConfig;
    await writeJson(path, config);
    printResult(
      {
        ok: true,
        scope: "global",
        mode,
        path,
        name,
        config: normalizedConfig,
        message: `${mode === "add" ? "Added" : "Updated"} global MCP server "${name}" in ${path}`,
      },
      options.json,
    );
    return;
  }

  const [agentName, name] = values;
  const { path, config, agentDir } = await loadAgentConfig(agentName, true);
  if (mode === "add" && config.mcpServers[name]) {
    throw new Error(`agent MCP server already exists: ${agentName}/${name}`);
  }
  config.mcpServers[name] = normalizedConfig;
  await mkdir(agentDir, { recursive: true });
  await writeJson(path, config);
  printResult(
    {
      ok: true,
      scope: "agent",
      mode,
      path,
      agent: agentName,
      name,
      config: normalizedConfig,
      message: `${mode === "add" ? "Added" : "Updated"} agent MCP server "${name}" for agent "${agentName}" in ${path}`,
    },
    options.json,
  );
}

async function cmdRemove(scope, values, options) {
  if (scope === "global") {
    const [name] = values;
    const { path, config } = await loadGlobalConfig(true);
    if (!config.mcpServers?.[name]) {
      throw new Error(`global MCP server not found: ${name}`);
    }
    const removed = config.mcpServers[name];
    delete config.mcpServers[name];
    if (Object.keys(config.mcpServers).length === 0) {
      delete config.mcpServers;
    }
    await writeJson(path, config);
    printResult(
      {
        ok: true,
        scope: "global",
        path,
        name,
        removed,
        message: `Removed global MCP server "${name}" from ${path}`,
      },
      options.json,
    );
    return;
  }

  const [agentName, name] = values;
  const { path, config } = await loadAgentConfig(agentName, true);
  if (!config.mcpServers?.[name]) {
    throw new Error(`agent MCP server not found: ${agentName}/${name}`);
  }
  const removed = config.mcpServers[name];
  delete config.mcpServers[name];
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  await writeJson(path, config);
  printResult(
    {
      ok: true,
      scope: "agent",
      path,
      agent: agentName,
      name,
      removed,
      message: `Removed agent MCP server "${name}" from agent "${agentName}" (${path})`,
    },
    options.json,
  );
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    usage(command ? 0 : 1);
  }

  const { values, options } = parseFlagOptions(rawArgs);

  if (command === "paths") {
    await cmdPaths(options);
    return;
  }

  if (command === "list") {
    await cmdList(values, options);
    return;
  }

  if (command === "get") {
    const [scope, ...rest] = values;
    if (scope === "global") {
      await cmdGet("global", rest, options);
      return;
    }
    if (scope === "agent") {
      await cmdGet("agent", rest, options);
      return;
    }
    throw new Error('get requires scope "global" or "agent"');
  }

  if (command === "add" || command === "set") {
    const [scope, ...rest] = values;
    const mode = command;
    if (scope === "global") {
      await cmdWrite("global", mode, rest, options);
      return;
    }
    if (scope === "agent") {
      await cmdWrite("agent", mode, rest, options);
      return;
    }
    throw new Error(`${command} requires scope "global" or "agent"`);
  }

  if (command === "remove") {
    const [scope, ...rest] = values;
    if (scope === "global") {
      await cmdRemove("global", rest, options);
      return;
    }
    if (scope === "agent") {
      await cmdRemove("agent", rest, options);
      return;
    }
    throw new Error('remove requires scope "global" or "agent"');
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
