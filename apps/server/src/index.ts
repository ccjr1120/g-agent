import type { ServerWebSocket } from "bun";
import {
  buildAgentSystemPrompt,
  builtinTools,
  McpManager,
  type ConversationMessage,
} from "@g-agent/agent";
import { formatProviderRef } from "@g-agent/config";
import { parseClientMessage } from "@g-agent/shared";
import {
  clients,
  configPath,
  host,
  initialAgent,
  loadedAgents,
  port,
  send,
  sendAgentTasks,
  type WsData,
} from "./state.js";
import { loadPersistedAgentTasks, persistAgentTasks } from "./agent-tasks.js";
import {
  activeMcpContext,
  ensureReloadWatches,
  refreshClient,
  reloadAgentsCatalog,
  reloadAndRefreshClients,
  sendAgentsCatalog,
  sendMcpCatalog,
  syncActiveAgentConfig,
} from "./catalog.js";
import {
  buildSkillPrompt,
  connectMcpForAgent,
  mergedMcpServers,
  resolveProvider,
} from "./helpers.js";
import { sendContextUsage } from "./usage.js";
import {
  applyAgentSwitch,
  createAgentSession,
  drainAgentSessionQueue,
  loadStartupAgent,
  restartSession,
  sendAgentSession,
} from "./sessions.js";
import { drainPromptQueue, runPrompt } from "./prompt.js";
import {
  persistScheduledTasks,
  runScheduledTask,
  scheduledTaskStore,
  sendScheduledTasksToAll,
} from "./scheduled-runtime.js";
import { scheduledTaskInfo } from "./scheduled.js";

