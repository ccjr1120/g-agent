import type { McpServerCatalogEntry } from "@g-agent/shared";
import { truncateToWidth } from "../transcript.js";

export function formatMcpServerDetail(server: McpServerCatalogEntry): string {
  const status = server.connected
    ? `connected, ${server.toolCount} tools`
    : server.authRequired
      ? "auth required"
      : `not connected${server.error ? `: ${server.error}` : ""}`;

  let out = `[${server.source}] ${server.name} (${server.transport}) — ${status}\n`;
  if (!server.connected || server.tools.length === 0) return out;

  for (const tool of server.tools) {
    const description = tool.description.split(/\s+/).join(" ");
    out += description
      ? `  · ${tool.name} — ${truncateToWidth(description, 80)}\n`
      : `  · ${tool.name}\n`;
  }
  return out;
}
