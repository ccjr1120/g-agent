import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  isMcpOAuthEnabled,
  type McpServerConfig,
} from "@g-agent/config";
import { type ToolDefinition } from "../tools/index.js";
import {
  createMcpOAuthProvider,
  hasMcpOAuthTokens,
  isUnauthorizedError,
  McpAuthRequiredError,
  runInteractiveMcpOAuth,
} from "./oauth.js";

const TOOL_PREFIX = "mcp__";
const TOOL_SEPARATOR = "__";

export type McpConnectionResult = {
  serverName: string;
  ok: boolean;
  error?: string;
  toolCount?: number;
  oauth?: boolean;
  authRequired?: boolean;
};

type RegisteredTool = {
  serverName: string;
  toolName: string;
  client: Client;
};

export function encodeMcpToolName(serverName: string, toolName: string): string {
  return `${TOOL_PREFIX}${serverName}${TOOL_SEPARATOR}${toolName}`;
}

export function decodeMcpToolName(
  name: string,
): { serverName: string; toolName: string } | null {
  if (!name.startsWith(TOOL_PREFIX)) {
    return null;
  }

  const rest = name.slice(TOOL_PREFIX.length);
  const separator = rest.indexOf(TOOL_SEPARATOR);
  if (separator <= 0 || separator === rest.length - TOOL_SEPARATOR.length) {
    return null;
  }

  return {
    serverName: rest.slice(0, separator),
    toolName: rest.slice(separator + TOOL_SEPARATOR.length),
  };
}

function formatToolResult(result: {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): string {
  const parts: string[] = [];

  for (const item of result.content ?? []) {
    if (item.type === "text" && item.text) {
      parts.push(item.text);
    }
  }

  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }

  if (parts.length === 0) {
    parts.push(JSON.stringify(result, null, 2));
  }

  const text = parts.join("\n").trimEnd();
  return result.isError ? `Error: ${text}` : text;
}

async function buildRegisteredTools(
  serverName: string,
  client: Client,
): Promise<{ client: Client; tools: RegisteredTool[] }> {
  const listed = await client.listTools();
  const tools: RegisteredTool[] = (listed.tools ?? []).map((tool) => ({
    serverName,
    toolName: tool.name,
    client,
  }));

  return { client, tools };
}

type HttpTransportOptions = Pick<
  StreamableHTTPClientTransportOptions,
  "authProvider" | "requestInit"
>;

async function connectHttpClient(
  serverName: string,
  url: URL,
  transportOptions: HttpTransportOptions,
  allowSseFallback: boolean,
): Promise<{ client: Client; tools: RegisteredTool[] }> {
  const client = new Client({ name: "g-agent", version: "0.1.0" });
  const streamable = new StreamableHTTPClientTransport(url, transportOptions);

  try {
    await client.connect(streamable);
    return buildRegisteredTools(serverName, client);
  } catch (error) {
    if (transportOptions.authProvider) {
      await client.close().catch(() => undefined);
      if (isUnauthorizedError(error)) {
        throw new McpAuthRequiredError(serverName);
      }
      throw error;
    }

    if (!allowSseFallback) {
      throw error;
    }

    await client.close().catch(() => undefined);
    const sseClient = new Client({ name: "g-agent", version: "0.1.0" });
    const sse = new SSEClientTransport(url, transportOptions.requestInit);
    await sseClient.connect(sse);
    return buildRegisteredTools(serverName, sseClient);
  }
}

async function connectServer(
  serverName: string,
  config: McpServerConfig,
): Promise<{ client: Client; tools: RegisteredTool[] }> {
  if (config.command) {
    const client = new Client({ name: "g-agent", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      stderr: "pipe",
    });
    await client.connect(transport);
    return buildRegisteredTools(serverName, client);
  }

  if (config.url) {
    const url = new URL(config.url);
    const requestInit = config.headers
      ? { headers: config.headers }
      : undefined;
    const oauthEnabled = isMcpOAuthEnabled(config);
    const authProvider = oauthEnabled
      ? await createMcpOAuthProvider(serverName, config)
      : undefined;

    return connectHttpClient(
      serverName,
      url,
      { requestInit, ...(authProvider ? { authProvider } : {}) },
      !oauthEnabled,
    );
  }

  throw new Error('MCP server must specify "command" or "url"');
}

function connectionFailure(
  serverName: string,
  config: McpServerConfig,
  error: unknown,
): McpConnectionResult {
  const oauth = isMcpOAuthEnabled(config);
  if (error instanceof McpAuthRequiredError) {
    return {
      serverName,
      ok: false,
      oauth,
      authRequired: true,
      error: error.message,
    };
  }

  return {
    serverName,
    ok: false,
    oauth,
    error: error instanceof Error ? error.message : "connection failed",
  };
}

export class McpManager {
  private clients = new Map<string, Client>();
  private tools = new Map<string, RegisteredTool>();
  private definitions: ToolDefinition[] = [];
  private lastConfigs: Record<string, McpServerConfig> = {};
  private lastResults = new Map<string, McpConnectionResult>();

