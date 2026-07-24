#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_DIR = join(homedir(), ".config", "g-agent");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundledDefaultAgentDir = join(scriptDir, "..", "..", "..");

function usage(exitCode = 0) {
  const text = `Usage:
  skill.mjs paths [--json]
  skill.mjs list [--agent <name>] [--global-only] [--json]
  skill.mjs resolve <name> [--agent <name>] [--json]
  skill.mjs get global <name> [--json]
  skill.mjs get self <agent> <name> [--json]
  skill.mjs add global <name> --description "<desc>" [--body "<markdown>"] [--json]
  skill.mjs add self <agent> <name> --description "<desc>" [--body "<markdown>"] [--json]
  skill.mjs set global <name> --description "<desc>" [--body "<markdown>"] [--json]
  skill.mjs set self <agent> <name> --description "<desc>" [--body "<markdown>"] [--json]
  skill.mjs remove global <name> [--json]
  skill.mjs remove self <agent> <name> [--json]
  skill.mjs config get global [--json]
  skill.mjs config get agent <name> [--json]
  skill.mjs config set global [--skills-json '<skills>'] [--load-agents-skills true|false] [--skip-path <path>...] [--paths <path>...]
  skill.mjs config set agent <name> [--skills-json '<skills>'] [--global true|false] [--load-agents-skills true|false] [--skip-path <path>...]`;
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

function agentsDirCandidates() {
  const home = homedir();
  const candidates = [];
  if (process.env.G_AGENT_AGENTS_DIR) candidates.push(process.env.G_AGENT_AGENTS_DIR);
  if (process.env.G_AGENT_HOME) candidates.push(join(process.env.G_AGENT_HOME, "agents"));
  candidates.push(join(home, ".config", "g-agent", "agents"));
  candidates.push(join(home, ".local", "share", "g-agent", "agents"));
  return [...new Set(candidates)];
}

function agentsSkillsDir() {
  return join(homedir(), ".agents", "skills");
}

function defaultGlobalSkillsDir() {
  return join(homedir(), ".agent", "skills");
}

function resolveConfigPath(forWrite = false) {
  for (const path of configCandidates()) {
    if (existsSync(path)) return path;
  }
  if (forWrite) {
    return process.env.G_AGENT_CONFIG ?? join(DEFAULT_CONFIG_DIR, "config.json");
  }
  return null;
}

function resolveAgentsDir(forWrite = false) {
  for (const path of agentsDirCandidates()) {
    if (existsSync(path)) return path;
  }
  if (forWrite) return join(DEFAULT_CONFIG_DIR, "agents");
  return null;
}

function resolveAgentDir(agentName, forWrite = false) {
  const agentsDir = resolveAgentsDir(forWrite);
  if (!agentsDir) return null;
  return join(agentsDir, agentName);
}

function resolveBundledDefaultAgentDir() {
  if (existsSync(join(bundledDefaultAgentDir, "system.md"))) {
    return bundledDefaultAgentDir;
  }
  for (const path of builtinAgentsDirCandidates()) {
    const candidate = join(path, "default");
    if (existsSync(join(candidate, "system.md"))) return candidate;
  }
  return bundledDefaultAgentDir;
}

function builtinAgentsDirCandidates() {
  const home = homedir();
  const candidates = [];
  if (process.env.G_AGENT_BUILTIN_AGENTS_DIR) candidates.push(process.env.G_AGENT_BUILTIN_AGENTS_DIR);
  if (process.env.G_AGENT_HOME) candidates.push(join(process.env.G_AGENT_HOME, "builtin-agents"));
  candidates.push(join(home, ".config", "g-agent", "builtin-agents"));
  candidates.push(join(home, ".local", "share", "g-agent", "builtin-agents"));
  return [...new Set(candidates)];
}

async function readJson(path, fallback = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseSkillFile(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body: match[2].trim() };
}

function buildSkillFile(name, description, body) {
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    body.trim(),
    "",
  ].join("\n");
  return frontmatter;
}

