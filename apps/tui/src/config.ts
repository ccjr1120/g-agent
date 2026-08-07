import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getServerUrl as getConfigServerUrl } from "@g-agent/config";

/** Server URL precedence: G_AGENT_SERVER_URL > host/port env > config serverUrl > default. */
export function serverUrl(): string {
  const direct = process.env.G_AGENT_SERVER_URL?.trim();
  if (direct) return direct;
  const host = process.env.G_AGENT_HOST?.trim();
  const port = Number(process.env.G_AGENT_PORT);
  if (host || (Number.isFinite(port) && port > 0)) {
    return `ws://${host || "127.0.0.1"}:${port > 0 ? port : 3847}`;
  }
  return getConfigServerUrl();
}

export function configDir(): string {
  const home = process.env.G_AGENT_HOME?.trim();
  if (home) return home;
  return join(homedir(), ".config", "g-agent");
}

export function repoRoot(): string | null {
  const candidates: string[] = [];
  if (process.env.G_AGENT_INSTALL_DIR) candidates.push(process.env.G_AGENT_INSTALL_DIR);
  if (process.env.G_AGENT_HOME) candidates.push(process.env.G_AGENT_HOME);
  candidates.push(join(homedir(), ".local", "share", "g-agent"));

  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 10; i++) {
    candidates.push(dir);
    if (existsSync(join(dir, "apps", "server", "src", "index.ts"))) break;
    dir = dirname(dir);
  }

  return candidates.find((root) => existsSync(join(root, "apps", "server", "src", "index.ts"))) ?? null;
}

export function serverEntry(root: string): string {
  return join(root, "apps", "server", "src", "index.ts");
}

export function bannerPaths(): string[] {
  const paths: string[] = [];
  if (process.env.G_AGENT_BANNERS_DIR) paths.push(join(process.env.G_AGENT_BANNERS_DIR, "banner.txt"));
  if (process.env.G_AGENT_HOME) paths.push(join(process.env.G_AGENT_HOME, "banners", "banner.txt"));
  paths.push(join(homedir(), ".config", "g-agent", "banners", "banner.txt"));
  paths.push(join(configDir(), "banners", "banner.txt"));
  const root = repoRoot();
  if (root) paths.push(join(root, "packages", "agent", "src", "banners", "builtin", "banner.txt"));
  return paths;
}

export function loadBannerLines(): string[] {
  for (const path of bannerPaths()) {
    if (!existsSync(path)) continue;
    try {
      const lines = parseBanner(readFileSync(path, "utf8"));
      if (lines.length > 0) return lines;
    } catch {
      // try next path
    }
  }
  return parseBanner(DEFAULT_BANNER);
}

function parseBanner(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const DEFAULT_BANNER = ` ██████╗        █████╗  ██████╗ ███████╗███╗   ██╗████████╗
██╔════╝       ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
██║  ███╗█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║
██║   ██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║
╚██████╔╝      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║
 ╚═════╝       ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝
`;