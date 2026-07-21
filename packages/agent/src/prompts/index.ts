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
  const active = skills.filter((skill) => !skill.disableModelInvocation);
  if (active.length === 0) return "";

  const sections = [
    "## Built-in skills",
    "",
    "These skills are included in your system prompt. When a task matches one, **prioritize it** and follow its instructions directly — do not improvise with raw tools.",
    "",
  ];

  for (const skill of active) {
    const header = skill.description
      ? `### ${skill.name}\n\n${skill.description}`
      : `### ${skill.name}`;

    sections.push(header, "", skill.body, "");
  }

  return sections.join("\n").trim();
}

export function formatSkillsSection(
  skills: Skill[],
  title: string,
  skillsPath: string | null,
): string {
  if (skills.length === 0) return "";

  const lines = [`## ${title}`, ""];

  if (skillsPath) {
    lines.push(`Skills are loaded from: ${skillsPath}`, "");
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
