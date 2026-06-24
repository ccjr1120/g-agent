import type { ServerWebSocket } from "bun";
import {
  buildSessionSystemPrompt,
  builtinTools,
  loadPrompts,
  loadSkills,
  runAgent,
} from "@g-agent/agent";
import {
  formatProviderRef,
  getActiveProvider,
  getServerHost,
  getServerPort,
  loadConfig,
} from "@g-agent/config";
import { parseClientMessage, type ServerMessage } from "@g-agent/shared";

const { config, path: configPath } = await loadConfig();
const loadedSkills = await loadSkills();
const loadedPrompts = await loadPrompts();
const { skills, userPath: skillsPath } = loadedSkills;
const sessionSystemPrompt = buildSessionSystemPrompt(
  loadedSkills,
  loadedPrompts,
);
const provider = getActiveProvider(config);
const host = getServerHost();
const port = getServerPort();

type WsData = {
  promptQueue: string[];
  draining: boolean;
};

function send(ws: ServerWebSocket<WsData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

async function runPrompt(ws: ServerWebSocket<WsData>, prompt: string): Promise<void> {
  send(ws, { type: "start" });

  await runAgent(
    prompt,
    (event) => {
      if (event.type === "system_prompt") {
        send(ws, { type: "system_prompt", text: event.text });
        return;
      }

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
    loadedSkills,
    loadedPrompts,
  );
}

async function drainPromptQueue(ws: ServerWebSocket<WsData>): Promise<void> {
  if (ws.data.draining) {
    return;
  }

  ws.data.draining = true;

  try {
    while (ws.data.promptQueue.length > 0) {
      const prompt = ws.data.promptQueue.shift();
      if (!prompt) {
        continue;
      }
      await runPrompt(ws, prompt);
    }
  } finally {
    ws.data.draining = false;
  }
}

Bun.serve({
  port,
  hostname: host,
  fetch(req, server) {
    if (
      server.upgrade(req, {
        data: { promptQueue: [], draining: false } satisfies WsData,
      })
    ) {
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
      send(ws, { type: "system_prompt", text: sessionSystemPrompt });
    },
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      const message = parseClientMessage(text);

      if (!message) {
        send(ws, { type: "error", message: "Invalid message" });
        return;
      }

      if (message.type === "reset") {
        ws.data.promptQueue.length = 0;
        send(ws, { type: "system_prompt", text: sessionSystemPrompt });
        return;
      }

      const prompt = message.message.trim();
      if (!prompt) {
        send(ws, { type: "error", message: "Empty message" });
        return;
      }

      ws.data.promptQueue.push(prompt);
      void drainPromptQueue(ws);
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
