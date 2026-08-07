import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { BackgroundAgentTask, WsData } from "./state.js";
import { cancelMainTurn, nextFreeAgentSlot } from "./sessions.js";

function task(slot: number): BackgroundAgentTask {
  return { slot } as unknown as BackgroundAgentTask;
}

function makeWs(
  overrides: { controller?: AbortController; cancelRequested?: boolean } = {},
): { ws: ServerWebSocket<WsData>; data: WsData } {
  const data = {
    promptQueue: [],
    draining: false,
    cancelRequested: overrides.cancelRequested ?? false,
    abortController: overrides.controller,
  } as unknown as WsData;
  return { ws: { data } as unknown as ServerWebSocket<WsData>, data };
}

describe("cancelMainTurn", () => {
  test("aborts the in-flight turn and clears the cancel flag", () => {
    const controller = new AbortController();
    const { ws, data } = makeWs({ controller, cancelRequested: true });

    cancelMainTurn(ws);

    expect(controller.signal.aborted).toBe(true);
    expect(data.cancelRequested).toBe(false);
  });

  test("is a no-op when no turn is in flight", () => {
    const { ws, data } = makeWs();

    expect(() => cancelMainTurn(ws)).not.toThrow();
    expect(data.abortController).toBeUndefined();
    expect(data.cancelRequested).toBe(false);
  });
});

describe("nextFreeAgentSlot", () => {
  test("starts at slot 1 for an empty set", () => {
    expect(nextFreeAgentSlot([])).toBe(1);
  });

  test("skips all used slots when consecutive", () => {
    expect(nextFreeAgentSlot([task(1), task(2), task(3)])).toBe(4);
  });

  test("reuses the lowest freed slot", () => {
    // /2 and /3 were closed; the next sub-agent takes /2.
    expect(nextFreeAgentSlot([task(1), task(4), task(5)])).toBe(2);
    expect(nextFreeAgentSlot([task(3)])).toBe(1);
  });

  test("fills a gap after closing an earlier agent", () => {
    // /1 was closed, /2 and /3 still active.
    expect(nextFreeAgentSlot([task(2), task(3)])).toBe(1);
  });
});