async function loadSkillsFromDir(dir, source) {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const content = await readFile(skillPath, "utf8");
    const { meta, body } = parseSkillFile(content);
    skills.push({
      name: String(meta.name ?? entry.name),
      description: String(meta.description ?? ""),
      path: skillPath,
      dir: dirname(skillPath),
      body,
      source,
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function resolveGlobalSkillsLoadOptions(config, agentConfig) {
  const globalSkills = config.skills ?? {};
  const agentSkills = agentConfig?.skills ?? {};
  return {
    loadAgentsSkills:
      agentSkills.loadAgentsSkills ?? globalSkills.loadAgentsSkills ?? true,
    skipPaths: [...(globalSkills.skipPaths ?? []), ...(agentSkills.skipPaths ?? [])],
    paths: globalSkills.paths,
  };
}

function globalSkillsDirCandidates(options) {
  const home = homedir();
  let candidates;

  if (options.paths?.length) {
    candidates = options.paths.map(expandHome);
  } else {
    candidates = [];
    if (process.env.G_AGENT_GLOBAL_SKILLS_DIR) {
      candidates.push(process.env.G_AGENT_GLOBAL_SKILLS_DIR);
    }
    if (process.env.G_AGENT_HOME) {
      candidates.push(join(process.env.G_AGENT_HOME, "skills"));
    }
    candidates.push(defaultGlobalSkillsDir());
    candidates.push(agentsSkillsDir());
    candidates.push(join(home, ".config", "g-agent", "skills"));
    candidates.push(join(home, ".local", "share", "g-agent", "skills"));
  }

  const skip = new Set(options.skipPaths.map(expandHome));
  if (!options.loadAgentsSkills) skip.add(agentsSkillsDir());

  return [...new Set(candidates.map(expandHome))].filter((path) => !skip.has(path));
}

function resolveGlobalSkillsDir(options, forWrite = false) {
  for (const path of globalSkillsDirCandidates(options)) {
    if (existsSync(path)) return path;
  }
  if (forWrite) {
    if (options.paths?.length) return expandHome(options.paths[0]);
    return defaultGlobalSkillsDir();
  }
  return null;
}

function allGlobalSkillsDirCandidates() {
  const home = homedir();
  const candidates = [];
  if (process.env.G_AGENT_GLOBAL_SKILLS_DIR) candidates.push(process.env.G_AGENT_GLOBAL_SKILLS_DIR);
  if (process.env.G_AGENT_HOME) candidates.push(join(process.env.G_AGENT_HOME, "skills"));
  candidates.push(defaultGlobalSkillsDir());
  candidates.push(agentsSkillsDir());
  candidates.push(join(home, ".config", "g-agent", "skills"));
  candidates.push(join(home, ".local", "share", "g-agent", "skills"));
  return [...new Set(candidates.map(expandHome))];
}

function parseFlagOptions(args) {
  const values = [];
  const options = {
    json: false,
    globalOnly: false,
    agent: null,
    description: null,
    body: null,
    loadAgentsSkills: undefined,
    global: undefined,
    skipPath: [],
    paths: [],
    configJson: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--global-only") {
      options.globalOnly = true;
      continue;
    }
    if (arg === "--agent") {
      options.agent = args[++i];
      if (!options.agent) throw new Error("--agent requires a value");
      continue;
    }
    if (arg === "--description") {
      options.description = args[++i];
      if (!options.description) throw new Error("--description requires a value");
      continue;
    }
    if (arg === "--body") {
      options.body = args[++i];
      if (options.body === undefined) throw new Error("--body requires a value");
      continue;
    }
    if (arg === "--load-agents-skills") {
      const value = args[++i];
      if (value !== "true" && value !== "false") {
        throw new Error("--load-agents-skills requires true or false");
      }
      options.loadAgentsSkills = value === "true";
      continue;
    }
    if (arg === "--global") {
      const value = args[++i];
      if (value !== "true" && value !== "false") {
        throw new Error("--global requires true or false");
      }
      options.global = value === "true";
      continue;
    }
    if (arg === "--skip-path") {
      const value = args[++i];
      if (!value) throw new Error("--skip-path requires a value");
      options.skipPath.push(value);
      continue;
    }
    if (arg === "--paths") {
      const value = args[++i];
      if (!value) throw new Error("--paths requires a value");
      options.paths.push(value);
      continue;
    }
    if (arg === "--skills-json") {
      options.configJson = args[++i];
      if (!options.configJson) throw new Error("--skills-json requires a JSON value");
      continue;
    }
    values.push(arg);
  }

  return { values, options };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(result.message ?? result);
}

const BUILTIN_READONLY_ERROR =
  'Built-in skills cannot be created, modified, or deleted via skill-manager. ' +
  "Ask the user to choose global or self instead, or use agent-manager for an agent's builtin-skills/.";

function assertWritableScope(scope, command) {
  if (scope === "builtin") {
    throw new Error(BUILTIN_READONLY_ERROR);
  }
  if (scope !== "global" && scope !== "self") {
    throw new Error(`${command} requires scope "global" or "self"`);
  }
}

function summarizeSkill(skill, extra = {}) {
  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    dir: skill.dir,
    source: skill.source,
    ...extra,
  };
}

async function loadGlobalConfig(forWrite = false) {
  const path = resolveConfigPath(forWrite);
  if (!path) throw new Error("config.json not found");
  const config = await readJson(path, {});
  return { path, config };
}

async function loadAgentConfig(agentName, forWrite = false) {
  const agentDir = resolveAgentDir(agentName, forWrite);
  if (!agentDir) throw new Error("agents directory not found");
  const path = join(agentDir, "agent.json");
  const config = await readJson(path, { description: "" });
  return { path, config, agentDir };
}

async function resolveAgentSkillSources(agentName) {
  const { config } = await loadGlobalConfig();
  let agentConfig = {};
  const userAgentDir = resolveAgentDir(agentName);
  if (userAgentDir && existsSync(join(userAgentDir, "agent.json"))) {
    agentConfig = await readJson(join(userAgentDir, "agent.json"), {});
  }

  const loadOptions = resolveGlobalSkillsLoadOptions(config, agentConfig);
  const globalEnabled = agentConfig.skills?.global !== false;

  let builtinDir;
  if (agentName === "default") {
    // Built-in default agent skills always ship with the package.
    builtinDir = join(resolveBundledDefaultAgentDir(), "builtin-skills");
  } else if (userAgentDir && existsSync(join(userAgentDir, "builtin-skills"))) {
    builtinDir = join(userAgentDir, "builtin-skills");
  } else if (userAgentDir) {
    builtinDir = join(userAgentDir, "builtin-skills");
  } else {
    builtinDir = join(resolveBundledDefaultAgentDir(), "builtin-skills");
  }

  const selfDir = userAgentDir ? join(userAgentDir, "skills") : null;
  const globalDir = globalEnabled
    ? resolveGlobalSkillsDir(loadOptions)
    : null;

  const [builtin, global, self] = await Promise.all([
    loadSkillsFromDir(builtinDir, "builtin"),
    globalDir ? loadSkillsFromDir(globalDir, "global") : Promise.resolve([]),
    selfDir ? loadSkillsFromDir(selfDir, "self") : Promise.resolve([]),
  ]);

  const merged = new Map();
  for (const skill of builtin) merged.set(skill.name, skill);
  for (const skill of global) merged.set(skill.name, skill);
  for (const skill of self) merged.set(skill.name, skill);

  return {
    agent: agentName,
    userAgentDir,
    globalEnabled,
    globalDir,
    builtinDir,
    selfDir,
    loadOptions,
    builtin: builtin.map((skill) =>
      summarizeSkill(skill, { readOnly: true, managedBy: "agent-manager" }),
    ),
    global,
    self,
    effective: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    writableLayers: ["global", "self"],
  };
}

async function cmdResolve(values, options) {
  const [name] = values;
  if (!name) throw new Error("resolve requires a skill name");

  const agentName = options.agent ?? "default";
  const view = await resolveAgentSkillSources(agentName);
  const layers = {
    builtin: view.builtin.find((item) => item.name === name) ?? null,
    global: view.global.find((item) => item.name === name) ?? null,
    self: view.self.find((item) => item.name === name) ?? null,
  };
  const effective = view.effective.find((item) => item.name === name);

  const result = {
    name,
    agent: agentName,
    layers: {
      builtin: layers.builtin,
      global: layers.global ? summarizeSkill(layers.global) : null,
      self: layers.self ? summarizeSkill(layers.self) : null,
    },
    effective: effective?.source ?? null,
    skillManagerWritable: Boolean(layers.global || layers.self),
    skillManagerOptions: {
      global: {
        label: "global（全局）",
        description: "All agents can use it (unless disabled per agent)",
        add: `add global ${name}`,
        set: `set global ${name}`,
        remove: `remove global ${name}`,
      },
      self: {
        label: "self（专属）",
        description: `Only agent "${agentName}" can use it`,
        add: `add self ${agentName} ${name}`,
        set: `set self ${agentName} ${name}`,
        remove: `remove self ${agentName} ${name}`,
      },
    },
    builtinNote: layers.builtin
      ? "Built-in skills are read-only here. To bundle a skill with an agent, use agent-manager (builtin-skills/). Package built-ins cannot be edited."
      : null,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Skill: ${name} (agent: ${agentName})`);
  if (layers.builtin) {
    console.log(`  [builtin] read-only — ${layers.builtin.description}`);
    console.log(`    path: ${layers.builtin.path}`);
    console.log(`    managed by: agent-manager (not skill-manager)`);
  }
  if (layers.global) {
    console.log(`  [global] writable — ${layers.global.description}`);
    console.log(`    path: ${layers.global.path}`);
  }
  if (layers.self) {
    console.log(`  [self] writable — ${layers.self.description}`);
    console.log(`    path: ${layers.self.path}`);
  }
  if (!layers.builtin && !layers.global && !layers.self) {
    console.log("  (not found in any layer for this agent)");
  }
  console.log(`Effective source: ${result.effective ?? "(none)"}`);
  if (result.builtinNote) {
    console.log(`Note: ${result.builtinNote}`);
  }
}

async function cmdPaths(options) {
  const configPath = resolveConfigPath();
  const { config } = configPath ? await loadGlobalConfig() : { config: {} };
  const loadOptions = resolveGlobalSkillsLoadOptions(config, {});
  const result = {
    configPath,
    configWritePath: resolveConfigPath(true),
    agentsDir: resolveAgentsDir(),
    agentsWriteDir: resolveAgentsDir(true),
    globalSkillsDir: resolveGlobalSkillsDir(loadOptions),
    globalWriteDir: resolveGlobalSkillsDir(loadOptions, true),
    globalCandidates: globalSkillsDirCandidates(loadOptions),
    allGlobalCandidates: allGlobalSkillsDirCandidates(),
    bundledDefaultAgentDir: resolveBundledDefaultAgentDir(),
    skillsConfig: config.skills ?? {},
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`config: ${result.configPath ?? "(none)"}`);
  console.log(`config (write): ${result.configWritePath}`);
  console.log(`agents: ${result.agentsDir ?? "(none)"}`);
  console.log(`global skills: ${result.globalSkillsDir ?? "(none)"}`);
  console.log(`global skills (write): ${result.globalWriteDir}`);
  console.log(`bundled default agent: ${result.bundledDefaultAgentDir}`);
}

async function cmdListGlobalOnly(options) {
  const { config, path } = await loadGlobalConfig();
  const loadOptions = resolveGlobalSkillsLoadOptions(config, {});
  const globalDir = resolveGlobalSkillsDir(loadOptions);
  const global = globalDir
    ? await loadSkillsFromDir(globalDir, "global")
    : [];

  if (options.json) {
    console.log(
      JSON.stringify({ configPath: path, globalDir, skills: global }, null, 2),
    );
    return;
  }

  if (global.length === 0) {
    console.log(`(empty) global skills dir: ${globalDir ?? "(none)"}`);
    return;
  }
  for (const skill of global) {
    console.log(`[global] ${skill.name} — ${skill.description}`);
  }
  console.log(`dir: ${globalDir}`);
}

async function cmdList(values, options) {
  if (options.globalOnly) {
    await cmdListGlobalOnly(options);
    return;
  }

  const agentName = options.agent ?? "default";
  const view = await resolveAgentSkillSources(agentName);
  if (options.json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  console.log(`Agent: ${agentName}`);
  console.log(`Global enabled: ${view.globalEnabled}`);
  console.log("Builtin:");
  if (view.builtin.length === 0) console.log("  (empty)");
  for (const skill of view.builtin) {
    console.log(`  [builtin] ${skill.name} — ${skill.description} (read-only, use agent-manager)`);
  }
  console.log("Global:");
  if (view.global.length === 0) console.log("  (empty)");
  for (const skill of view.global) {
    console.log(`  [global] ${skill.name} — ${skill.description}`);
  }
  console.log("Self:");
  if (view.self.length === 0) console.log("  (empty)");
  for (const skill of view.self) {
    console.log(`  [self] ${skill.name} — ${skill.description}`);
  }
  console.log("Effective merge (self > global > builtin):");
  for (const skill of view.effective) {
    console.log(`  [${skill.source}] ${skill.name} — ${skill.description}`);
  }
}

async function cmdGet(scope, values, options) {
  if (scope === "global") {
    const [name] = values;
    const { config } = await loadGlobalConfig();
    const loadOptions = resolveGlobalSkillsLoadOptions(config, {});
    const globalDir = resolveGlobalSkillsDir(loadOptions);
    if (!globalDir) throw new Error("global skills directory not found");
    const skills = await loadSkillsFromDir(globalDir, "global");
    const skill = skills.find((item) => item.name === name);
    if (!skill) throw new Error(`global skill not found: ${name}`);
    if (options.json) {
      console.log(JSON.stringify({ scope: "global", dir: globalDir, skill }, null, 2));
      return;
    }
    console.log(`[global] ${skill.name} — ${skill.description}`);
    console.log(`path: ${skill.path}`);
    return;
  }

  const [agentName, name] = values;
  const view = await resolveAgentSkillSources(agentName);
  const skill = view.self.find((item) => item.name === name);
  if (!skill) throw new Error(`self skill not found: ${agentName}/${name}`);
  if (options.json) {
    console.log(JSON.stringify({ scope: "self", agent: agentName, skill }, null, 2));
    return;
  }
  console.log(`[self:${agentName}] ${skill.name} — ${skill.description}`);
  console.log(`path: ${skill.path}`);
}

async function writeSkill(scope, mode, values, options) {
  const description = options.description;
  if (!description?.trim()) {
    throw new Error("--description is required");
  }

  if (scope === "global") {
    const [name] = values;
    const { path, config } = await loadGlobalConfig(true);
    const loadOptions = resolveGlobalSkillsLoadOptions(config, {});
    const globalDir = resolveGlobalSkillsDir(loadOptions, true);
    const skillDir = join(globalDir, name);
    const skillPath = join(skillDir, "SKILL.md");

    if (mode === "add" && existsSync(skillPath)) {
      throw new Error(`global skill already exists: ${name}`);
    }

    let body = options.body ?? "";
    if (!body && existsSync(skillPath)) {
      body = parseSkillFile(await readFile(skillPath, "utf8")).body;
    }
    if (!body) body = `# ${name}\n\nDescribe the workflow here.`;

    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, buildSkillFile(name, description, body), "utf8");
    printResult(
      {
        ok: true,
        scope: "global",
        mode,
        path: skillPath,
        name,
        message: `${mode === "add" ? "Added" : "Updated"} global skill "${name}" at ${skillPath}`,
      },
      options.json,
    );
    return;
  }

  const [agentName, name] = values;
  const { agentDir } = await loadAgentConfig(agentName, true);
  const skillDir = join(agentDir, "skills", name);
  const skillPath = join(skillDir, "SKILL.md");

  if (mode === "add" && existsSync(skillPath)) {
    throw new Error(`self skill already exists: ${agentName}/${name}`);
  }

  let body = options.body ?? "";
  if (!body && existsSync(skillPath)) {
    body = parseSkillFile(await readFile(skillPath, "utf8")).body;
  }
  if (!body) body = `# ${name}\n\nDescribe the workflow here.`;

  await mkdir(skillDir, { recursive: true });
  await writeFile(skillPath, buildSkillFile(name, description, body), "utf8");
  printResult(
    {
      ok: true,
      scope: "self",
      mode,
      path: skillPath,
      agent: agentName,
      name,
      message: `${mode === "add" ? "Added" : "Updated"} self skill "${name}" for agent "${agentName}" at ${skillPath}`,
    },
    options.json,
  );
}