  getTools(): ToolDefinition[] {
    return this.definitions;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getConnectionResult(serverName: string): McpConnectionResult | undefined {
    return this.lastResults.get(serverName);
  }

  getServerTools(
    serverName: string,
  ): Array<{ name: string; description: string }> {
    return this.definitions
      .filter((definition) => decodeMcpToolName(definition.name)?.serverName === serverName)
      .map((definition) => {
        const decoded = decodeMcpToolName(definition.name)!;
        return {
          name: decoded.toolName,
          description: definition.description,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async connect(
    servers: Record<string, McpServerConfig>,
  ): Promise<McpConnectionResult[]> {
    await this.close();

    this.lastConfigs = { ...servers };
    this.lastResults.clear();

    const results: McpConnectionResult[] = [];

    for (const [serverName, config] of Object.entries(servers)) {
      try {
        await this.registerServer(serverName, config);
        const result = this.lastResults.get(serverName)!;
        results.push(result);
      } catch (error) {
        const failed = connectionFailure(serverName, config, error);
        results.push(failed);
        this.lastResults.set(serverName, failed);
      }
    }

    this.rebuildDefinitions();
    return results;
  }

  async authenticate(serverName: string): Promise<McpConnectionResult> {
    const config = this.lastConfigs[serverName];
    if (!config) {
      throw new Error(`MCP server not configured: ${serverName}`);
    }
    if (!isMcpOAuthEnabled(config)) {
      throw new Error(`MCP server "${serverName}" does not have OAuth enabled`);
    }

    await this.removeServer(serverName);

    try {
      await runInteractiveMcpOAuth(serverName, config, async (provider) => {
        const url = new URL(config.url!);
        const requestInit = config.headers
          ? { headers: config.headers }
          : undefined;
        let transport = new StreamableHTTPClientTransport(url, {
          authProvider: provider,
          requestInit,
        });
        let client = new Client({ name: "g-agent", version: "0.1.0" });

        return {
          initialConnect: async () => {
            try {
              await client.connect(transport);
            } catch (error) {
              await client.close().catch(() => undefined);
              throw error;
            }
          },
          finishAuth: (authorizationCode: string) =>
            transport.finishAuth(authorizationCode),
          reconnect: async () => {
            await client.close().catch(() => undefined);
            transport = new StreamableHTTPClientTransport(url, {
              authProvider: provider,
              requestInit,
            });
            client = new Client({ name: "g-agent", version: "0.1.0" });
            await client.connect(transport);

            const registered = await buildRegisteredTools(serverName, client);
            this.clients.set(serverName, registered.client);
            for (const tool of registered.tools) {
              this.tools.set(
                encodeMcpToolName(serverName, tool.toolName),
                tool,
              );
            }
          },
        };
      });

      const toolCount = this.getServerTools(serverName).length;
      const result: McpConnectionResult = {
        serverName,
        ok: true,
        toolCount,
        oauth: true,
        authRequired: false,
      };
      this.lastResults.set(serverName, result);
      this.rebuildDefinitions();
      return result;
    } catch (error) {
      const failed = connectionFailure(serverName, config, error);
      this.lastResults.set(serverName, failed);
      this.rebuildDefinitions();
      return failed;
    }
  }

  getConfiguredServers(): Record<string, McpServerConfig> {
    return { ...this.lastConfigs };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: unknown MCP tool "${name}"`;
    }

    try {
      const result = await tool.client.callTool({
        name: tool.toolName,
        arguments: args,
      });
      return formatToolResult(result);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : "MCP tool failed"}`;
    }
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.tools.clear();
    this.definitions = [];
    this.lastConfigs = {};
    this.lastResults.clear();

    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.close();
        } catch {
          // Ignore shutdown errors.
        }
      }),
    );
  }

  private async registerServer(
    serverName: string,
    config: McpServerConfig,
  ): Promise<void> {
    const { client, tools } = await connectServer(serverName, config);
    this.clients.set(serverName, client);

    for (const tool of tools) {
      this.tools.set(encodeMcpToolName(serverName, tool.toolName), tool);
    }

    const oauth = isMcpOAuthEnabled(config);
    const result: McpConnectionResult = {
      serverName,
      ok: true,
      toolCount: tools.length,
      oauth,
      authRequired: false,
    };
    this.lastResults.set(serverName, result);
  }

  private async removeServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      await client.close().catch(() => undefined);
      this.clients.delete(serverName);
    }

    for (const [name, tool] of this.tools) {
      if (tool.serverName === serverName) {
        this.tools.delete(name);
      }
    }
  }

  private rebuildDefinitions(): void {
    this.definitions = [...this.tools.entries()]
      .map(([exposedName, tool]) => ({
        name: exposedName,
        description: `MCP (${tool.serverName}): ${tool.toolName}`,
        parameters: { type: "object", properties: {} },
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    void this.refreshToolSchemas();
  }

  private async refreshToolSchemas(): Promise<void> {
    for (const [exposedName, tool] of this.tools) {
      try {
        const listed = await tool.client.listTools();
        const match = listed.tools?.find((item) => item.name === tool.toolName);
        if (!match) continue;

        const index = this.definitions.findIndex((item) => item.name === exposedName);
        if (index === -1) continue;

        this.definitions[index] = {
          name: exposedName,
          description:
            match.description?.trim() ||
            `MCP (${tool.serverName}): ${tool.toolName}`,
          parameters:
            (match.inputSchema as Record<string, unknown> | undefined) ?? {
              type: "object",
              properties: {},
            },
        };
      } catch {
        // Keep fallback definition if listTools fails mid-flight.
      }
    }
  }
}

export {
  hasMcpOAuthTokens,
  McpAuthRequiredError,
} from "./oauth.js";
