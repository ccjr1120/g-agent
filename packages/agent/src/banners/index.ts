import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BANNER_FILENAME = "banner.txt";

export type LoadedBanner = {
  lines: string[];
  path: string;
  source: "builtin" | "user";
};

function userBannersDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.G_AGENT_BANNERS_DIR) {
    candidates.push(process.env.G_AGENT_BANNERS_DIR);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "banners"));
  }
  candidates.push(join(home, ".config", "g-agent", "banners"));
  candidates.push(join(home, ".local", "share", "g-agent", "banners"));

  return [...new Set(candidates)];
}

function builtinBannersDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];

  if (process.env.G_AGENT_BUILTIN_BANNERS_DIR) {
    candidates.push(process.env.G_AGENT_BUILTIN_BANNERS_DIR);
  }
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "builtin-banners"));
  }
  candidates.push(join(home, ".config", "g-agent", "builtin-banners"));
  candidates.push(join(home, ".local", "share", "g-agent", "builtin-banners"));

  return [...new Set(candidates)];
}

export function resolveBannersDir(): string | null {
  for (const path of userBannersDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

export function resolveBuiltinBannersDir(): string {
  for (const path of builtinBannersDirCandidates()) {
    if (existsSync(path)) {
      return path;
    }
  }
  return join(import.meta.dir, "builtin");
}

async function readBannerFile(
  dir: string,
  source: "builtin" | "user",
): Promise<LoadedBanner | null> {
  const path = join(dir, BANNER_FILENAME);
  if (!existsSync(path)) return null;

  const content = await readFile(path, "utf8");
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  return { lines, path, source };
}

export async function loadBanner(): Promise<LoadedBanner | null> {
  const userPath = resolveBannersDir();
  if (userPath) {
    const userBanner = await readBannerFile(userPath, "user");
    if (userBanner) return userBanner;
  }

  return readBannerFile(resolveBuiltinBannersDir(), "builtin");
}

export function getBannerLines(loaded: LoadedBanner | null): string[] {
  return loaded?.lines ?? [];
}
