import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { McpManager } from "@g-agent/agent";
import { activeMcpContext } from "./catalog.js";
import type { BackgroundAgentTask, WsData } from "./state.js";

function agent(name: string, mcpServers?: Record<string, unknown>) {
  return { name, mcpServers } as unknown as WsData["activeAgent"];
}

function manager(): McpManager {
  return {} as unknown as McpManager;
}

function ws(data: Partial<WsData>): ServerWebSocket<WsData> {
  return { data } as unknown as ServerWebSocket<WsData>;
}

describe("activeMcpContext", () => {
  test("returns the main agent when no sub-agent session is open", () => {
    const main = agent("default", { mainMcp: { url: "http://a" } });
    const context = activeMcpContext(
      ws({
        activeAgent: main,
        mcpManager: manager(),
        agentTasks: [],
        activeAgentTaskSlot: undefined,
      }),
    );
    expect(context.agent.name).toBe("default");
    expect(context.manager).not.toBeNull();
  });

  test("returns the open sub-agent session's agent and manager", () => {
    const main = agent("default", { mainMcp: { url: "http://a" } });
    const sub = agent("obsidian-agent", { obsidian: { url: "http://b" } });
    const subManager = manager();
    const task = {
      slot: 1,
      agent: sub,
      mcpManager: subManager,
    } as unknown as BackgroundAgentTask;

    const context = activeMcpContext(
      ws({
        activeAgent: main,
        mcpManager: manager(),
        agentTasks: [task],
        activeAgentTaskSlot: 1,
      }),
    );

    expect(context.agent.name).toBe("obsidian-agent");
    expect(context.agent.mcpServers).toEqual({ obsidian: { url: "http://b" } });
    expect(context.manager).toBe(subManager);
  });

  test("reports a null manager before the sub-agent connects MCP", () => {
    const sub = agent("kb-agent", { knowledge: { url: "http://c" } });
    const task = {
      slot: 2,
      agent: sub,
    } as unknown as BackgroundAgentTask;

    const context = activeMcpContext(
      ws({
        activeAgent: agent("default"),
        mcpManager: manager(),
        agentTasks: [task],
        activeAgentTaskSlot: 2,
      }),
    );

    expect(context.agent.name).toBe("kb-agent");
    expect(context.manager).toBeNull();
  });

  test("falls back to the main session for an unknown slot", () => {
    const main = agent("default", { mainMcp: { url: "http://a" } });
    const context = activeMcpContext(
      ws({
        activeAgent: main,
        mcpManager: manager(),
        agentTasks: [],
        activeAgentTaskSlot: 9,
      }),
    );
    expect(context.agent.name).toBe("default");
  });
});
