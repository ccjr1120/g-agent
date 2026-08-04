import type {
  GAgentConfig,
  McpOAuthConfig,
  McpServerConfig,
  ModelConfig,
  ProviderConfig,
  RawGAgentConfig,
  SkillsConfig,
} from "./types.js";

export function resolveModelName(key: string, model: ModelConfig): string {
  const name = model.name?.trim();
  return name || key;
}

export function normalizeRequestBody(
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

export function resolveContextWindow(
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

export function normalizeModels(
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

export function hasModel(
  models: Record<string, ModelConfig>,
  modelKey: string,
): boolean {
  return modelKey in models;
}

export function firstModelKey(models: Record<string, ModelConfig>): string {
  const key = Object.keys(models)[0];
  if (!key) {
    throw new Error("Provider has no models configured");
  }
  return key;
}

export function parseProviderRef(ref: string): { name: string; model?: string } {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return { name: trimmed };
  }

  const name = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  return { name, model: model || undefined };
}

export function looksLikeApiKey(value: string): boolean {
  return /^(sk-|api-)/i.test(value.trim());
}

export function normalizeBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function normalizeMcpOAuth(
  value: unknown,
  path: string,
  hasUrl: boolean,
): boolean | McpOAuthConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!hasUrl) {
    throw new Error(`${path.replace(/\.oauth$/, "")} oauth requires "url" transport`);
  }
  if (value === true) {
    return true;
  }
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error(`${path} must be true or an object`);
  }

  const raw = value as Record<string, unknown>;
  const enabled = normalizeBoolean(raw.enabled, `${path}.enabled`);
  const redirectUrl =
    typeof raw.redirectUrl === "string" && raw.redirectUrl.trim()
      ? raw.redirectUrl.trim()
      : undefined;
  const clientId =
    typeof raw.clientId === "string" && raw.clientId.trim()
      ? raw.clientId.trim()
      : undefined;
  const clientSecret =
    typeof raw.clientSecret === "string" && raw.clientSecret.trim()
      ? raw.clientSecret.trim()
      : undefined;
  const clientSecretEnv =
    typeof raw.clientSecretEnv === "string" && raw.clientSecretEnv.trim()
      ? raw.clientSecretEnv.trim()
      : undefined;
  const scope =
    typeof raw.scope === "string" && raw.scope.trim()
      ? raw.scope.trim()
      : undefined;
  const clientName =
    typeof raw.clientName === "string" && raw.clientName.trim()
      ? raw.clientName.trim()
      : undefined;
  const grantRaw = raw.grant;
  let grant: McpOAuthConfig["grant"] | undefined;
  if (grantRaw !== undefined) {
    if (grantRaw !== "authorization_code" && grantRaw !== "client_credentials") {
      throw new Error(
        `${path}.grant must be "authorization_code" or "client_credentials"`,
      );
    }
    grant = grantRaw;
  }

  if (
    enabled === false &&
    redirectUrl === undefined &&
    clientId === undefined &&
    clientSecret === undefined &&
    clientSecretEnv === undefined &&
    scope === undefined &&
    clientName === undefined &&
    grant === undefined
  ) {
    return { enabled: false };
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(redirectUrl ? { redirectUrl } : {}),
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(clientSecretEnv ? { clientSecretEnv } : {}),
    ...(scope ? { scope } : {}),
    ...(clientName ? { clientName } : {}),
    ...(grant ? { grant } : {}),
  };
}

export function normalizeMcpServers(
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

    const oauth = normalizeMcpOAuth(
      (item as Record<string, unknown>).oauth,
      `${path}.${name}.oauth`,
      hasUrl,
    );

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
      ...(oauth !== undefined ? { oauth } : {}),
    };
  }

  return servers;
}

export function normalizeStringList(value: unknown, path: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings`);
  }
  const items = value.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${path}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  return items.length > 0 ? items : undefined;
}

export function normalizeSkillsConfig(value: unknown): SkillsConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    throw new Error("skills must be an object");
  }

  const raw = value as Record<string, unknown>;
  let shared = normalizeBoolean(raw.shared, "skills.shared");
  if (shared === undefined && raw.loadAgentsSkills === false) {
    shared = false;
  }
  const gagent = normalizeBoolean(raw.gagent, "skills.gagent");
  const skipPaths = normalizeStringList(raw.skipPaths, "skills.skipPaths");
  const paths = normalizeStringList(raw.paths, "skills.paths");

  if (
    shared === undefined &&
    gagent === undefined &&
    skipPaths === undefined &&
    paths === undefined
  ) {
    return undefined;
  }

  return {
    ...(shared !== undefined ? { shared } : {}),
    ...(gagent !== undefined ? { gagent } : {}),
    ...(skipPaths ? { skipPaths } : {}),
    ...(paths ? { paths } : {}),
  };
}

export function normalizeConfig(raw: RawGAgentConfig): GAgentConfig {
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
    mcpServers: normalizeMcpServers(raw.mcpServers, "mcpServers"),
    skills: normalizeSkillsConfig(raw.skills),
  };
}
