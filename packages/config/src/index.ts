import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVER_PORT } from "@g-agent/shared";

export type ModelConfig = {
  name?: string;
};

export type ProviderConfig = {
  baseUrl: string;
  models: Record<string, ModelConfig>;
  apiKey?: string;
  apiKeyEnv?: string;
};

type RawProviderConfig = Omit<ProviderConfig, "models"> & {
  models: Record<string, ModelConfig>;
};

export type GAgentConfig = {
  /** Active provider in "provider-name/model-name" form. */
  provider?: string;
  providers?: Record<string, ProviderConfig>;
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
    models[key] = raw;
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

  return {
    provider: providerRef,
    providers,
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
