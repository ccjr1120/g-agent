import { readFile } from "node:fs/promises";
import type { LoadedConfig, RawGAgentConfig } from "./types.js";
import { normalizeConfig } from "./normalize.js";
import { resolveConfigPath } from "./paths.js";

export type {
  AgentMcpOverrides,
  AgentProviderOverrides,
  AgentSkillsConfig,
  GAgentConfig,
  LoadedConfig,
  McpOAuthConfig,
  McpServerConfig,
  ModelConfig,
  ProviderConfig,
  RawGAgentConfig,
  ResolvedProvider,
  SkillsConfig,
} from "./types.js";
export {
  DEFAULT_MCP_OAUTH_REDIRECT_URL,
  isMcpOAuthEnabled,
  resolveMcpOAuthConfig,
} from "./types.js";
export { resolveConfigPath } from "./paths.js";
export {
  formatProviderRef,
  getActiveProvider,
  mergeAgentMcpServers,
  mergeAgentProviderOverrides,
  resolveProviderApiKey,
} from "./providers.js";
export { getServerHost, getServerPort, getServerUrl } from "./server.js";

export async function loadConfig(): Promise<LoadedConfig> {
  const path = resolveConfigPath();
  if (!path) {
    return { config: {}, path: null };
  }

  const raw = await readFile(path, "utf8");
  const config = normalizeConfig(JSON.parse(raw) as RawGAgentConfig);
  return { config, path };
}
