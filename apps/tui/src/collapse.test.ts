import { describe, expect, test } from "bun:test";
import { applyCollapse } from "./collapse.js";
import type { DisplayBlock } from "./transcript.js";

describe("applyCollapse", () => {
  test("hides older tools when more than two are present", () => {
    const blocks: DisplayBlock[] = [
      { kind: "tool", name: "a" },
      { kind: "tool", name: "b" },
      { kind: "tool", name: "c" },
    ];
    const collapsed = applyCollapse(blocks, false);
    expect(collapsed.map((b) => (b.kind === "tool" ? b.name : null)).filter(Boolean)).toEqual(["b", "c"]);
    expect(collapsed[0]?.collapseHint).toContain("1 earlier tool call");
  });

  test("shows all blocks when expanded", () => {
    const blocks: DisplayBlock[] = [
      { kind: "tool", name: "a" },
      { kind: "tool", name: "b" },
      { kind: "tool", name: "c" },
    ];
    expect(applyCollapse(blocks, true)).toHaveLength(3);
  });
});
