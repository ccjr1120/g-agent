import { formatMemorySection } from "./loader.js";
import { formatSkillsSection, joinPromptSections } from "../prompts/index.js";
import type { AgentConfig, LoadedAgents, ResolvedAgent } from "./types.js";

export { loadAgents } from "./loader.js";
export { clearGlobalSkillsCache } from "./skills.js";
export type {
  AgentConfig,
  LoadedAgents,
  ResolvedAgent,
  SkillConflict,
} from "./types.js";

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
