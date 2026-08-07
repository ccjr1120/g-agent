import { describe, expect, test } from "bun:test";
import { buildMenuItems, CHAT_OTHER_COMMAND, type MenuContext } from "./menu.js";

const ctx: MenuContext = {
  agents: [
    { name: "default", description: "main" },
    { name: "coder", description: "write code" },
  ],
  skills: [{ name: "weekly-report", description: "Weekly report" }],
  mcp: [],
  agentTasks: [],
  savedSessions: [],
  activeAgent: "default",
};

describe("buildMenuItems", () => {
  test("ends with the Chat other… fallback on the root menu", () => {
    const items = buildMenuItems("/", ctx);
    expect(items[items.length - 1]).toEqual(CHAT_OTHER_COMMAND);
  });

  test("Chat other… survives prefix filtering", () => {
    const items = buildMenuItems("/skill", ctx);
    expect(items[items.length - 1]).toEqual(CHAT_OTHER_COMMAND);
  });

  test("agent completion menu keeps Chat other… last", () => {
    const items = buildMenuItems("/agent ", ctx);
    expect(items.some((item) => item.value === "/agent coder ")).toBe(true);
    expect(items[items.length - 1]).toEqual(CHAT_OTHER_COMMAND);
  });

  test("non-command text yields no menu", () => {
    expect(buildMenuItems("hello", ctx)).toEqual([]);
  });
});
