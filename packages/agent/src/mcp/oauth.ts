import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import {
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  DEFAULT_MCP_OAUTH_REDIRECT_URL,
  type McpOAuthConfig,
  type McpServerConfig,
} from "@g-agent/config";

const execFileAsync = promisify(execFile);

type StoredOAuthState = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
};

export class McpAuthRequiredError extends Error {
  readonly serverName: string;

  constructor(serverName: string) {
    super(
      `OAuth authorization required for MCP server "${serverName}". Use /mcp auth ${serverName} to sign in.`,
    );
    this.name = "McpAuthRequiredError";
    this.serverName = serverName;
  }
}

function oauthDirCandidates(): string[] {
  const home = homedir();
  const candidates: string[] = [];
  if (process.env.G_AGENT_HOME) {
    candidates.push(join(process.env.G_AGENT_HOME, "mcp-oauth"));
  }
  candidates.push(join(home, ".config", "g-agent", "mcp-oauth"));
  candidates.push(join(home, ".local", "share", "g-agent", "mcp-oauth"));
  return [...new Set(candidates)];
}

export function resolveMcpOAuthStorageDir(): string {
  if (process.env.G_AGENT_MCP_OAUTH_DIR?.trim()) {
    return process.env.G_AGENT_MCP_OAUTH_DIR.trim();
  }
  return oauthDirCandidates()[0]!;
}

