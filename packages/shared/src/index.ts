export type ClientMessage =
  | { type: "chat"; message: string }
  | { type: "reset" }
  | { type: "agent"; name?: string };

export type ServerMessage =
  | { type: "ready" }
  | { type: "agents"; agents: Array<{ name: string; description: string; active: boolean }>; active: string }
  | { type: "agent_fallback"; requested: string; active: string }
  | { type: "skills"; skills: Array<{ name: string; description: string }> }
  | { type: "start" }
  | { type: "system_prompt"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; output: string }
  | { type: "done" }
  | { type: "error"; message: string };

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
    if (data.type === "agent") {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}
