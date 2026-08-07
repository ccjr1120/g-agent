import { describe, expect, test } from "bun:test";
import { dispatchActions } from "./dispatch.js";

describe("dispatchActions", () => {
  const base = {
    activeSlot: undefined as number | undefined,
    turnBusy: false,
    activeAgent: "default",
    agents: [{ name: "research", description: "Research agent" }],
    skills: [{ name: "weekly-report", description: "Weekly report" }],
    mcp: [],
    scheduledTasks: [],
    transcriptLines: [],
  };

  test("exit in main session quits", () => {
    expect(dispatchActions({ ...base, text: "exit" })).toEqual([{ type: "quit" }]);
  });

  test("exit in sub-session closes it", () => {
    const actions = dispatchActions({ ...base, text: "exit", activeSlot: 2 });
    expect(actions[0]).toEqual({ type: "close_sub", slot: 2 });
  });

  test("/back sends agent_back", () => {
    expect(dispatchActions({ ...base, text: "/back" })).toEqual([
      { type: "send", message: { type: "agent_back" } },
    ]);
  });

  test("/1 opens sub-agent slot", () => {
    expect(dispatchActions({ ...base, text: "/1" })).toEqual([{ type: "open_task", slot: 1 }]);
  });

  test("/skill shortcut invokes skill", () => {
    expect(dispatchActions({ ...base, text: "/weekly-report" })).toEqual([
      { type: "send", message: { type: "skill", name: "weekly-report" } },
    ]);
  });
});
