import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function configCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.G_AGENT_CONFIG) {
    candidates.push(process.env.G_AGENT_CONFIG);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "config.json"));
  }
  candidates.push(join(home, ".config", "g-agent", "config.json"));
  candidates.push(join(home, ".local", "share", "g-agent", "config.json"));

  return [...new Set(candidates)];
}

export function resolveConfigPath(): string | null {
  for (const path of configCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}
