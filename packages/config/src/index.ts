import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER_PORT } from "@g-agent/shared";

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
};

type RawProviderConfig = Omit<ProviderConfig, "models"> & {
  models: Record<string, ModelConfig>;
};

export type GAgentConfig = {
  /** Active provider in "provider-name/model-name" form. */
  provider?: string;
  providers?: Record<string, ProviderConfig>;
  /** Global MCP servers available to all agents (unless overridden per agent). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Active agent name. Selects which agent (skills + system prompt) loads at startup. */
  agent?: string;
};

type RawGAgentConfig = Omit<GAgentConfig, "providers"> & {
  providers?: Record<string, RawProviderConfig>;
};

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

function configCandidates(): string[] {
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

function resolveModelName(key: string, model: ModelConfig): string {
  const name = model.name?.trim();
  return name || key;
}

function normalizeRequestBody(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function resolveContextWindow(
  key: string,
  model: ModelConfig,
  path: string,
): number | undefined {
  const value = model.contextWindow;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path}.${key}.contextWindow must be a positive number`);
  }
  return Math.floor(value);
}

function normalizeModels(
  value: unknown,
  path: string,
): Record<string, ModelConfig> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`${path} must contain at least one model`);
  }

  const models: Record<string, ModelConfig> = {};

  for (const [key, item] of entries) {
    if (typeof item !== "object" || item == null) {
      throw new Error(`${path}.${key} must be an object`);
    }

    const raw = item as ModelConfig;
    const requestBody = normalizeRequestBody(
      (item as Record<string, unknown>).requestBody,
      `${path}.${key}.requestBody`,
    );
    models[key] = {
      ...raw,
      contextWindow: resolveContextWindow(key, raw, path),
      ...(requestBody ? { requestBody } : {}),
    };
  }

  return models;
}

function hasModel(
  models: Record<string, ModelConfig>,
  modelKey: string,
): boolean {
  return modelKey in models;
}

function firstModelKey(models: Record<string, ModelConfig>): string {
  const key = Object.keys(models)[0];
  if (!key) {
    throw new Error("Provider has no models configured");
  }
  return key;
}

function parseProviderRef(ref: string): { name: string; model?: string } {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return { name: trimmed };
  }

  const name = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  return { name, model: model || undefined };
}

function looksLikeApiKey(value: string): boolean {
  return /^(sk-|api-)/i.test(value.trim());
}

function normalizeMcpServers(
  value: unknown,
  path: string,
): Record<string, McpServerConfig> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  const servers: Record<string, McpServerConfig> = {};

  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "object" || item == null || Array.isArray(item)) {
      throw new Error(`${path}.${name} must be an object`);
    }

    const raw = item as McpServerConfig;
    const command = raw.command?.trim();
    const url = raw.url?.trim();
    const hasCommand = Boolean(command);
    const hasUrl = Boolean(url);

    if (hasCommand === hasUrl) {
      throw new Error(
        `${path}.${name} must specify exactly one of "command" (stdio) or "url" (HTTP)`,
      );
    }

    servers[name] = {
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
      ...(raw.args ? { args: raw.args.map(String) } : {}),
      ...(raw.env ? { env: Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) } : {}),
      ...(raw.cwd?.trim() ? { cwd: raw.cwd.trim() } : {}),
      ...(raw.headers
        ? {
            headers: Object.fromEntries(
              Object.entries(raw.headers).map(([k, v]) => [k, String(v)]),
            ),
          }
        : {}),
    };
  }

  return servers;
}

function normalizeConfig(raw: RawGAgentConfig): GAgentConfig {
  const providers: Record<string, ProviderConfig> = {};

  for (const [name, provider] of Object.entries(raw.providers ?? {})) {
    if (!provider.baseUrl?.trim()) {
      throw new Error(`providers.${name}.baseUrl is required`);
    }

    const models = normalizeModels(provider.models, `providers.${name}.models`);
    if (!provider.apiKey && !provider.apiKeyEnv) {
      throw new Error(
        `providers.${name} needs apiKey or apiKeyEnv`,
      );
    }

    if (
      !provider.apiKey?.trim() &&
      provider.apiKeyEnv &&
      looksLikeApiKey(provider.apiKeyEnv)
    ) {
      throw new Error(
        `providers.${name}.apiKeyEnv must be an environment variable name, not the API key. Use "apiKey" instead.`,
      );
    }

    providers[name] = {
      ...provider,
      models,
    };
  }

  const providerRef = raw.provider?.trim() || undefined;
  if (providerRef) {
    const { name, model } = parseProviderRef(providerRef);
    if (!(name in providers)) {
      throw new Error(`Unknown provider "${name}"`);
    }

    if (model && !hasModel(providers[name].models, model)) {
      throw new Error(
        `model "${model}" is not configured for provider "${name}"`,
      );
    }
  }

  // Agent name is stored raw; validation happens in @g-agent/agent
  // (resolveActiveAgent), which owns the agent catalog. This keeps the
  // config package free of a dependency on the agent package.
  const agentRef = raw.agent?.trim() || undefined;

  return {
    provider: providerRef,
    providers,
    mcpServers: normalizeMcpServers(raw.mcpServers, "mcpServers"),
    agent: agentRef,
  };
}

export async function loadConfig(): Promise<LoadedConfig> {
  const path = resolveConfigPath();
  if (!path) {
    return { config: {}, path: null };
  }

  const raw = await readFile(path, "utf8");
  const config = normalizeConfig(JSON.parse(raw) as RawGAgentConfig);
  return { config, path };
}

export function resolveProviderApiKey(provider: ProviderConfig): string | undefined {
  if (provider.apiKey?.trim()) {
    return provider.apiKey.trim();
  }

  if (provider.apiKeyEnv) {
    return process.env[provider.apiKeyEnv]?.trim();
  }

  return undefined;
}

export function formatProviderRef(provider: ResolvedProvider): string {
  return `${provider.name}/${provider.model}`;
}

export type AgentProviderOverrides = {
  provider?: string;
  providers?: Record<string, unknown>;
};

export type AgentMcpOverrides = {
  mcpServers?: Record<string, unknown>;
};

/**
 * Merge agent-level provider overrides into the global config.
 *
 * - If the agent specifies a `provider`, it replaces the global one.
 * - If the agent specifies `providers`, they are deep-merged on top of
 *   the global providers: same-name providers are overridden (shallow),
 *   and new providers are added.
 */
/**
 * Merge agent-level MCP server overrides into the global config.
 *
 * Agent entries replace or add servers by name on top of global `mcpServers`.
 */
export function mergeAgentMcpServers(
  config: GAgentConfig,
  overrides?: AgentMcpOverrides,
): Record<string, McpServerConfig> {
  const merged: Record<string, McpServerConfig> = { ...(config.mcpServers ?? {}) };

  if (!overrides?.mcpServers) {
    return merged;
  }

  const agentServers = normalizeMcpServers(
    overrides.mcpServers,
    "agent.mcpServers",
  );
  if (!agentServers) {
    return merged;
  }

  return { ...merged, ...agentServers };
}

export function mergeAgentProviderOverrides(
  config: GAgentConfig,
  overrides?: AgentProviderOverrides,
): GAgentConfig {
  if (!overrides) return config;

  const mergedProviders = { ...config.providers };

  if (overrides.providers) {
    for (const [name, raw] of Object.entries(overrides.providers)) {
      if (typeof raw !== "object" || raw === null) continue;
      mergedProviders[name] = raw as ProviderConfig;
    }
  }

  return {
    ...config,
    provider: overrides.provider ?? config.provider,
    providers: mergedProviders,
  };
}

export function getActiveProvider(config: GAgentConfig): ResolvedProvider | null {
  const providers = config.providers;
  if (!providers || Object.keys(providers).length === 0) {
    return null;
  }

  const providerRef =
    process.env.G_AGENT_PROVIDER?.trim() ||
    config.provider?.trim() ||
    null;

  let name: string;
  let model: string | undefined;

  if (providerRef) {
    ({ name, model } = parseProviderRef(providerRef));
  } else {
    name = Object.keys(providers)[0];
    model = undefined;
  }

  if (!name) {
    return null;
  }

  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown provider "${name}"`);
  }

  const apiKey = resolveProviderApiKey(provider);
  if (!apiKey) {
    const hint = provider.apiKeyEnv
      ? process.env[provider.apiKeyEnv]
        ? `Set ${provider.apiKeyEnv}`
        : looksLikeApiKey(provider.apiKeyEnv)
          ? `providers.${name}.apiKeyEnv must be an environment variable name; put the key in "apiKey" instead`
          : `Set environment variable ${provider.apiKeyEnv}`
      : "Set apiKey or apiKeyEnv";
    throw new Error(`Provider "${name}" has no API key (${hint})`);
  }

  const resolvedModelKey = model ?? firstModelKey(provider.models);

  if (!hasModel(provider.models, resolvedModelKey)) {
    throw new Error(
      `model "${resolvedModelKey}" is not configured for provider "${name}"`,
    );
  }

  return {
    name,
    baseUrl: provider.baseUrl.replace(/\/+$/, ""),
    model: resolvedModelKey,
    modelName: resolveModelName(
      resolvedModelKey,
      provider.models[resolvedModelKey],
    ),
    apiKey,
    contextWindow: provider.models[resolvedModelKey].contextWindow,
    requestBody: provider.models[resolvedModelKey].requestBody,
  };
}

export function getServerHost(): string {
  return process.env.G_AGENT_HOST?.trim() || "127.0.0.1";
}

export function getServerPort(): number {
  const port = Number(process.env.G_AGENT_PORT);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_SERVER_PORT;
}

export function getServerUrl(): string {
  return `ws://${getServerHost()}:${getServerPort()}`;
}
