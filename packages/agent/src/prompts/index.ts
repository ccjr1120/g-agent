import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { LoadedSkills, Skill } from "../skills/index.js";

export type Prompt = {
  name: string;
  path: string;
  body: string;
  source: "builtin" | "user";
};

export type LoadedPrompts = {
  prompts: Map<string, Prompt>;
  builtinPath: string;
  userPath: string | null;
};

function userPromptsDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.G_AGENT_PROMPTS_DIR) {
    candidates.push(process.env.G_AGENT_PROMPTS_DIR);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "prompts"));
  }
  candidates.push(join(home, ".config", "g-agent", "prompts"));
  candidates.push(join(home, ".local", "share", "g-agent", "prompts"));

  return [...new Set(candidates)];
}

function builtinPromptsDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.G_AGENT_BUILTIN_PROMPTS_DIR) {
    candidates.push(process.env.G_AGENT_BUILTIN_PROMPTS_DIR);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "builtin-prompts"));
  }
  candidates.push(join(home, ".config", "g-agent", "builtin-prompts"));
  candidates.push(join(home, ".local", "share", "g-agent", "builtin-prompts"));

  return [...new Set(candidates)];
}

export function resolvePromptsDir(): string | null {
  for (const path of userPromptsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

export function resolveBuiltinPromptsDir(): string {
  for (const path of builtinPromptsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return join(import.meta.dir, "builtin");
}

function parsePromptFile(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content.trim() };
  }

  const meta = Bun.YAML.parse(match[1]) as Record<string, unknown>;
  return { meta, body: match[2].trim() };
}

async function loadPromptsFromDir(
  dir: string,
  source: "builtin" | "user",
): Promise<Prompt[]> {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const prompts: Prompt[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const promptPath = join(dir, entry.name);
    const content = await readFile(promptPath, "utf8");
    const { meta, body } = parsePromptFile(content);
    const defaultName = basename(entry.name, ".md");

    prompts.push({
      name: String(meta.name ?? defaultName),
      path: promptPath,
      body,
      source,
    });
  }

  prompts.sort((a, b) => a.name.localeCompare(b.name));
  return prompts;
}

function joinPromptSections(...sections: string[]): string {
  return sections
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
}

function formatBuiltinSkillsSection(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const lines = [
    "## Built-in skills",
    "",
    "When a skill is relevant, use the `read` tool to load its SKILL.md before following its instructions.",
    "",
  ];

  for (const skill of skills) {
    lines.push(
      `- **${skill.name}** — ${skill.description ? skill.description + " " : ""}(instructions: \`${skill.path}\`)`,
    );
  }

  return lines.join("\n");
}

function formatUserSkillsSection(
  skills: Skill[],
  userSkillsPath: string | null,
): string {
  if (skills.length === 0) return "";

  const lines = ["## User skills", ""];

  if (userSkillsPath) {
    lines.push(`User-installed skills are loaded from: ${userSkillsPath}`, "");
  }

  lines.push(
    "When a skill is relevant, use the `read` tool to load its SKILL.md before following its instructions.",
    "",
  );

  for (const skill of skills) {
    lines.push(
      `- **${skill.name}** — ${skill.description ? skill.description + " " : ""}(instructions: \`${skill.path}\`)`,
    );
  }

  return lines.join("\n");
}

export function getPrompt(loaded: LoadedPrompts, name: string): Prompt | null {
  return loaded.prompts.get(name) ?? null;
}

export function buildSystemPrompt(
  loadedSkills: LoadedSkills,
  loadedPrompts: LoadedPrompts,
): string {
  const prompt = getPrompt(loadedPrompts, "system");
  if (!prompt) {
    throw new Error('Missing prompt "system". Check builtin prompts directory.');
  }

  const builtinSkills = loadedSkills.skills.filter((s) => s.source === "builtin");
  const userSkills = loadedSkills.skills.filter((s) => s.source === "user");

  return joinPromptSections(
    prompt.body,
    formatBuiltinSkillsSection(builtinSkills),
    formatUserSkillsSection(userSkills, loadedSkills.userPath),
  );
}

export async function loadPrompts(): Promise<LoadedPrompts> {
  const builtinPath = resolveBuiltinPromptsDir();
  const userPath = resolvePromptsDir();

  const [builtinPrompts, userPrompts] = await Promise.all([
    loadPromptsFromDir(builtinPath, "builtin"),
    userPath ? loadPromptsFromDir(userPath, "user") : Promise.resolve([]),
  ]);

  const prompts = new Map<string, Prompt>();
  for (const prompt of builtinPrompts) {
    prompts.set(prompt.name, prompt);
  }
  for (const prompt of userPrompts) {
    prompts.set(prompt.name, prompt);
  }

  return {
    prompts,
    builtinPath,
    userPath,
  };
}
