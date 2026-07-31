import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type Skill = {
  name: string;
  description: string;
  path: string;
  body: string;
  disableModelInvocation: boolean;
  source: "builtin" | "shared" | "gagent" | "self";
};

export function parseSkillFile(content: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content.trim() };
  }

  try {
    const meta = Bun.YAML.parse(match[1]) as Record<string, unknown>;
    return { meta: meta ?? {}, body: match[2].trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid skill frontmatter: ${message}`);
  }
}

export async function loadSkillsFromDir(
  dir: string,
  source: Skill["source"],
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
    let meta: Record<string, unknown>;
    let body: string;
    try {
      ({ meta, body } = parseSkillFile(content));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Skipping skill at ${skillPath}: ${message}`);
      continue;
    }

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
