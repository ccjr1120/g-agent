import type { Skill } from "../skills/index.js";

export function parsePromptFile(content: string): {
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

export function joinPromptSections(...sections: string[]): string {
  return sections
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function formatSkillsSection(
  skills: Skill[],
  title: string,
  skillsPath: string | null,
  layerDescription?: string,
): string {
  const active = skills.filter((skill) => !skill.disableModelInvocation);
  if (active.length === 0) return "";

  const lines = [`## ${title}`, ""];

  if (layerDescription) {
    lines.push(layerDescription, "");
  }

  if (skillsPath) {
    lines.push(`Directory: \`${skillsPath}\``, "");
  }

  lines.push(
    "Progressive loading: use `read` on the path below when this skill matches the task.",
    "",
  );

  for (const skill of active) {
    lines.push(
      `- **${skill.name}** — ${skill.description ? skill.description + " " : ""}(instructions: \`${skill.path}\`)`,
    );
  }

  return lines.join("\n");
}
