import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSkillsConfig, GAgentConfig, SkillsConfig } from "@g-agent/config";
import { type Skill, loadSkillsFromDir } from "../skills/index.js";
import {
  formatSkillsSection,
  joinPromptSections,
  parsePromptFile,
} from "../prompts/index.js";

export type AgentConfig = {
  name: string;
  description: string;
  systemPromptBody: string | null;
  systemPromptPath: string | null;
  /** Injected user memory body (`memory.md`), if any. */
  memoryBody: string | null;
  memoryPath: string | null;
  skills: Skill[];
  skillConflicts: SkillConflict[];
  builtinSkillsPath: string;
  selfSkillsPath: string | null;
  /** Shared global dir (`~/.agents/skills`). */
  sharedSkillsPath: string | null;
  /** g-agent global dir (`~/.config/g-agent/skills`). */
  gagentSkillsPath: string | null;
  /** Dirs watched for skill hot-reload. */
  skillWatchPaths: string[];
  source: "builtin" | "user";
  /** Override the global provider/model reference for this agent.
   *  Format: "provider-name/model-key", e.g. "openai/gpt-4o". */
  provider?: string;
  /** Additional or override provider configurations for this agent,
   *  merged on top of the global providers. Same shape as config.json
   *  providers. */
  providers?: Record<string, unknown>;
  /** MCP servers for this agent, merged on top of global mcpServers. */
  mcpServers?: Record<string, unknown>;
};

export type LoadedAgents = {
  agents: Map<string, AgentConfig>;
  list: AgentConfig[];
  builtinPath: string;
  userPath: string | null;
  sharedSkillsPath: string | null;
  gagentSkillsPath: string | null;
  skillWatchPaths: string[];
  skillConflicts: SkillConflict[];
  defaultName: string;
  defaultSystemBody: string;
};

export type SkillConflict = {
  agent: string;
  name: string;
  selectedSource: Skill["source"];
  candidates: Array<{
    source: Skill["source"];
    path: string;
  }>;
};

const DEFAULT_AGENT_NAME = "default";

const AGENT_JSON = "agent.json";
const SYSTEM_PROMPT_FILE = "system.md";
const MEMORY_FILE = "memory.md";
const BUILTIN_SKILLS_DIR = "builtin-skills";
const USER_SKILLS_DIR = "skills";

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Shared global skills (Cursor-compatible). Default write target for skill-manager. */
export function sharedGlobalSkillsDir(): string {
  return join(homedir(), ".agents", "skills");
}

/** g-agent global skills under user config; merged after shared global. */
export function gAgentGlobalSkillsDir(): string {
  return join(homedir(), ".config", "g-agent", "skills");
}

type SharedGlobalSkillsLoadOptions = {
  skipPaths: string[];
  paths?: string[];
};

function sharedGlobalSkillsDirCandidates(
  options: SharedGlobalSkillsLoadOptions,
): string[] {
  if (options.paths?.length) {
    return options.paths.map(expandHome);
  }

  const candidates: string[] = [];
  if (process.env.G_AGENT_GLOBAL_SKILLS_DIR) {
    candidates.push(process.env.G_AGENT_GLOBAL_SKILLS_DIR);
  }
  candidates.push(sharedGlobalSkillsDir());

  const skip = new Set(options.skipPaths.map(expandHome));
  return [...new Set(candidates.map(expandHome))].filter((path) => !skip.has(path));
}

export function resolveSharedGlobalSkillsWriteDir(
  options: SharedGlobalSkillsLoadOptions,
): string {
  if (options.paths?.length) {
    return expandHome(options.paths[0]!);
  }
  return sharedGlobalSkillsDir();
}

export function resolveSharedGlobalSkillsLoadOptions(
  global?: SkillsConfig,
  agent?: AgentSkillsConfig,
): SharedGlobalSkillsLoadOptions {
  return {
    skipPaths: [...(global?.skipPaths ?? []), ...(agent?.skipPaths ?? [])],
    paths: global?.paths,
  };
}

const sharedGlobalSkillsCache = new Map<string, Skill[]>();
const gagentGlobalSkillsCache = new Map<string, Skill[]>();

