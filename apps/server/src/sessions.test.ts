import { describe, expect, test } from "bun:test";
import type { BackgroundAgentTask } from "./state.js";
import { nextFreeAgentSlot } from "./sessions.js";

function task(slot: number): BackgroundAgentTask {
  return { slot } as unknown as BackgroundAgentTask;
}

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
