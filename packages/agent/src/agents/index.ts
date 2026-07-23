import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSkillsConfig, GAgentConfig, SkillsConfig } from "@g-agent/config";
import { type Skill, loadSkillsFromDir } from "../skills/index.js";
import {
  formatBuiltinSkillsSection,
  formatSkillsSection,
  joinPromptSections,
  parsePromptFile,
} from "../prompts/index.js";

export type AgentConfig = {
  name: string;
  description: string;
  systemPromptBody: string | null;
  systemPromptPath: string | null;
  skills: Skill[];
  skillConflicts: SkillConflict[];
  builtinSkillsPath: string;
  selfSkillsPath: string | null;
  globalSkillsPath: string | null;
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
  globalSkillsPath: string | null;
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
const BUILTIN_SKILLS_DIR = "builtin-skills";
const USER_SKILLS_DIR = "skills";

type GlobalSkillsLoadOptions = {
  loadAgentsSkills: boolean;
  skipPaths: string[];
  paths?: string[];
};

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function agentsSkillsDir(): string {
  return join(homedir(), ".agents", "skills");
}

function globalSkillsDirCandidates(options: GlobalSkillsLoadOptions): string[] {
  const home = homedir();
  let candidates: string[];

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
    candidates.push(agentsSkillsDir());
    candidates.push(join(home, ".config", "g-agent", "skills"));
    candidates.push(join(home, ".local", "share", "g-agent", "skills"));
  }

  const skip = new Set<string>();
  if (!options.loadAgentsSkills) {
    skip.add(agentsSkillsDir());
  }
  for (const path of options.skipPaths) {
    skip.add(expandHome(path));
  }

  return [...new Set(candidates.map(expandHome))].filter((path) => !skip.has(path));
}

export function resolveGlobalSkillsLoadOptions(
  global?: SkillsConfig,
  agent?: AgentSkillsConfig,
): GlobalSkillsLoadOptions {
  return {
    loadAgentsSkills:
      agent?.loadAgentsSkills ?? global?.loadAgentsSkills ?? true,
    skipPaths: [...(global?.skipPaths ?? []), ...(agent?.skipPaths ?? [])],
    paths: global?.paths,
  };
}

function resolveGlobalSkillsDirForOptions(
  options: GlobalSkillsLoadOptions,
): string | null {
  for (const path of globalSkillsDirCandidates(options)) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

const globalSkillsCache = new Map<
  string,
  { skills: Skill[]; path: string | null }
>();

async function loadGlobalSkills(
  options: GlobalSkillsLoadOptions,
): Promise<{ skills: Skill[]; path: string | null }> {
  const key = JSON.stringify(options);
  const cached = globalSkillsCache.get(key);
  if (cached) {
    return cached;
  }

  const path = resolveGlobalSkillsDirForOptions(options);
  const skills = path ? await loadSkillsFromDir(path, "global") : [];
  const result = { skills, path };
  globalSkillsCache.set(key, result);
  return result;
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

export function resolveBuiltinAgentsDir(): string {
  for (const path of builtinAgentsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return join(import.meta.dir, "builtin");
}

export function resolveGlobalSkillsDir(): string | null {
  return resolveGlobalSkillsDirForOptions(resolveGlobalSkillsLoadOptions(undefined));
}

/**
 * Merge skills by name. Precedence is self > global > builtin.
 */
export function mergeSkills(
  agentName: string,
  builtin: Skill[],
  global: Skill[],
  self: Skill[],
): { skills: Skill[]; conflicts: SkillConflict[] } {
  const map = new Map<string, Skill>();
  const candidates = new Map<string, Skill[]>();
  const ordered = [...builtin, ...global, ...self];

  for (const skill of ordered) {
    candidates.set(skill.name, [...(candidates.get(skill.name) ?? []), skill]);
  }

  for (const skill of builtin) {
    map.set(skill.name, skill);
  }
  for (const skill of global) {
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

  if (raw.global !== undefined) {
    if (typeof raw.global !== "boolean") {
      return undefined;
    }
    config.global = raw.global;
  }
  if (raw.loadAgentsSkills !== undefined) {
    if (typeof raw.loadAgentsSkills !== "boolean") {
      return undefined;
    }
    config.loadAgentsSkills = raw.loadAgentsSkills;
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
  const [meta, { body, path: systemPromptPath }] = await Promise.all([
    readAgentMeta(dir),
    readSystemPrompt(dir),
  ]);

  const builtinSkillsPath = join(dir, BUILTIN_SKILLS_DIR);
  const selfSkillsPath = join(dir, USER_SKILLS_DIR);
  const hasSelfSkills = existsSync(selfSkillsPath);

  let globalSkills: Skill[] = [];
  let globalSkillsPath: string | null = null;
  if (meta.skills?.global !== false) {
    const loaded = await loadGlobalSkills(
      resolveGlobalSkillsLoadOptions(globalSkillsConfig, meta.skills),
    );
    globalSkills = loaded.skills;
    globalSkillsPath = loaded.path;
  }

  const [builtinSkills, selfSkills] = await Promise.all([
    loadSkillsFromDir(builtinSkillsPath, "builtin"),
    hasSelfSkills ? loadSkillsFromDir(selfSkillsPath, "self") : Promise.resolve([]),
  ]);
  const { skills, conflicts } = mergeSkills(name, builtinSkills, globalSkills, selfSkills);

  return {
    name,
    description: meta.description,
    systemPromptBody: body,
    systemPromptPath,
    skills,
    skillConflicts: conflicts,
    builtinSkillsPath,
    selfSkillsPath: hasSelfSkills ? selfSkillsPath : null,
    globalSkillsPath,
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
  globalSkillsCache.clear();
}

export async function loadAgents(config?: GAgentConfig): Promise<LoadedAgents> {
  const builtinPath = resolveBuiltinAgentsDir();
  const userPath = resolveAgentsDir();
  const globalSkillsConfig = config?.skills;
  const defaultGlobal = await loadGlobalSkills(
    resolveGlobalSkillsLoadOptions(globalSkillsConfig),
  );

  const [builtinAgents, userAgents] = await Promise.all([
    loadAgentsFromDir(builtinPath, "builtin", globalSkillsConfig),
    userPath ? loadAgentsFromDir(userPath, "user", globalSkillsConfig) : Promise.resolve([]),
  ]);

  // User agents override builtin agents with the same name.
  const agents = new Map<string, AgentConfig>();
  for (const agent of builtinAgents) {
    agents.set(agent.name, agent);
  }
  for (const agent of userAgents) {
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
    globalSkillsPath: defaultGlobal.path,
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
  const globalSkills = agent.skills.filter((s) => s.source === "global");
  const selfSkills = agent.skills.filter((s) => s.source === "self");

  return joinPromptSections(
    body,
    formatBuiltinSkillsSection(builtinSkills),
    formatSkillsSection(globalSkills, "Global skills", agent.globalSkillsPath),
    formatSkillsSection(selfSkills, "Self skills", agent.selfSkillsPath),
  );
}
