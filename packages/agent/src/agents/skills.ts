import { existsSync } from "node:fs";
import type { AgentSkillsConfig, SkillsConfig } from "@g-agent/config";
import { type Skill, loadSkillsFromDir } from "../skills/index.js";
import {
  gAgentGlobalSkillsDir,
  sharedGlobalSkillsDir,
  sharedGlobalSkillsDirCandidates,
  type SharedGlobalSkillsLoadOptions,
} from "./paths.js";
import type { SkillConflict } from "./types.js";

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

export function clearGlobalSkillsCache(): void {
  sharedGlobalSkillsCache.clear();
  gagentGlobalSkillsCache.clear();
}

export function isSharedGlobalEnabled(
  global?: SkillsConfig,
  agent?: AgentSkillsConfig,
): boolean {
  if (agent?.shared === false || agent?.global === false) return false;
  if (global?.shared === false) return false;
  return true;
}

export function isGagentGlobalEnabled(
  global?: SkillsConfig,
  agent?: AgentSkillsConfig,
): boolean {
  if (agent?.gagent === false) return false;
  if (global?.gagent === false) return false;
  return true;
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

export async function loadGlobalSkillsForAgent(
  sharedOptions: SharedGlobalSkillsLoadOptions,
  sharedEnabled: boolean,
  gagentEnabled: boolean,
  sharedSkillsPath: string,
  gagentSkillsPath: string,
): Promise<{
  sharedSkills: Skill[];
  gagentSkills: Skill[];
  skillWatchPaths: string[];
}> {
  let sharedSkills: Skill[] = [];
  let gagentSkills: Skill[] = [];
  const skillWatchPaths: string[] = [];

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

  return { sharedSkills, gagentSkills, skillWatchPaths };
}

export function globalSkillsPaths(): {
  shared: string;
  gagent: string;
} {
  return {
    shared: sharedGlobalSkillsDir(),
    gagent: gAgentGlobalSkillsDir(),
  };
}