async function cmdRemove(scope, values, options) {
  if (scope === "global") {
    const [name] = values;
    const { config } = await loadGlobalConfig();
    const loadOptions = resolveGlobalSkillsLoadOptions(config, {});
    const globalDir = resolveGlobalSkillsDir(loadOptions, true);
    const skillDir = join(globalDir, name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) throw new Error(`global skill not found: ${name}`);
    await rm(skillDir, { recursive: true, force: true });
    printResult(
      {
        ok: true,
        scope: "global",
        name,
        path: skillDir,
        message: `Removed global skill "${name}" from ${skillDir}`,
      },
      options.json,
    );
    return;
  }

  const [agentName, name] = values;
  const { agentDir } = await loadAgentConfig(agentName, true);
  const skillDir = join(agentDir, "skills", name);
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`self skill not found: ${agentName}/${name}`);
  await rm(skillDir, { recursive: true, force: true });
  printResult(
    {
      ok: true,
      scope: "self",
      agent: agentName,
      name,
      path: skillDir,
      message: `Removed self skill "${name}" from agent "${agentName}" (${skillDir})`,
    },
    options.json,
  );
}

async function cmdConfigGet(scope, values, options) {
  if (scope === "global") {
    const { path, config } = await loadGlobalConfig();
    const result = { scope: "global", path, skills: config.skills ?? {} };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`config: ${path}`);
    console.log(JSON.stringify(result.skills, null, 2));
    return;
  }

  const [agentName] = values;
  const { path, config } = await loadAgentConfig(agentName);
  const result = { scope: "agent", path, agent: agentName, skills: config.skills ?? {} };
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`agent: ${path}`);
  console.log(JSON.stringify(result.skills, null, 2));
}

