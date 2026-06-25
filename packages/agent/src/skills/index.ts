import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Skill = {
  name: string;
  description: string;
  path: string;
  body: string;
  disableModelInvocation: boolean;
  source: "builtin" | "user";
};

export function parseSkillFile(content: string): {
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

export async function loadSkillsFromDir(
  dir: string,
  source: "builtin" | "user",
): Promise<Skill[]> {
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
