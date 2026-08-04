export type ModelConfig = {
  name?: string;
  /** Model context window size in tokens. Used for usage display and history trimming. */
  contextWindow?: number;
  /** Extra fields merged into the LLM /chat/completions request body. */
  requestBody?: Record<string, unknown>;
};

export type ProviderConfig = {
  baseUrl: string;
  models: Record<string, ModelConfig>;
  apiKey?: string;
  apiKeyEnv?: string;
};

/** OAuth options for URL-based MCP servers (MCP authorization spec). */
export type McpOAuthConfig = {
  /** When false, OAuth is disabled even if this object is present. Default: true. */
  enabled?: boolean;
  /** OAuth redirect URI registered with the authorization server. */
  redirectUrl?: string;
  /** Pre-registered OAuth client ID. Uses dynamic registration when omitted. */
  clientId?: string;
  /** Pre-registered client secret (client_credentials / confidential clients). */
  clientSecret?: string;
  /** Environment variable holding the client secret. */
  clientSecretEnv?: string;
  /** Space-separated OAuth scopes to request. */
  scope?: string;
  /** Client display name for dynamic registration. Default: g-agent MCP client. */
  clientName?: string;
  /**
   * OAuth grant type.
   * - authorization_code (default): interactive browser sign-in
   * - client_credentials: machine-to-machine, no browser
   */
  grant?: "authorization_code" | "client_credentials";
};

/** MCP server config. Compatible with Cursor-style mcp.json entries. */
export type McpServerConfig = {
  /** Stdio transport: executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP/SSE transport: remote MCP endpoint URL. */
  url?: string;
  headers?: Record<string, string>;
  /** Enable MCP OAuth for this URL server (`true` or options object). */
  oauth?: boolean | McpOAuthConfig;
};

export const DEFAULT_MCP_OAUTH_REDIRECT_URL =
  "http://127.0.0.1:3848/oauth/callback";

export function isMcpOAuthEnabled(config: McpServerConfig): boolean {
  if (!config.url || config.oauth === undefined) {
    return false;
  }
  if (config.oauth === true) {
    return true;
  }
  if (config.oauth === false) {
    return false;
  }
  return config.oauth.enabled !== false;
}

export function resolveMcpOAuthConfig(
  config: McpServerConfig,
): McpOAuthConfig | undefined {
  if (!isMcpOAuthEnabled(config)) {
    return undefined;
  }
  if (config.oauth === true) {
    return { enabled: true };
  }
  return config.oauth || undefined;
}

export type SkillsConfig = {
  /** When false, skip shared global (~/.agents/skills) for all agents unless overridden in agent.json. Default: true. */
  shared?: boolean;
  /** When false, skip g-agent global (~/.config/g-agent/skills) for all agents unless overridden. Default: true. */
  gagent?: boolean;
  /** Paths to skip during shared global skill discovery. Supports ~ for home. */
  skipPaths?: string[];
  /** Explicit shared global skill directories. Replaces auto-discovery when set. */
  paths?: string[];
};

/** Per-agent skill loading overrides in agent.json. */
export type AgentSkillsConfig = {
  /** When false, skip shared global (~/.agents/skills). Default: true. */
  shared?: boolean;
  /** @deprecated Use `shared`. When false, skip shared global only. */
  global?: boolean;
  /** When false, skip g-agent global (~/.config/g-agent/skills). Default: true. */
  gagent?: boolean;
  /** Extra paths to skip for this agent. Merged with global skipPaths. */
  skipPaths?: string[];
};

export type GAgentConfig = {
  /** Active provider in "provider-name/model-name" form. */
  provider?: string;
  providers?: Record<string, ProviderConfig>;
  /** Global MCP servers available to all agents (unless overridden per agent). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Global skill discovery and loading options. */
  skills?: SkillsConfig;
};

type RawProviderConfig = Omit<ProviderConfig, "models"> & {
  models: Record<string, ModelConfig>;
};

type RawGAgentConfig = Omit<GAgentConfig, "providers"> & {
  providers?: Record<string, RawProviderConfig>;
  skills?: unknown;
};

export type { RawProviderConfig, RawGAgentConfig };

export type ResolvedProvider = {
  name: string;
  baseUrl: string;
  /** Model key in config (provider-name/model-key). */
  model: string;
  /** Model name sent to the LLM API. */
  modelName: string;
  apiKey: string;
  /** Context window in tokens, from model config. */
  contextWindow?: number;
  /** Extra fields merged into the LLM /chat/completions request body. */
  requestBody?: Record<string, unknown>;
};

export type LoadedConfig = {
  config: GAgentConfig;
  path: string | null;
};

export type AgentProviderOverrides = {
  provider?: string;
  providers?: Record<string, unknown>;
};

export type AgentMcpOverrides = {
  mcpServers?: Record<string, unknown>;
};
