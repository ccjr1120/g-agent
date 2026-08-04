import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSkillsConfig, SkillsConfig } from "@g-agent/config";
import { MEMORY_FILE } from "./types.js";

export function expandHome(path: string): string {
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

export type SharedGlobalSkillsLoadOptions = {
  skipPaths: string[];
  paths?: string[];
};

export function sharedGlobalSkillsDirCandidates(
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

export function userAgentsDirCandidates(): string[] {
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

export function builtinAgentsDirCandidates(): string[] {
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
export function agentsBaseDir(): string {
  return (
    resolveAgentsDir() ??
    join(homedir(), ".config", "g-agent", "agents")
  );
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
 * Resolve the per-agent memory.md path (same rules as memory-manager script).
 * Honors `G_AGENT_MEMORY_PATH` when set.
 */
export function resolveAgentMemoryPath(agentName: string): string {
  if (process.env.G_AGENT_MEMORY_PATH?.trim()) {
    return expandHome(process.env.G_AGENT_MEMORY_PATH.trim());
  }
  return join(agentsBaseDir(), agentName, MEMORY_FILE);
}
