import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Skill, loadSkillsFromDir } from "../skills/index.js";
import {
  formatBuiltinSkillsSection,
  formatUserSkillsSection,
  joinPromptSections,
  parsePromptFile,
} from "../prompts/index.js";

export type AgentConfig = {
  name: string;
  description: string;
  systemPromptBody: string | null;
  systemPromptPath: string | null;
  skills: Skill[];
  builtinSkillsPath: string;
  userSkillsPath: string | null;
  source: "builtin" | "user";
  /** Override the global provider/model reference for this agent.
   *  Format: "provider-name/model-key", e.g. "openai/gpt-4o". */
  provider?: string;
  /** Additional or override provider configurations for this agent,
   *  merged on top of the global providers. Same shape as config.json
   *  providers. */
  providers?: Record<string, unknown>;
};

export type LoadedAgents = {
  agents: Map<string, AgentConfig>;
  list: AgentConfig[];
  builtinPath: string;
  userPath: string | null;
  defaultName: string;
  defaultSystemBody: string;
};

const DEFAULT_AGENT_NAME = "default";

const AGENT_JSON = "agent.json";
const SYSTEM_PROMPT_FILE = "system.md";
const BUILTIN_SKILLS_DIR = "builtin-skills";
const USER_SKILLS_DIR = "skills";

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

/**
 * Merge builtin and user skills by name. User skills override builtin skills
 * with the same name, so users can customize a builtin skill by adding a
 * same-named one in their agent's `skills/` directory.
 */
export function mergeSkills(builtin: Skill[], user: Skill[]): Skill[] {
  const map = new Map<string, Skill>();
  for (const skill of builtin) {
    map.set(skill.name, skill);
  }
  for (const skill of user) {
    map.set(skill.name, skill);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type AgentMeta = {
  description: string;
  provider?: string;
  providers?: Record<string, unknown>;
};

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
): Promise<AgentConfig> {
  const [meta, { body, path: systemPromptPath }] = await Promise.all([
    readAgentMeta(dir),
    readSystemPrompt(dir),
  ]);

  const builtinSkillsPath = join(dir, BUILTIN_SKILLS_DIR);
  const userSkillsPath = join(dir, USER_SKILLS_DIR);
  const hasUserSkills = existsSync(userSkillsPath);

  const [builtinSkills, userSkills] = await Promise.all([
    loadSkillsFromDir(builtinSkillsPath, "builtin"),
    hasUserSkills ? loadSkillsFromDir(userSkillsPath, "user") : Promise.resolve([]),
  ]);

  return {
    name,
    description: meta.description,
    systemPromptBody: body,
    systemPromptPath,
    skills: mergeSkills(builtinSkills, userSkills),
    builtinSkillsPath,
    userSkillsPath: hasUserSkills ? userSkillsPath : null,
    source,
    provider: meta.provider,
    providers: meta.providers,
  };
}

async function loadAgentsFromDir(
  dir: string,
  source: "builtin" | "user",
): Promise<AgentConfig[]> {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    agents.push(await loadAgentDir(join(dir, entry.name), entry.name, source));
  }

  return agents;
}

export async function loadAgents(): Promise<LoadedAgents> {
  const builtinPath = resolveBuiltinAgentsDir();
  const userPath = resolveAgentsDir();

  const [builtinAgents, userAgents] = await Promise.all([
    loadAgentsFromDir(builtinPath, "builtin"),
    userPath ? loadAgentsFromDir(userPath, "user") : Promise.resolve([]),
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

  const defaultAgent = agents.get(DEFAULT_AGENT_NAME);
  const defaultSystemBody = defaultAgent?.systemPromptBody ?? "";

  return {
    agents,
    list,
    builtinPath,
    userPath,
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
  const userSkills = agent.skills.filter((s) => s.source === "user");

  return joinPromptSections(
    body,
    formatBuiltinSkillsSection(builtinSkills),
    formatUserSkillsSection(userSkills, agent.userSkillsPath),
  );
}
