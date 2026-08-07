import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";

export function writeConversationLog(lines: Array<{ role: string; text: string }>): string {
  const logDir = join(configDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = join(logDir, `conversation-${stamp}.md`);

  let output = "# Conversation Log\n\n";
  for (const line of lines) {
    const heading =
      line.role === "user" ? "## User" : line.role === "error" ? "## Error" : "## Assistant";
    output += `${heading}\n\n${line.text}\n\n---\n\n`;
  }
  writeFileSync(path, output);
  return path;
}
