import type { ServerWebSocket } from "bun";
import {
  buildAgentSystemPrompt,
  builtinTools,
  loadAgents,
  resolveActiveAgent,
  runAgent,
  type AgentConfig,
  type LoadedAgents,
  type ResolvedAgent,
} from "@g-agent/agent";
import {
  formatProviderRef,
  getActiveProvider,
  getServerHost,
  getServerPort,
  loadConfig,
  mergeAgentProviderOverrides,
  type ResolvedProvider,
} from "@g-agent/config";
import type { Skill } from "@g-agent/agent";
import { parseClientMessage, type ServerMessage } from "@g-agent/shared";

const { config, path: configPath } = await loadConfig();
const loadedAgents = await loadAgents();
const { agent: initialAgent, fallback } = resolveActiveAgent(
  config.agent,
  loadedAgents,
);
const host = getServerHost();
const port = getServerPort();

function resolveProvider(agent: AgentConfig): ResolvedProvider | null {
  try {
    return getActiveProvider(
      mergeAgentProviderOverrides(config, {
        provider: agent.provider,
        providers: agent.providers,
      }),
    );
  } catch {
    return null;
  }
}

type WsData = {
  promptQueue: string[];
  draining: boolean;
  activeAgent: AgentConfig;
  systemPrompt: string;
  /** Effective provider after merging agent-level overrides. */
  effectiveProvider: ResolvedProvider | null;
  /** Set once per connection from the startup fallback; surfaced to the
   * client as an `agent_fallback` hint on socket open. */
  startupFallback?: { requested: string };
};

function send(ws: ServerWebSocket<WsData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

function agentCatalog(loaded: LoadedAgents, active: AgentConfig) {
  return loaded.list.map((a) => ({
    name: a.name,
    description: a.description,
    active: a.name === active.name,
  }));
}

function skillsCatalog(active: AgentConfig) {
  return active.skills.map((s) => ({ name: s.name, description: s.description }));
}

/**
 * Build the prompt that injects a skill's SKILL.md body into a conversation
 * turn, so the model follows the skill's instructions on demand. `body` is
 * already loaded and `{{skill_dir}}`-templated by `loadSkillsFromDir`.
 */
function buildSkillPrompt(skill: Skill): string {
  const header = skill.description
    ? `技能：${skill.name}\n说明：${skill.description}\n`
    : `技能：${skill.name}\n`;
  return [
    "请按以下技能指令执行。",
    "",
    header,
    "指令正文：",
    "---",
    skill.body,
    "---",
    "",
    "请立即开始执行该技能。需要用户输入时主动询问用户。",
  ].join("\n");
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
    ws.data.effectiveProvider,
    ws.data.systemPrompt,
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
        data: {
          promptQueue: [],
          draining: false,
          activeAgent: initialAgent,
          systemPrompt: buildAgentSystemPrompt(initialAgent, loadedAgents),
          effectiveProvider: resolveProvider(initialAgent),
          startupFallback: fallback,
        } satisfies WsData,
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
      if (ws.data.startupFallback) {
        send(ws, {
          type: "agent_fallback",
          requested: ws.data.startupFallback.requested,
          active: ws.data.activeAgent.name,
        });
      }
      send(ws, {
        type: "agents",
        agents: agentCatalog(loadedAgents, ws.data.activeAgent),
        active: ws.data.activeAgent.name,
      });
      send(ws, {
        type: "skills",
        skills: skillsCatalog(ws.data.activeAgent),
      });
      send(ws, { type: "system_prompt", text: ws.data.systemPrompt });
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
        send(ws, { type: "system_prompt", text: ws.data.systemPrompt });
        return;
      }

      if (message.type === "agent") {
        if (!message.name) {
          send(ws, {
            type: "agents",
            agents: agentCatalog(loadedAgents, ws.data.activeAgent),
            active: ws.data.activeAgent.name,
          });
          return;
        }

        const targetName = message.name.trim();
        const target = loadedAgents.agents.get(targetName);
        if (!target) {
          send(ws, { type: "error", message: `Unknown agent "${targetName}"` });
          return;
        }

        // Switching to the currently active agent is a no-op apart from
        // re-sending the catalog so the client stays in sync.
        if (target.name === ws.data.activeAgent.name) {
          send(ws, {
            type: "agents",
            agents: agentCatalog(loadedAgents, ws.data.activeAgent),
            active: ws.data.activeAgent.name,
          });
          return;
        }

        ws.data.activeAgent = target;
        ws.data.systemPrompt = buildAgentSystemPrompt(target, loadedAgents);
        ws.data.effectiveProvider = resolveProvider(target);
        ws.data.promptQueue.length = 0;

        send(ws, {
          type: "agents",
          agents: agentCatalog(loadedAgents, target),
          active: target.name,
        });
        send(ws, { type: "skills", skills: skillsCatalog(target) });
        send(ws, { type: "system_prompt", text: ws.data.systemPrompt });
        return;
      }

      if (message.type === "skill") {
        const skillName = message.name.trim();
        if (!skillName) {
          send(ws, { type: "error", message: "Empty skill name" });
          return;
        }

        const skill = ws.data.activeAgent.skills.find(
          (s) => s.name === skillName,
        );
        if (!skill) {
          send(ws, { type: "error", message: `Unknown skill "${skillName}"` });
          return;
        }

        ws.data.promptQueue.push(buildSkillPrompt(skill));
        void drainPromptQueue(ws);
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

const startupProvider = resolveProvider(initialAgent);
const providerLabel = startupProvider ? formatProviderRef(startupProvider) : "echo";
const configLabel = configPath ?? "none";
const agentsLabel = `${loadedAgents.list.length}${loadedAgents.userPath ? ` (user: ${loadedAgents.userPath})` : ""}`;
const builtinCount = initialAgent.skills.filter((s) => s.source === "builtin").length;
const userCount = initialAgent.skills.filter((s) => s.source === "user").length;
const skillsLabel = `builtin=${builtinCount} user=${userCount}`;
console.log(
  `G-Agent server ws://${host}:${port} · agent=${initialAgent.name} · provider=${providerLabel} · config=${configLabel} · agents=${agentsLabel} · skills=${skillsLabel} · tools=${builtinTools.length}`,
);
