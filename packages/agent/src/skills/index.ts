import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Skill = {
  name: string;
  description: string;
  path: string;
  body: string;
  disableModelInvocation: boolean;
};

export type LoadedSkills = {
  skills: Skill[];
  path: string | null;
};

function skillsDirCandidates(): string[] {
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

export function resolveSkillsDir(): string | null {
  for (const path of skillsDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
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

function userMentionsSkill(prompt: string, skill: Skill): boolean {
  const lower = prompt.toLowerCase();
  const name = skill.name.toLowerCase();
  return (
    lower.includes(name) ||
    lower.includes(`/${name}`) ||
    lower.includes(`skill:${name}`)
  );
}

export function formatSkillsPrompt(skills: Skill[], userPrompt: string): string {
  if (skills.length === 0) {
    return "";
  }

  const active = skills.filter(
    (skill) => !skill.disableModelInvocation || userMentionsSkill(userPrompt, skill),
  );
  if (active.length === 0) {
    return "";
  }

  const lines = [
    "You have access to the following skills. When a skill is relevant, follow its instructions precisely.",
    "",
    "<available_skills>",
  ];

  for (const skill of skills) {
    lines.push(
      `<skill name="${skill.name}">${skill.description || skill.name}</skill>`,
    );
  }

  lines.push("</available_skills>", "");

  for (const skill of active) {
    lines.push(`## Skill: ${skill.name}`);
    if (skill.description) {
      lines.push(skill.description);
    }
    lines.push("");
    lines.push(skill.body);
    lines.push("");
  }

  return lines.join("\n").trim();
}

export async function loadSkills(): Promise<LoadedSkills> {
  const dir = resolveSkillsDir();
  if (!dir) {
    return { skills: [], path: null };
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) {
      continue;
    }

    const content = await readFile(skillPath, "utf8");
    const { meta, body } = parseSkillFile(content);

    skills.push({
      name: String(meta.name ?? entry.name),
      description: String(meta.description ?? ""),
      path: skillPath,
      body,
      disableModelInvocation: meta["disable-model-invocation"] === true,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, path: dir };
}
