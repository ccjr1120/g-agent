import type { ServerWebSocket } from "bun";
import { runAgent } from "@g-agent/agent";
import {
  formatProviderRef,
  getActiveProvider,
  getServerHost,
  getServerPort,
  loadConfig,
} from "@g-agent/config";
import { parseClientMessage, type ServerMessage } from "@g-agent/shared";

const { config, path: configPath } = await loadConfig();
const provider = getActiveProvider(config);
const host = getServerHost();
const port = getServerPort();

function send(ws: ServerWebSocket<unknown>, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

Bun.serve({
  port,
  hostname: host,
  fetch(req, server) {
    if (server.upgrade(req)) {
      return undefined;
    }

    return new Response("G-Agent server — connect via WebSocket", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
  websocket: {
    open(ws) {
      send(ws, { type: "ready" });
    },
    async message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      const message = parseClientMessage(text);

      if (!message) {
        send(ws, { type: "error", message: "Invalid message" });
        return;
      }

      const prompt = message.message.trim();
      if (!prompt) {
        send(ws, { type: "error", message: "Empty message" });
        return;
      }

      send(ws, { type: "start" });

      await runAgent(
        prompt,
        (event) => {
          if (event.type === "delta") {
            send(ws, { type: "delta", text: event.text });
            return;
          }

          if (event.type === "error") {
            send(ws, { type: "error", message: event.message });
            return;
          }

          send(ws, { type: "done" });
        },
        provider,
      );
    },
  },
});

const providerLabel = provider ? formatProviderRef(provider) : "echo";
const configLabel = configPath ?? "none";
console.log(
  `G-Agent server ws://${host}:${port} · provider=${providerLabel} · config=${configLabel}`,
);
