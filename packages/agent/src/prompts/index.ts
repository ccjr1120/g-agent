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

export function formatBuiltinSkillsSection(skills: Skill[]): string {
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

export function formatUserSkillsSection(
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