Bun.serve<WsData>({
  port,
  hostname: host,
  fetch(req, server) {
    if (
      server.upgrade(req, {
        data: {
          promptQueue: [],
          draining: false,
          cancelRequested: false,
          history: [],
          activeAgent: initialAgent,
          systemPrompt: buildAgentSystemPrompt(initialAgent, loadedAgents),
          effectiveProvider: resolveProvider(initialAgent),
          mcpManager: new McpManager(),
          agentTasks: [],
          pendingAsks: new Map(),
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
      clients.add(ws);
      void (async () => {
        const { agent } = await loadStartupAgent();
        ws.data.activeAgent = agent;
        ws.data.systemPrompt = buildAgentSystemPrompt(agent, loadedAgents);
        ws.data.effectiveProvider = resolveProvider(agent);
        ws.data.mcpManager = await connectMcpForAgent(agent);

        // Restore sub-agent sessions persisted across server restarts. MCP
        // connections reconnect lazily on the next prompt in that session.
        ws.data.agentTasks = await loadPersistedAgentTasks(loadedAgents);

        send(ws, { type: "ready" });
        refreshClient(ws);
        sendAgentTasks(ws);
        sendScheduledTasksToAll();
      })();
    },
    close(ws) {
      clients.delete(ws);
      for (const { reject } of ws.data.pendingAsks.values()) {
        reject(new Error("disconnected"));
      }
      ws.data.pendingAsks.clear();
      void ws.data.mcpManager.close();
      for (const task of ws.data.agentTasks) {
        void task.mcpManager?.close();
      }
    },
    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      const message = parseClientMessage(text);

      if (!message) {
        send(ws, { type: "error", message: "Invalid message" });
        return;
      }

      if (message.type === "reset") {
        void restartSession(ws).catch((error) => {
          send(ws, {
            type: "error",
            message:
              error instanceof Error ? error.message : "Session restart failed",
          });
        });
        return;
      }

      if (message.type === "agent_tasks") {
        sendAgentTasks(ws);
        return;
      }

      if (message.type === "scheduled_tasks") {
        sendScheduledTasksToAll();
        return;
      }

      if (message.type === "scheduled_task_cancel") {
        const index = scheduledTaskStore.findIndex(
          (task) => task.id === message.id,
        );
        if (index === -1) {
          send(ws, {
            type: "error",
            message: `Unknown scheduled task "${message.id}"`,
          });
          return;
        }
        const [removed] = scheduledTaskStore.splice(index, 1);
        void removed?.mcpManager?.close();
        void persistScheduledTasks();
        sendScheduledTasksToAll();
        return;
      }

      if (message.type === "scheduled_task_run") {
        const task = scheduledTaskStore.find(
          (candidate) => candidate.id === message.id,
        );
        if (!task) {
          send(ws, {
            type: "error",
            message: `Unknown scheduled task "${message.id}"`,
          });
          return;
        }
        if (task.running) {
          send(ws, { type: "notice", message: `Scheduled task "${task.label}" is already running` });
          return;
        }
        task.nextRunAt = Date.now();
        sendScheduledTasksToAll();
        void runScheduledTask(task);
        return;
      }

      if (message.type === "scheduled_task_history") {
        const task = scheduledTaskStore.find(
          (candidate) => candidate.id === message.id,
        );
        if (!task) {
          send(ws, {
            type: "error",
            message: `Unknown scheduled task "${message.id}"`,
          });
          return;
        }
        send(ws, {
          type: "scheduled_task_history",
          id: task.id,
          runs: task.runs,
        });
        return;
      }

      if (message.type === "agent_task") {
        const task = ws.data.agentTasks.find(
          (candidate) => candidate.slot === message.slot,
        );
        if (!task) {
          send(ws, {
            type: "error",
            message: `Unknown agent task /${message.slot}`,
          });
          return;
        }
        ws.data.activeAgentTaskSlot = task.slot;
        task.unread = false;
        void persistAgentTasks(ws.data.agentTasks);
        sendAgentSession(ws, task);
        sendAgentTasks(ws);
        sendMcpCatalog(ws);
        return;
      }

      if (message.type === "agent_back") {
        ws.data.activeAgentTaskSlot = undefined;
        sendAgentSession(ws);
        sendMcpCatalog(ws);
        return;
      }

      if (message.type === "agent_task_close") {
        const index = ws.data.agentTasks.findIndex(
          (task) => task.slot === message.slot,
        );
        if (index === -1) {
          send(ws, {
            type: "error",
            message: `Unknown agent task /${message.slot}`,
          });
          return;
        }
        const [removed] = ws.data.agentTasks.splice(index, 1);
        removed.abortController?.abort();
        void removed.mcpManager?.close();
        if (ws.data.activeAgentTaskSlot === removed.slot) {
          ws.data.activeAgentTaskSlot = undefined;
          sendAgentSession(ws);
        }
        void persistAgentTasks(ws.data.agentTasks);
        sendAgentTasks(ws);
        return;
      }

      if (message.type === "cancel") {
        const activeTask = ws.data.activeAgentTaskSlot
          ? ws.data.agentTasks.find(
              (task) => task.slot === ws.data.activeAgentTaskSlot,
            )
          : undefined;
        if (activeTask) {
          activeTask.promptQueue.length = 0;
          activeTask.abortController?.abort();
          return;
        }
        ws.data.cancelRequested = ws.data.abortController !== undefined;
        ws.data.promptQueue.length = 0;
        ws.data.abortController?.abort();
        return;
      }

      if (message.type === "ask_user_reply") {
        const pending = ws.data.pendingAsks.get(message.id);
        if (!pending) {
          return;
        }
        ws.data.pendingAsks.delete(message.id);
        pending.resolve(message.reply);
        return;
      }

      if (message.type === "resume") {
        if (message.history.length === 0) {
          send(ws, { type: "error", message: "Cannot resume an empty session" });
          return;
        }

        void (async () => {
          await reloadAgentsCatalog();
          const targetName = message.agent.trim();
          const target = loadedAgents.agents.get(targetName);
          if (!target) {
            send(ws, { type: "error", message: `Unknown agent "${targetName}"` });
            return;
          }

          await applyAgentSwitch(ws, target, { clearHistory: false });
          ws.data.history = message.history.map((turn) => ({
            role: turn.role,
            content: turn.content,
          })) satisfies ConversationMessage[];

          send(ws, {
            type: "resumed",
            agent: ws.data.activeAgent.name,
            turns: ws.data.history.length,
          });
          sendContextUsage(ws);
        })();
        return;
      }

      if (message.type === "agent") {
        void (async () => {
          await reloadAgentsCatalog();
          syncActiveAgentConfig(ws);

          if (!message.name) {
            sendAgentsCatalog(ws);
            return;
          }

          const targetName = message.name.trim();
          const target = loadedAgents.agents.get(targetName);
          if (!target) {
            send(ws, { type: "error", message: `Unknown agent "${targetName}"` });
            return;
          }
          if (target.name === loadedAgents.defaultName) {
            ws.data.activeAgentTaskSlot = undefined;
            sendAgentSession(ws);
            sendMcpCatalog(ws);
            return;
          }

          const initialMessage = message.message?.trim();
          const task = createAgentSession(ws, target, !initialMessage);
          if (initialMessage) {
            task.status = "queued";
            task.activity = "Queued";
            task.promptQueue.push(initialMessage);
            sendAgentTasks(ws);
            void drainAgentSessionQueue(ws, task);
          }
        })();
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

      if (message.type === "mcp") {
        sendMcpCatalog(ws);
        return;
      }

      if (message.type === "reload") {
        void reloadAndRefreshClients().catch((error) => {
          send(ws, {
            type: "error",
            message:
              error instanceof Error ? error.message : "Reload failed",
          });
        });
        return;
      }

      if (message.type === "mcp_auth") {
        void (async () => {
          const serverName = message.name.trim();
          if (!serverName) {
            send(ws, { type: "error", message: "MCP server name is required" });
            return;
          }

          const { agent, manager } = activeMcpContext(ws);
          if (!manager) {
            send(ws, {
              type: "error",
              message: "MCP server is not connected yet",
            });
            return;
          }
          const merged = mergedMcpServers(agent);
          if (!(serverName in merged)) {
            send(ws, {
              type: "error",
              message: `Unknown MCP server "${serverName}"`,
            });
            return;
          }

          send(ws, {
            type: "start",
          });

          try {
            const result = await manager.authenticate(serverName);
            if (result.ok) {
              console.log(
                `MCP OAuth complete for agent=${agent.name} server=${serverName} tools=${result.toolCount ?? 0}`,
              );
            } else {
              console.warn(
                `MCP OAuth failed for agent=${agent.name} server=${serverName}: ${result.error}`,
              );
              send(ws, {
                type: "error",
                message: result.error ?? "MCP OAuth authorization failed",
              });
            }
          } catch (error) {
            const messageText =
              error instanceof Error ? error.message : "MCP OAuth authorization failed";
            send(ws, { type: "error", message: messageText });
          } finally {
            sendMcpCatalog(ws);
            send(ws, { type: "done" });
          }
        })();
        return;
      }

      const rawPrompt = message.message;
      if (!rawPrompt.trim()) {
        send(ws, { type: "error", message: "Empty message" });
        return;
      }

      const activeTask = ws.data.activeAgentTaskSlot
        ? ws.data.agentTasks.find(
            (task) => task.slot === ws.data.activeAgentTaskSlot,
          )
        : undefined;
      if (activeTask) {
        activeTask.status = "queued";
        activeTask.activity = "Queued";
        activeTask.promptQueue.push(rawPrompt);
        sendAgentTasks(ws);
        void drainAgentSessionQueue(ws, activeTask);
        return;
      }

      ws.data.promptQueue.push(rawPrompt.trim());
      void drainPromptQueue(ws);
    },
  },
});

ensureReloadWatches();

setInterval(() => {
  const now = Date.now();
  for (const task of scheduledTaskStore) {
    if (!task.running && task.nextRunAt <= now) {
      void runScheduledTask(task);
    }
  }
  if (scheduledTaskStore.length > 0) {
    for (const ws of clients) {
      send(ws, {
        type: "scheduled_tasks",
        tasks: scheduledTaskStore.map(scheduledTaskInfo),
      });
    }
  }
  for (const ws of clients) {
    if (
      ws.data.agentTasks.some((task) =>
        ["queued", "starting", "thinking", "tool_running", "responding"].includes(
          task.status,
        ),
      )
    ) {
      sendAgentTasks(ws);
    }
  }
}, 1_000);

const startupProvider = resolveProvider(initialAgent);
const providerLabel = startupProvider ? formatProviderRef(startupProvider) : "echo";
const configLabel = configPath ?? "none";
const agentsLabel = `${loadedAgents.list.length}${loadedAgents.userPath ? ` (user: ${loadedAgents.userPath})` : ""}`;
const builtinCount = initialAgent.skills.filter((s) => s.source === "builtin").length;
const sharedCount = initialAgent.skills.filter((s) => s.source === "shared").length;
const gagentCount = initialAgent.skills.filter((s) => s.source === "gagent").length;
const selfCount = initialAgent.skills.filter((s) => s.source === "self").length;
const sharedLabel = loadedAgents.sharedSkillsPath ?? "none";
const gagentLabel = loadedAgents.gagentSkillsPath ?? "none";
const skillsLabel = `built-in=${builtinCount} shared=${sharedCount} gagent=${gagentCount} self=${selfCount} shared-path=${sharedLabel} gagent-path=${gagentLabel}`;
const mcpCount = Object.keys(mergedMcpServers(initialAgent)).length;
console.log(
  `G-Agent server ws://${host}:${port} · agent=${initialAgent.name} · provider=${providerLabel} · config=${configLabel} · agents=${agentsLabel} · skills=${skillsLabel} · tools=${builtinTools.length} · mcp=${mcpCount}`,
);

for (const conflict of loadedAgents.skillConflicts) {
  const candidates = conflict.candidates
    .map((candidate) => `${candidate.source}:${candidate.path}`)
    .join(" | ");
  console.warn(
    `Skill conflict agent=${conflict.agent} skill=${conflict.name} selected=${conflict.selectedSource} candidates=${candidates}`,
  );
}
