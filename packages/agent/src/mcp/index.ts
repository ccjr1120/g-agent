import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "@g-agent/config";
import { type ToolDefinition } from "../tools/index.js";

const TOOL_PREFIX = "mcp__";
const TOOL_SEPARATOR = "__";

export type McpConnectionResult = {
  serverName: string;
  ok: boolean;
  error?: string;
  toolCount?: number;
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

async function connectServer(
  serverName: string,
  config: McpServerConfig,
): Promise<{ client: Client; tools: RegisteredTool[] }> {
  const client = new Client({ name: "g-agent", version: "0.1.0" });

  if (config.command) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      stderr: "pipe",
    });
    await client.connect(transport);
  } else if (config.url) {
    const url = new URL(config.url);
    const requestInit = config.headers
      ? { headers: config.headers }
      : undefined;
    const streamable = new StreamableHTTPClientTransport(url, { requestInit });

    try {
      await client.connect(streamable);
    } catch {
      await client.close().catch(() => undefined);
      const sseClient = new Client({ name: "g-agent", version: "0.1.0" });
      const sse = new SSEClientTransport(url, { requestInit });
      await sseClient.connect(sse);
      return buildRegisteredTools(serverName, sseClient);
    }
  } else {
    throw new Error('MCP server must specify "command" or "url"');
  }

  return buildRegisteredTools(serverName, client);
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
        const { client, tools } = await connectServer(serverName, config);
        this.clients.set(serverName, client);

        for (const tool of tools) {
          const exposedName = encodeMcpToolName(serverName, tool.toolName);
          this.tools.set(exposedName, tool);
        }

        results.push({
          serverName,
          ok: true,
          toolCount: tools.length,
        });
        this.lastResults.set(serverName, {
          serverName,
          ok: true,
          toolCount: tools.length,
        });
      } catch (error) {
        const failed: McpConnectionResult = {
          serverName,
          ok: false,
          error: error instanceof Error ? error.message : "connection failed",
        };
        results.push(failed);
        this.lastResults.set(serverName, failed);
      }
    }

    this.definitions = [...this.tools.entries()]
      .map(([exposedName, tool]) => {
        return {
          name: exposedName,
          description: `MCP (${tool.serverName}): ${tool.toolName}`,
          parameters: { type: "object", properties: {} },
        } satisfies ToolDefinition;
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    // Refresh schemas from connected clients.
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

    return results;
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
}
