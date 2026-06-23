import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Skill = {
  name: string;
  description: string;
  path: string;
  body: string;
  disableModelInvocation: boolean;
  source: "builtin" | "user";
};

export type LoadedSkills = {
  skills: Skill[];
  builtinPath: string;
  userPath: string | null;
};

function userSkillsDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.G_AGENT_SKILLS_DIR) {
    candidates.push(process.env.G_AGENT_SKILLS_DIR);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "skills"));
  }
  candidates.push(join(home, ".config", "g-agent", "skills"));
  candidates.push(join(home, ".local", "share", "g-agent", "skills"));

  return [...new Set(candidates)];
}

function builtinSkillsDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.G_AGENT_BUILTIN_SKILLS_DIR) {
    candidates.push(process.env.G_AGENT_BUILTIN_SKILLS_DIR);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "builtin-skills"));
  }
  candidates.push(join(home, ".config", "g-agent", "builtin-skills"));
  candidates.push(join(home, ".local", "share", "g-agent", "builtin-skills"));

  return [...new Set(candidates)];
}

export function resolveSkillsDir(): string | null {
  for (const path of userSkillsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

export function resolveBuiltinSkillsDir(): string {
  for (const path of builtinSkillsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return join(import.meta.dir, "builtin");
}

function parseSkillFile(content: string): {
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

async function loadSkillsFromDir(dir: string, source: "builtin" | "user"): Promise<Skill[]> {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const skillDir = dirname(skillPath);
    const content = await readFile(skillPath, "utf8");
    const { meta, body } = parseSkillFile(content);

    skills.push({
      name: String(meta.name ?? entry.name),
      description: String(meta.description ?? ""),
      path: skillPath,
      body: body.replaceAll("{{skill_dir}}", skillDir),
      disableModelInvocation: meta["disable-model-invocation"] === true,
      source,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function userMentionsSkill(prompt: string, skill: Skill): boolean {
  const lower = prompt.toLowerCase();
  const name = skill.name.toLowerCase();
  return (
    lower.includes(name) ||
    lower.includes(`/${name}`) ||
    lower.includes(`skill:${name}`)
  );
}

export function buildSystemPrompt(
  skills: Skill[],
  userSkillsPath: string | null,
): string {
  const builtinSkills = skills.filter((s) => s.source === "builtin");
  const userSkills = skills.filter((s) => s.source === "user");

  const lines: string[] = [
    "You are g-agent, a personal daily assistant running in the terminal.",
    "You are capable, direct, and efficient. Prefer concise responses.",
    "",
    "## Tools",
    "",
    "You have access to the following built-in tools:",
    "- bash — run shell commands",
    "- read — read file contents",
    "- write — write or create files",
    "- glob — find files matching a pattern",
    "- grep — search file contents by regex",
    "",
    "Use tools proactively when they help you give accurate, grounded answers.",
  ];

  if (builtinSkills.length > 0) {
    lines.push("", "## Built-in skills", "");
    lines.push(
      "When a skill is relevant, use the `read` tool to load its SKILL.md before following its instructions.",
      "",
    );
    for (const skill of builtinSkills) {
      lines.push(
        `- **${skill.name}** — ${skill.description ? skill.description + " " : ""}(instructions: \`${skill.path}\`)`,
      );
    }
  }

  if (userSkills.length > 0) {
    lines.push("", "## User skills", "");
    if (userSkillsPath) {
      lines.push(`User-installed skills are loaded from: ${userSkillsPath}`, "");
    }
    lines.push(
      "When a skill is relevant, use the `read` tool to load its SKILL.md before following its instructions.",
      "",
    );
    for (const skill of userSkills) {
      lines.push(
        `- **${skill.name}** — ${skill.description ? skill.description + " " : ""}(instructions: \`${skill.path}\`)`,
      );
    }
  }

  return lines.join("\n").trim();
}

/** @deprecated Use buildSystemPrompt instead */
export function formatSkillsPrompt(skills: Skill[], userPrompt: string): string {
  return buildSystemPrompt(skills, null);
}

export async function loadSkills(): Promise<LoadedSkills> {
  const builtinPath = resolveBuiltinSkillsDir();
  const userPath = resolveSkillsDir();

  const [builtinSkills, userSkills] = await Promise.all([
    loadSkillsFromDir(builtinPath, "builtin"),
    userPath ? loadSkillsFromDir(userPath, "user") : Promise.resolve([]),
  ]);

  return {
    skills: [...builtinSkills, ...userSkills],
    builtinPath,
    userPath,
  };
}
