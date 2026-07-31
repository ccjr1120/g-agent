export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

export type ClientMessage =
  | { type: "chat"; message: string }
  | { type: "cancel" }
  | { type: "reset" }
  | { type: "agent"; name?: string }
  | { type: "skill"; name: string }
  | { type: "mcp" }
  | { type: "mcp_auth"; name: string }
  | { type: "reload" }
  | { type: "agent_task"; slot: number }
  | { type: "agent_tasks" }
  | { type: "agent_back" }
  | { type: "resume"; agent: string; history: ConversationTurn[] };

export type AgentTaskStatus =
  | "idle"
  | "queued"
  | "starting"
  | "thinking"
  | "tool_running"
  | "responding"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentTaskInfo = {
  slot: number;
  agent: string;
  title: string;
  status: AgentTaskStatus;
  activity?: string;
  elapsedMs: number;
  unread: boolean;
};

export type McpServerCatalogEntry = {
  name: string;
  source: "global" | "agent";
  transport: "stdio" | "url";
  target: string;
  connected: boolean;
  error?: string;
  toolCount: number;
  tools: Array<{ name: string; description: string }>;
  oauth?: boolean;
  authRequired?: boolean;
};

export type ServerMessage =
  | { type: "ready" }
  | { type: "agents"; agents: Array<{ name: string; description: string; active: boolean }>; active: string; model: string }
  | { type: "skills"; skills: Array<{ name: string; description: string; source: "builtin" | "shared" | "gagent" | "self" }> }
  | { type: "mcp"; servers: McpServerCatalogEntry[] }
  | { type: "context"; usedTokens: number; maxTokens: number; percent: number }
  | { type: "start" }
  | { type: "system_prompt"; text: string }
  | { type: "thinkingDelta"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; output: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "resumed"; agent: string; turns: number }
  | { type: "agent_tasks"; tasks: AgentTaskInfo[] }
  | {
      type: "agent_session";
      slot?: number;
      agent: string;
      model: string;
      history: ConversationTurn[];
    };

export const DEFAULT_SERVER_PORT = 3847;
export const DEFAULT_SERVER_URL = `ws://127.0.0.1:${DEFAULT_SERVER_PORT}`;

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    return JSON.parse(raw) as ServerMessage;
  } catch {
    return null;
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const data = JSON.parse(raw) as ClientMessage;
    if (data.type === "chat" && typeof data.message === "string") {
      return data;
    }
    if (data.type === "reset") {
      return data;
    }
    if (data.type === "cancel") {
      return data;
    }
    if (data.type === "agent") {
      return data;
    }
    if (data.type === "skill" && typeof data.name === "string") {
      return data;
    }
    if (data.type === "mcp") {
      return data;
    }
    if (data.type === "mcp_auth" && typeof data.name === "string") {
      return data;
    }
    if (data.type === "reload") {
      return data;
    }
    if (
      data.type === "agent_task" &&
      typeof data.slot === "number" &&
      Number.isInteger(data.slot) &&
      data.slot > 0
    ) {
      return data;
    }
    if (data.type === "agent_tasks") {
      return data;
    }
    if (data.type === "agent_back") {
      return data;
    }
    if (data.type === "resume") {
      if (typeof data.agent !== "string" || !Array.isArray(data.history)) {
        return null;
      }
      for (const turn of data.history) {
        if (
          !turn ||
          (turn.role !== "user" && turn.role !== "assistant") ||
          typeof turn.content !== "string"
        ) {
          return null;
        }
      }
      return data;
    }
    return null;
  } catch {
    return null;
  }
}
