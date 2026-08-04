import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSkillsConfig, GAgentConfig, SkillsConfig } from "@g-agent/config";
import { type Skill, loadSkillsFromDir } from "../skills/index.js";
import {
  gAgentGlobalSkillsDir,
  resolveAgentMemoryPath,
  resolveAgentsDir,
  resolveBuiltinAgentsDir,
  resolveSharedGlobalSkillsLoadOptions,
  sharedGlobalSkillsDir,
} from "./paths.js";
import {
  isGagentGlobalEnabled,
  isSharedGlobalEnabled,
  loadGlobalSkillsForAgent,
  mergeSkills,
} from "./skills.js";
import {
  AGENT_JSON,
  BUILTIN_SKILLS_DIR,
  DEFAULT_AGENT_NAME,
  SYSTEM_PROMPT_FILE,
  USER_SKILLS_DIR,
  type AgentConfig,
  type AgentMeta,
  type LoadedAgents,
} from "./types.js";
import { parsePromptFile } from "../prompts/index.js";

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

  const sharedSkillsPath = sharedGlobalSkillsDir();
  const gagentSkillsPath = gAgentGlobalSkillsDir();
  const sharedOptions = resolveSharedGlobalSkillsLoadOptions(
    globalSkillsConfig,
    meta.skills,
  );
  const sharedEnabled = isSharedGlobalEnabled(globalSkillsConfig, meta.skills);
  const gagentEnabled = isGagentGlobalEnabled(globalSkillsConfig, meta.skills);
  const { sharedSkills, gagentSkills, skillWatchPaths } =
    await loadGlobalSkillsForAgent(
      sharedOptions,
      sharedEnabled,
      gagentEnabled,
      sharedSkillsPath,
      gagentSkillsPath,
    );

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

export function formatMemorySection(body: string, memoryPath: string | null): string {
  const lines = ["## Memory", ""];
  if (memoryPath) {
    lines.push(`Source: \`${memoryPath}\``, "");
  }
  lines.push(body);
  return lines.join("\n");
}

export type { AgentMeta, LoadedAgents };
