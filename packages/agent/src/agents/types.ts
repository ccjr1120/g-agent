import type { AgentSkillsConfig } from "@g-agent/config";
import type { Skill } from "../skills/index.js";

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

/** Raw shape of agent.json. */
export type AgentMeta = {
  description: string;
  provider?: string;
  providers?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  skills?: AgentSkillsConfig;
};

export type ResolvedAgent = {
  agent: AgentConfig;
  /** Present when the requested agent didn't exist and we fell back to the
   * built-in `default`. `requested` is the name that was asked for. */
  fallback?: { requested: string };
};

export const DEFAULT_AGENT_NAME = "default";

export const AGENT_JSON = "agent.json";
export const SYSTEM_PROMPT_FILE = "system.md";
export const MEMORY_FILE = "memory.md";
export const BUILTIN_SKILLS_DIR = "builtin-skills";
export const USER_SKILLS_DIR = "skills";
