import type { ServerWebSocket } from "bun";
import { builtinTools, loadSkills, runAgent } from "@g-agent/agent";
import {
  formatProviderRef,
  getActiveProvider,
  getServerHost,
  getServerPort,
  loadConfig,
} from "@g-agent/config";
import { parseClientMessage, type ServerMessage } from "@g-agent/shared";

const { config, path: configPath } = await loadConfig();
const { skills, builtinPath, userPath: skillsPath } = await loadSkills();
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
      send(ws, {
        type: "skills",
        skills: skills.map((s) => ({ name: s.name, description: s.description })),
      });
    },
    async message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      const message = parseClientMessage(text);

      if (!message) {
        send(ws, { type: "error", message: "Invalid message" });
        return;
      }

      if (message.type === "reset") {
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

          if (event.type === "tool_call") {
            send(ws, {
              type: "tool_call",
              name: event.name,
              args: event.args,
            });
            return;
          }

          if (event.type === "tool_result") {
            send(ws, {
              type: "tool_result",
              name: event.name,
              output: event.output,
            });
            return;
          }

          if (event.type === "error") {
            send(ws, { type: "error", message: event.message });
            return;
          }

          send(ws, { type: "done" });
        },
        provider,
        { skills, builtinPath, userPath: skillsPath },
      );
    },
  },
});

const providerLabel = provider ? formatProviderRef(provider) : "echo";
const configLabel = configPath ?? "none";
const builtinCount = skills.filter((s) => s.source === "builtin").length;
const userCount = skills.filter((s) => s.source === "user").length;
const skillsLabel = `builtin=${builtinCount} user=${userCount}${skillsPath ? ` (${skillsPath})` : ""}`;
console.log(
  `G-Agent server ws://${host}:${port} · provider=${providerLabel} · config=${configLabel} · skills=${skillsLabel} · tools=${builtinTools.length}`,
);
