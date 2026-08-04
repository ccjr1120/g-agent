import type {
  AgentMcpOverrides,
  AgentProviderOverrides,
  GAgentConfig,
  ProviderConfig,
  ResolvedProvider,
} from "./types.js";
import {
  firstModelKey,
  hasModel,
  looksLikeApiKey,
  normalizeMcpServers,
  parseProviderRef,
  resolveModelName,
} from "./normalize.js";

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

/**
 * Merge agent-level MCP server overrides into the global config.
 *
 * Agent entries replace or add servers by name on top of global `mcpServers`.
 */
export function mergeAgentMcpServers(
  config: GAgentConfig,
  overrides?: AgentMcpOverrides,
): Record<string, import("./types.js").McpServerConfig> {
  const merged: Record<string, import("./types.js").McpServerConfig> = {
    ...(config.mcpServers ?? {}),
  };

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

/**
 * Merge agent-level provider overrides into the global config.
 *
 * - If the agent specifies a `provider`, it replaces the global one.
 * - If the agent specifies `providers`, they are deep-merged on top of
 *   the global providers: same-name providers are overridden (shallow),
 *   and new providers are added.
 */
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