async function cmdConfigSet(scope, values, options) {
  if (scope === "global") {
    const { path, config } = await loadGlobalConfig(true);
    const skills = options.configJson
      ? JSON.parse(options.configJson)
      : { ...(config.skills ?? {}) };

    if (options.loadAgentsSkills !== undefined) {
      skills.loadAgentsSkills = options.loadAgentsSkills;
    }
    if (options.skipPath.length > 0) {
      skills.skipPaths = [...new Set([...(skills.skipPaths ?? []), ...options.skipPath])];
    }
    if (options.paths.length > 0) {
      skills.paths = options.paths;
    }

    config.skills = skills;
    await writeJson(path, config);
    printResult(
      {
        ok: true,
        scope: "global",
        path,
        skills,
        message: `Updated global skills config in ${path}`,
      },
      options.json,
    );
    return;
  }

  const [agentName] = values;
  const { path, config, agentDir } = await loadAgentConfig(agentName, true);
  const skills = options.configJson
    ? JSON.parse(options.configJson)
    : { ...(config.skills ?? {}) };

  if (options.global !== undefined) skills.global = options.global;
  if (options.loadAgentsSkills !== undefined) {
    skills.loadAgentsSkills = options.loadAgentsSkills;
  }
  if (options.skipPath.length > 0) {
    skills.skipPaths = [...new Set([...(skills.skipPaths ?? []), ...options.skipPath])];
  }

  config.skills = skills;
  await mkdir(agentDir, { recursive: true });
  await writeJson(path, config);
  printResult(
    {
      ok: true,
      scope: "agent",
      path,
      agent: agentName,
      skills,
      message: `Updated agent skills config for "${agentName}" in ${path}`,
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

  if (command === "resolve") {
    await cmdResolve(values, options);
    return;
  }

  if (command === "get") {
    const [scope, ...rest] = values;
    assertWritableScope(scope, "get");
    if (scope === "global") {
      await cmdGet("global", rest, options);
      return;
    }
    if (scope === "self") {
      await cmdGet("self", rest, options);
      return;
    }
  }

  if (command === "add" || command === "set") {
    const [scope, ...rest] = values;
    assertWritableScope(scope, command);
    const mode = command;
    if (scope === "global") {
      await writeSkill("global", mode, rest, options);
      return;
    }
    if (scope === "self") {
      await writeSkill("self", mode, rest, options);
      return;
    }
  }

  if (command === "remove") {
    const [scope, ...rest] = values;
    assertWritableScope(scope, "remove");
    if (scope === "global") {
      await cmdRemove("global", rest, options);
      return;
    }
    if (scope === "self") {
      await cmdRemove("self", rest, options);
      return;
    }
  }

  if (command === "config") {
    const [sub, scope, ...rest] = values;
    if (sub === "get" && scope === "global") {
      await cmdConfigGet("global", rest, options);
      return;
    }
    if (sub === "get" && scope === "agent") {
      await cmdConfigGet("agent", rest, options);
      return;
    }
    if (sub === "set" && scope === "global") {
      await cmdConfigSet("global", rest, options);
      return;
    }
    if (sub === "set" && scope === "agent") {
      await cmdConfigSet("agent", rest, options);
      return;
    }
    throw new Error("config requires get|set with scope global|agent");
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