async function loadSharedGlobalSkills(
  options: SharedGlobalSkillsLoadOptions,
): Promise<Skill[]> {
  const key = JSON.stringify(options);
  const cached = sharedGlobalSkillsCache.get(key);
  if (cached) {
    return cached;
  }

  const merged = new Map<string, Skill>();
  for (const path of sharedGlobalSkillsDirCandidates(options)) {
    if (!existsSync(path)) continue;
    for (const skill of await loadSkillsFromDir(path, "shared")) {
      merged.set(skill.name, skill);
    }
  }
  const skills = [...merged.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  sharedGlobalSkillsCache.set(key, skills);
  return skills;
}

async function loadGagentGlobalSkills(): Promise<Skill[]> {
  const key = gAgentGlobalSkillsDir();
  const cached = gagentGlobalSkillsCache.get(key);
  if (cached) {
    return cached;
  }

  const skills = existsSync(key)
    ? await loadSkillsFromDir(key, "gagent")
    : [];
  gagentGlobalSkillsCache.set(key, skills);
  return skills;
}

function userAgentsDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

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

function builtinAgentsDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.G_AGENT_BUILTIN_AGENTS_DIR) {
    candidates.push(process.env.G_AGENT_BUILTIN_AGENTS_DIR);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "builtin-agents"));
  }
  candidates.push(join(home, ".config", "g-agent", "builtin-agents"));
  candidates.push(join(home, ".local", "share", "g-agent", "builtin-agents"));

  return [...new Set(candidates)];
}

