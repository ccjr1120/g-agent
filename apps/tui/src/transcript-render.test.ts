import { describe, expect, test } from "bun:test";
import { annotateBlocks, needsGapBefore, streamingHasBody } from "./transcript-render.js";
import type { CollapsedBlock } from "./collapse.js";

describe("annotateBlocks", () => {
  test("only the first text block gets the assistant bullet", () => {
    const blocks: CollapsedBlock[] = [
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
    ];
    const annotated = annotateBlocks(blocks);
    expect(annotated.map((item) => item.showAssistantBullet)).toEqual([false, true, false]);
  });
});

describe("needsGapBefore", () => {
  test("inserts a gap between different kinds", () => {
    expect(needsGapBefore({ kind: "thinking", text: "a" }, { kind: "text", text: "b" })).toBe(true);
  });

  test("inserts a gap between consecutive body texts", () => {
    expect(needsGapBefore({ kind: "text", text: "a" }, { kind: "text", text: "b" })).toBe(true);
  });

  test("keeps consecutive tools compact", () => {
    expect(needsGapBefore({ kind: "tool", name: "a" }, { kind: "tool", name: "b" })).toBe(false);
  });
});

describe("streamingHasBody", () => {
  test("detects pending thinking", () => {
    expect(streamingHasBody([], "", "still thinking")).toBe(true);
  });
});