function sanitizeServerName(serverName: string): string {
  return serverName.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function oauthStatePath(serverName: string): string {
  return join(resolveMcpOAuthStorageDir(), `${sanitizeServerName(serverName)}.json`);
}

async function readOAuthState(serverName: string): Promise<StoredOAuthState> {
  try {
    return JSON.parse(await readFile(oauthStatePath(serverName), "utf8")) as StoredOAuthState;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeOAuthState(
  serverName: string,
  state: StoredOAuthState,
): Promise<void> {
  const path = oauthStatePath(serverName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function resolveClientSecret(oauth: McpOAuthConfig): string | undefined {
  if (oauth.clientSecret?.trim()) {
    return oauth.clientSecret.trim();
  }
  if (oauth.clientSecretEnv?.trim()) {
    return process.env[oauth.clientSecretEnv.trim()]?.trim();
  }
  return undefined;
}

function resolveRedirectUrl(oauth: McpOAuthConfig): string {
  return oauth.redirectUrl?.trim() || DEFAULT_MCP_OAUTH_REDIRECT_URL;
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await execFileAsync("open", [url]);
      return;
    }
    if (platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", url]);
      return;
    }
    await execFileAsync("xdg-open", [url]);
  } catch {
    console.warn(`Open this URL in your browser to authorize MCP OAuth:\n${url}`);
  }
}

type CallbackServer = {
  waitForAuthorizationCode: (options?: { timeoutMs?: number }) => Promise<string>;
  close: () => Promise<void>;
};

function startOAuthCallbackServer(redirectUrl: string): Promise<CallbackServer> {
  const parsed = new URL(redirectUrl);
  const expectedPath = parsed.pathname || "/";
  const hostname = parsed.hostname || "127.0.0.1";
  const port =
    parsed.port !== ""
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;

  let resolveCode: ((code: string) => void) | undefined;
  let rejectWait: ((error: Error) => void) | undefined;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectWait = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (requestUrl.pathname !== expectedPath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    if (error) {
      const description = requestUrl.searchParams.get("error_description") ?? error;
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body><h1>Authorization failed</h1><p>${description}</p><p>You can close this tab.</p></body></html>`,
      );
      rejectWait?.(new Error(`OAuth authorization failed: ${description}`));
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing authorization code");
      rejectWait?.(new Error("OAuth callback missing authorization code"));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<html><body><h1>Authorization successful</h1><p>You can close this tab and return to g-agent.</p></body></html>",
    );
    resolveCode?.(code);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      resolve({
        waitForAuthorizationCode: ({ timeoutMs = 5 * 60 * 1000 } = {}) =>
          new Promise<string>((resolveCodeInner, rejectCode) => {
            timeoutHandle = setTimeout(() => {
              rejectCode(new Error("OAuth authorization timed out"));
            }, timeoutMs);
            codePromise.then(
              (code) => {
                clearTimeout(timeoutHandle);
                resolveCodeInner(code);
              },
              (error) => {
                clearTimeout(timeoutHandle);
                rejectCode(error);
              },
            );
          }),
        close: async () => {
          clearTimeout(timeoutHandle);
          await new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
          });
        },
      });
    });
  });
}

class FileOAuthClientProvider implements OAuthClientProvider {
  private state: StoredOAuthState;

  constructor(
    private readonly serverName: string,
    private readonly oauth: McpOAuthConfig,
    private readonly redirectUri: string,
    initialState: StoredOAuthState = {},
  ) {
    this.state = { ...initialState };
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    const clientSecret = resolveClientSecret(this.oauth);
    return {
      client_name: this.oauth.clientName?.trim() || "g-agent MCP client",
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: clientSecret ? "client_secret_basic" : "none",
      ...(this.oauth.scope ? { scope: this.oauth.scope } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.oauth.clientId?.trim()) {
      const clientSecret = resolveClientSecret(this.oauth);
      return {
        client_id: this.oauth.clientId.trim(),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      };
    }
    return this.state.clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    this.state.clientInformation = clientInformation;
    await writeOAuthState(this.serverName, this.state);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return this.state.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.state.tokens = tokens;
    await writeOAuthState(this.serverName, this.state);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    console.log(`MCP OAuth (${this.serverName}): opening browser for authorization...`);
    await openBrowser(String(authorizationUrl));
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.state.codeVerifier = codeVerifier;
    await writeOAuthState(this.serverName, this.state);
  }

  async codeVerifier(): Promise<string> {
    const verifier = this.state.codeVerifier;
    if (!verifier) {
      throw new Error("OAuth code verifier missing; restart authorization");
    }
    return verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.state.discoveryState = state;
    await writeOAuthState(this.serverName, this.state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return this.state.discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      this.state = {};
    } else if (scope === "client") {
      delete this.state.clientInformation;
    } else if (scope === "tokens") {
      delete this.state.tokens;
    } else if (scope === "verifier") {
      delete this.state.codeVerifier;
    } else if (scope === "discovery") {
      delete this.state.discoveryState;
    }
    await writeOAuthState(this.serverName, this.state);
  }
}

export async function createMcpOAuthProvider(
  serverName: string,
  config: McpServerConfig,
): Promise<OAuthClientProvider | undefined> {
  const oauth = config.oauth;
  if (!oauth) {
    return undefined;
  }

  const resolved = oauth === true ? { enabled: true } : oauth;
  if (resolved.enabled === false) {
    return undefined;
  }

  if (resolved.grant === "client_credentials") {
    const clientId = resolved.clientId?.trim();
    const clientSecret = resolveClientSecret(resolved);
    if (!clientId || !clientSecret) {
      throw new Error(
        `MCP server "${serverName}" client_credentials OAuth requires clientId and clientSecret/clientSecretEnv`,
      );
    }
    return new ClientCredentialsProvider({
      clientId,
      clientSecret,
      clientName: resolved.clientName,
      scope: resolved.scope,
    });
  }

  const redirectUri = resolveRedirectUrl(resolved);
  const stored = await readOAuthState(serverName);
  return new FileOAuthClientProvider(serverName, resolved, redirectUri, stored);
}

export function isUnauthorizedError(error: unknown): error is UnauthorizedError {
  return error instanceof UnauthorizedError;
}

export async function runInteractiveMcpOAuth(
  serverName: string,
  config: McpServerConfig,
  connect: (provider: OAuthClientProvider) => Promise<{
    initialConnect: () => Promise<void>;
    finishAuth: (authorizationCode: string) => Promise<void>;
    reconnect: () => Promise<void>;
  }>,
): Promise<void> {
  const oauth = config.oauth === true ? { enabled: true } : config.oauth;
  if (!oauth || oauth.enabled === false || oauth.grant === "client_credentials") {
    throw new Error(`MCP server "${serverName}" does not use interactive OAuth`);
  }

  const redirectUri = resolveRedirectUrl(oauth);
  const callbackServer = await startOAuthCallbackServer(redirectUri);
  const provider = await createMcpOAuthProvider(serverName, config);
  if (!provider) {
    await callbackServer.close();
    throw new Error(`MCP server "${serverName}" has no OAuth provider`);
  }

  try {
    const session = await connect(provider);
    try {
      await session.initialConnect();
      await session.reconnect();
      return;
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        throw error;
      }
    }

    const authorizationCode = await callbackServer.waitForAuthorizationCode();
    await session.finishAuth(authorizationCode);
    await session.reconnect();
  } finally {
    await callbackServer.close();
  }
}

export async function hasMcpOAuthTokens(serverName: string): Promise<boolean> {
  const stored = await readOAuthState(serverName);
  return Boolean(stored.tokens?.access_token);
}