export function resolveAgentsDir(): string | null {
  for (const path of userAgentsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

/** Prefer the first existing agents dir; fall back to the default config path. */
function agentsBaseDir(): string {
  return (
    resolveAgentsDir() ??
    join(homedir(), ".config", "g-agent", "agents")
  );
}

/**
 * Resolve the per-agent memory.md path (same rules as memory-manager script).
 * Honors `G_AGENT_MEMORY_PATH` when set.
 */
export function resolveAgentMemoryPath(agentName: string): string {
  if (process.env.G_AGENT_MEMORY_PATH?.trim()) {
    return expandHome(process.env.G_AGENT_MEMORY_PATH.trim());
  }
  return join(agentsBaseDir(), agentName, MEMORY_FILE);
}

async function readAgentMemory(agentName: string): Promise<{
  body: string | null;
  path: string | null;
}> {
  const memoryPath = resolveAgentMemoryPath(agentName);
  if (!existsSync(memoryPath)) {
    return { body: null, path: memoryPath };
  }

  const content = (await readFile(memoryPath, "utf8")).trim();
  return { body: content || null, path: memoryPath };
}

function formatMemorySection(body: string, memoryPath: string | null): string {
  const lines = ["## Memory", ""];
  if (memoryPath) {
    lines.push(`Source: \`${memoryPath}\``, "");
  }
  lines.push(body);
  return lines.join("\n");
}

export function resolveBuiltinAgentsDir(): string {
  for (const path of builtinAgentsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return join(import.meta.dir, "builtin");
}

export function resolveGlobalSkillsDir(): string | null {
  const dir = sharedGlobalSkillsDir();
  return existsSync(dir) ? dir : null;
}

/**
 * Merge skills by name. Precedence is self > gagent > shared > builtin.
 */
export function mergeSkills(
  agentName: string,
  builtin: Skill[],
  shared: Skill[],
  gagent: Skill[],
  self: Skill[],
): { skills: Skill[]; conflicts: SkillConflict[] } {
  const map = new Map<string, Skill>();
  const candidates = new Map<string, Skill[]>();
  const ordered = [...builtin, ...shared, ...gagent, ...self];

  for (const skill of ordered) {
    candidates.set(skill.name, [...(candidates.get(skill.name) ?? []), skill]);
  }

  for (const skill of builtin) {
    map.set(skill.name, skill);
  }
  for (const skill of shared) {
    map.set(skill.name, skill);
  }
  for (const skill of gagent) {
    map.set(skill.name, skill);
  }
  for (const skill of self) {
    map.set(skill.name, skill);
  }

  const conflicts: SkillConflict[] = [];
  for (const [name, list] of candidates) {
    if (list.length <= 1) continue;
    const selected = map.get(name);
    if (!selected) continue;
    conflicts.push({
      agent: agentName,
      name,
      selectedSource: selected.source,
      candidates: list.map((skill) => ({
        source: skill.source,
        path: skill.path,
      })),
    });
  }

  return {
    skills: [...map.values()].sort((a, b) => a.name.localeCompare(b.name)),
    conflicts: conflicts.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

type AgentMeta = {
  description: string;
  provider?: string;
  providers?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  skills?: AgentSkillsConfig;
};

function normalizeAgentSkillsConfig(value: unknown): AgentSkillsConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const config: AgentSkillsConfig = {};

  if (raw.shared !== undefined) {
    if (typeof raw.shared !== "boolean") {
      return undefined;
    }
    config.shared = raw.shared;
  } else if (raw.loadAgentsSkills === false) {
    config.shared = false;
  }
  if (raw.global !== undefined) {
    if (typeof raw.global !== "boolean") {
      return undefined;
    }
    config.global = raw.global;
  }
  if (raw.gagent !== undefined) {
    if (typeof raw.gagent !== "boolean") {
      return undefined;
    }
    config.gagent = raw.gagent;
  }
  if (Array.isArray(raw.skipPaths)) {
    const skipPaths = raw.skipPaths.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    if (skipPaths.length > 0) {
      config.skipPaths = skipPaths;
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function isSharedGlobalEnabled(
  global?: SkillsConfig,
  agent?: AgentSkillsConfig,
): boolean {
  if (agent?.shared === false || agent?.global === false) return false;
  if (global?.shared === false) return false;
  return true;
}

function isGagentGlobalEnabled(
  global?: SkillsConfig,
  agent?: AgentSkillsConfig,
): boolean {
  if (agent?.gagent === false) return false;
  if (global?.gagent === false) return false;
  return true;
}

async function readAgentMeta(dir: string): Promise<AgentMeta> {
  const metaPath = join(dir, AGENT_JSON);
  if (!existsSync(metaPath)) {
    return { description: "" };
  }

  try {
    const raw = JSON.parse(await readFile(metaPath, "utf8")) as {
      description?: unknown;
      provider?: unknown;
      providers?: unknown;
      mcpServers?: unknown;
      skills?: unknown;
    };
    return {
      description: typeof raw.description === "string" ? raw.description : "",
      provider:
        typeof raw.provider === "string" && raw.provider.trim()
          ? raw.provider.trim()
          : undefined,
      providers:
        typeof raw.providers === "object" && raw.providers !== null && !Array.isArray(raw.providers)
          ? (raw.providers as Record<string, unknown>)
          : undefined,
      mcpServers:
        typeof raw.mcpServers === "object" && raw.mcpServers !== null && !Array.isArray(raw.mcpServers)
          ? (raw.mcpServers as Record<string, unknown>)
          : undefined,
      skills: normalizeAgentSkillsConfig(raw.skills),
    };
  } catch {
    return { description: "" };
  }
}

async function readSystemPrompt(dir: string): Promise<{
  body: string | null;
  path: string | null;
}> {
  const promptPath = join(dir, SYSTEM_PROMPT_FILE);
  if (!existsSync(promptPath)) {
    return { body: null, path: null };
  }

  const content = await readFile(promptPath, "utf8");
  const { body } = parsePromptFile(content);
  return { body, path: promptPath };
}

async function loadAgentDir(
  dir: string,
  name: string,
  source: "builtin" | "user",
  globalSkillsConfig?: SkillsConfig,
): Promise<AgentConfig> {
  const [meta, { body, path: systemPromptPath }, memory] = await Promise.all([
    readAgentMeta(dir),
    readSystemPrompt(dir),
    readAgentMemory(name),
  ]);

  // Built-in `default` is shipped with the package. User overlay under
  // ~/.config/g-agent/agents/default/ may customize memory, system.md, and
  // self skills — but never user-side builtin-skills/.
  const isDefaultUserOverlay = name === DEFAULT_AGENT_NAME && source === "user";
  const builtinSkillsPath = isDefaultUserOverlay
    ? join(resolveBuiltinAgentsDir(), DEFAULT_AGENT_NAME, BUILTIN_SKILLS_DIR)
    : join(dir, BUILTIN_SKILLS_DIR);
  const selfSkillsPath = join(dir, USER_SKILLS_DIR);
  const hasSelfSkills = existsSync(selfSkillsPath);

  let sharedSkills: Skill[] = [];
  let gagentSkills: Skill[] = [];
  const sharedSkillsPath = sharedGlobalSkillsDir();
  const gagentSkillsPath = gAgentGlobalSkillsDir();
  const skillWatchPaths: string[] = [];
  const sharedOptions = resolveSharedGlobalSkillsLoadOptions(
    globalSkillsConfig,
    meta.skills,
  );
  const sharedEnabled = isSharedGlobalEnabled(globalSkillsConfig, meta.skills);
  const gagentEnabled = isGagentGlobalEnabled(globalSkillsConfig, meta.skills);

  if (sharedEnabled) {
    sharedSkills = await loadSharedGlobalSkills(sharedOptions);
    if (existsSync(sharedSkillsPath)) {
      skillWatchPaths.push(sharedSkillsPath);
    }
  }
  if (gagentEnabled) {
    gagentSkills = await loadGagentGlobalSkills();
    if (existsSync(gagentSkillsPath)) {
      skillWatchPaths.push(gagentSkillsPath);
    }
  }

  const [builtinSkills, selfSkills] = await Promise.all([
    loadSkillsFromDir(builtinSkillsPath, "builtin"),
    hasSelfSkills ? loadSkillsFromDir(selfSkillsPath, "self") : Promise.resolve([]),
  ]);
  const { skills, conflicts } = mergeSkills(
    name,
    builtinSkills,
    sharedSkills,
    gagentSkills,
    selfSkills,
  );

  return {
    name,
    description: meta.description,
    systemPromptBody: body,
    systemPromptPath,
    memoryBody: memory.body,
    memoryPath: memory.path,
    skills,
    skillConflicts: conflicts,
    builtinSkillsPath,
    selfSkillsPath: hasSelfSkills ? selfSkillsPath : null,
    sharedSkillsPath: sharedEnabled ? sharedSkillsPath : null,
    gagentSkillsPath: gagentEnabled ? gagentSkillsPath : null,
    skillWatchPaths,
    source,
    provider: meta.provider,
    providers: meta.providers,
    mcpServers: meta.mcpServers,
  };
}

async function loadAgentsFromDir(
  dir: string,
  source: "builtin" | "user",
  globalSkillsConfig?: SkillsConfig,
): Promise<AgentConfig[]> {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    agents.push(await loadAgentDir(
      join(dir, entry.name),
      entry.name,
      source,
      globalSkillsConfig,
    ));
  }

  return agents;
}

export function clearGlobalSkillsCache(): void {
  sharedGlobalSkillsCache.clear();
  gagentGlobalSkillsCache.clear();
}

export async function loadAgents(config?: GAgentConfig): Promise<LoadedAgents> {
  const builtinPath = resolveBuiltinAgentsDir();
  const userPath = resolveAgentsDir();
  const globalSkillsConfig = config?.skills;

  const [builtinAgents, userAgents] = await Promise.all([
    loadAgentsFromDir(builtinPath, "builtin", globalSkillsConfig),
    userPath ? loadAgentsFromDir(userPath, "user", globalSkillsConfig) : Promise.resolve([]),
  ]);

  // User agents override builtin agents with the same name. The user-side
  // `default` directory is an overlay: omitted metadata inherits the bundled
  // default instead of accidentally disabling newly shipped capabilities.
  const agents = new Map<string, AgentConfig>();
  for (const agent of builtinAgents) {
    agents.set(agent.name, agent);
  }
  for (const agent of userAgents) {
    const builtin = agents.get(agent.name);
    if (agent.name === DEFAULT_AGENT_NAME && builtin) {
      agents.set(agent.name, {
        ...agent,
        description: agent.description || builtin.description,
        systemPromptBody:
          agent.systemPromptBody ?? builtin.systemPromptBody,
        systemPromptPath:
          agent.systemPromptPath ?? builtin.systemPromptPath,
        provider: agent.provider ?? builtin.provider,
        providers: agent.providers ?? builtin.providers,
        mcpServers: agent.mcpServers ?? builtin.mcpServers,
        source: "user",
      });
      continue;
    }
    agents.set(agent.name, { ...agent, source: "user" });
  }

  const list = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const skillConflicts = list.flatMap((agent) => agent.skillConflicts);

  const defaultAgent = agents.get(DEFAULT_AGENT_NAME);
  const defaultSystemBody = defaultAgent?.systemPromptBody ?? "";

  return {
    agents,
    list,
    builtinPath,
    userPath,
    sharedSkillsPath: sharedGlobalSkillsDir(),
    gagentSkillsPath: gAgentGlobalSkillsDir(),
    skillWatchPaths: [
      sharedGlobalSkillsDir(),
      gAgentGlobalSkillsDir(),
    ].filter((path) => existsSync(path)),
    skillConflicts,
    defaultName: DEFAULT_AGENT_NAME,
    defaultSystemBody,
  };
}

export type ResolvedAgent = {
  agent: AgentConfig;
  /** Present when the requested agent didn't exist and we fell back to the
   * built-in `default`. `requested` is the name that was asked for. */
  fallback?: { requested: string };
};

export function resolveActiveAgent(
  name: string | undefined,
  loaded: LoadedAgents,
): ResolvedAgent {
  const explicit = name?.trim() || undefined;

  // An explicit agent name (from config.agent) takes precedence. If it names
  // an agent that doesn't exist, fall back to the built-in default rather than
  // aborting startup — `default` is the last-resort fallback, not something we
  // want to hard-fail on. Runtime switches via the TUI still validate strictly.
  if (explicit) {
    const agent = loaded.agents.get(explicit);
    if (agent) {
      return { agent };
    }
    console.warn(
      `Unknown agent "${explicit}", falling back to "${loaded.defaultName}"`,
    );
  }

  const fallbackAgent = loaded.agents.get(loaded.defaultName);
  if (fallbackAgent) {
    return explicit
      ? { agent: fallbackAgent, fallback: { requested: explicit } }
      : { agent: fallbackAgent };
  }

  const first = loaded.list[0];
  if (!first) {
    throw new Error("No agents configured");
  }
  return { agent: first };
}

export function buildAgentSystemPrompt(
  agent: AgentConfig,
  loaded: LoadedAgents,
): string {
  const body = agent.systemPromptBody ?? loaded.defaultSystemBody;
  const builtinSkills = agent.skills.filter((s) => s.source === "builtin");
  const sharedSkills = agent.skills.filter((s) => s.source === "shared");
  const gagentSkills = agent.skills.filter((s) => s.source === "gagent");
  const selfSkills = agent.skills.filter((s) => s.source === "self");
  const memorySection =
    agent.memoryBody != null
      ? formatMemorySection(agent.memoryBody, agent.memoryPath)
      : "";

  return joinPromptSections(
    body,
    memorySection,
    formatSkillsSection(
      builtinSkills,
      "Built-in skills",
      agent.builtinSkillsPath,
      "Shipped with this agent (g-agent package or this agent's `builtin-skills/`). Always loaded for this agent. **Lowest precedence** on name conflicts. To add/remove: use **agent-manager** (not skill-manager).",
    ),
    formatSkillsSection(
      sharedSkills,
      "Shared global skills",
      agent.sharedSkillsPath,
      "Shared with Cursor and other tools at `~/.agents/skills/` (unless `skills.shared: false` in config.json or agent.json). **Lower precedence** than g-agent global and self. To add/remove: use **skill-manager** (`shared` scope; `global` is a legacy alias).",
    ),
    formatSkillsSection(
      gagentSkills,
      "g-agent global skills",
      agent.gagentSkillsPath,
      "g-agent install-wide skills at `~/.config/g-agent/skills/` (unless `skills.gagent: false`). Overrides shared global on name conflicts; overridden by self. To add/remove: use **skill-manager** (`gagent` scope).",
    ),
    formatSkillsSection(
      selfSkills,
      "Self skills (agent-exclusive)",
      agent.selfSkillsPath,
      "Only for the **current agent** — not visible to other agents. **Highest precedence** on name conflicts. To add/remove: use **skill-manager** (`self` scope).",
    ),
  );
}
