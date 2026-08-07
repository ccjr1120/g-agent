import type { ServerWebSocket } from "bun";
import {
  loadAgents,
  resolveActiveAgent,
  type AgentConfig,
  type ConversationMessage,
  type LoadedAgents,
  type McpManager,
} from "@g-agent/agent";
import {
  getServerHost,
  getServerPort,
  loadConfig,
  type GAgentConfig,
  type ResolvedProvider,
} from "@g-agent/config";
import type { AgentTaskInfo, AgentTaskStatus, ServerMessage } from "@g-agent/shared";

export type WsData = {
  promptQueue: string[];
  draining: boolean;
  cancelRequested: boolean;
  abortController?: AbortController;
  history: ConversationMessage[];
  activeAgent: AgentConfig;
  systemPrompt: string;
  /** Effective provider after merging agent-level overrides. */
  effectiveProvider: ResolvedProvider | null;
  mcpManager: McpManager;
  agentTasks: BackgroundAgentTask[];
  activeAgentTaskSlot?: number;
  /**
   * In-flight `ask_user` questions awaiting a reply, keyed by a per-question
   * id. Several questions can be pending at once (a model's `Promise.all` tool
   * round may emit more than one `ask_user` call), and each resolves
   * independently when its own `ask_user_reply` arrives. No question is
   * superseded: only explicit replies / disconnect / abort settle each one.
   */
  pendingAsks: Map<string, { resolve: (reply: string) => void; reject: (error: Error) => void }>;
};

export type BackgroundAgentTask = {
  slot: number;
  agent: AgentConfig;
  title: string;
  status: AgentTaskStatus;
  activity?: string;
  createdAt: number;
  completedAt?: number;
  unread: boolean;
  mcpManager?: McpManager;
  history: ConversationMessage[];
  transcript: Array<{
    role: "user" | "assistant";
    content: string;
    thinking?: string;
    tools?: Array<{ name: string; args: string }>;
    durationMs?: number;
  }>;
  activeTurn?: {
    content: string;
    thinking: string;
    tools: Array<{ name: string; args: string }>;
  };
  promptQueue: string[];
  draining: boolean;
  abortController?: AbortController;
};

export const initialConfig = await loadConfig();
export let config = initialConfig.config;
export const configPath = initialConfig.path;
export let loadedAgents = await loadAgents(config);
export const { agent: initialAgent } = resolveActiveAgent(undefined, loadedAgents);
export const host = getServerHost();
export const port = getServerPort();

export const clients = new Set<ServerWebSocket<WsData>>();

export function setConfig(value: GAgentConfig): void {
  config = value;
}

export function setLoadedAgents(value: LoadedAgents): void {
  loadedAgents = value;
}

export function send(ws: ServerWebSocket<WsData>, message: ServerMessage): void {
  ws.send(JSON.stringify(message));
}

export function agentTaskInfo(task: BackgroundAgentTask): AgentTaskInfo {
  return {
    slot: task.slot,
    agent: task.agent.name,
    title: task.title,
    status: task.status,
    ...(task.activity ? { activity: task.activity } : {}),
    elapsedMs: Math.max(
      0,
      (task.completedAt ?? Date.now()) - task.createdAt,
    ),
    unread: task.unread,
  };
}

export function sendAgentTasks(ws: ServerWebSocket<WsData>): void {
  send(ws, {
    type: "agent_tasks",
    tasks: ws.data.agentTasks.map(agentTaskInfo),
  });
}
