import { describe, expect, test } from "bun:test";
import {
  formatMmss,
  formatMs,
  lineToBlocks,
  simpleLineBlock,
  truncateToWidth,
  type DisplayBlock,
} from "./transcript.js";
import type { ChatLine } from "./model.js";

function line(over: Partial<ChatLine>): ChatLine {
  return {
    id: "l",
    role: "assistant",
    text: "",
    segments: [],
    pendingThinking: "",
    pendingText: "",
    queued: false,
    ...over,
  };
}

describe("lineToBlocks", () => {
  test("emits segments in model order (thinking → text → tools)", () => {
    const l = line({
      text: "final body",
      segments: [
        { type: "thinking", text: "reasoning" },
        { type: "tool", name: "read", args: "{}", status: "ok" },
      ],
    });
    const blocks = lineToBlocks(l);
    expect(blocks.map((b) => b.kind)).toEqual(["thinking", "tool", "text"]);
  });

  test("appends trailing body text after a thinking-only turn", () => {
    const l = line({
      text: "the answer",
      segments: [{ type: "thinking", text: "hmm" }],
    });
    const blocks = lineToBlocks(l);
    expect(blocks).toEqual([
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: "the answer" },
    ]);
  });

  test("does not duplicate a text segment already present as the last segment", () => {
    const l = line({
      text: "same",
      segments: [{ type: "text", text: "same" }],
    });
    const blocks = lineToBlocks(l);
    expect(blocks).toEqual([{ kind: "text", text: "same" }]);
  });

  test("does not emit trailing body when includeTrailingText is false", () => {
    const l = line({
      text: "body",
      segments: [{ type: "thinking", text: "hmm" }],
    });
    const blocks = lineToBlocks(l, false);
    expect(blocks).toEqual([{ kind: "thinking", text: "hmm" }]);
  });

  test("empty segments with no text yields no blocks", () => {
    expect(lineToBlocks(line({}))).toEqual([]);
  });

  test("tool timing annotation is attached from durationMs", () => {
    const l = line({
      segments: [{ type: "tool", name: "bash", args: "ls", status: "ok", durationMs: 65000 }],
    });
    const blocks = lineToBlocks(l);
    const tool = blocks[0] as Extract<DisplayBlock, { kind: "tool" }>;
    expect(tool.name).toBe("bash");
    expect(tool.ok).toBe(true);
    expect(tool.timing).toBe("· 1m5s");
  });
});

describe("simpleLineBlock", () => {
  test("maps a user/error/status line to a single text block", () => {
    expect(simpleLineBlock("user", "hello")).toEqual({ kind: "user", text: "hello" });
    expect(simpleLineBlock("error", "boom")).toEqual({ kind: "error", text: "boom" });
    expect(simpleLineBlock("status", "done")).toEqual({ kind: "status", text: "done" });
  });
});

describe("formatMs", () => {
  test("sub-second shows a tenth", () => {
    expect(formatMs(400)).toBe("0.4s");
  });
  test("minutes and seconds", () => {
    expect(formatMs(65000)).toBe("1m5s");
  });
  test("boundary exactly one second", () => {
    expect(formatMs(1000)).toBe("1s");
  });
});

describe("formatMmss", () => {
  test("pads to mm:ss", () => {
    expect(formatMmss(0)).toBe("00:00");
    expect(formatMmss(5_000)).toBe("00:05");
    expect(formatMmss(75_000)).toBe("01:15");
  });
  test("clamps negatives to zero", () => {
    expect(formatMmss(-10)).toBe("00:00");
  });
});

describe("truncateToWidth", () => {
  test("keeps short text", () => {
    expect(truncateToWidth("abc", 5)).toBe("abc");
  });
  test("truncates long text with ellipsis", () => {
    expect(truncateToWidth("abcdefghij", 5)).toBe("abcd…");
  });
  test("boundary zero width", () => {
    expect(truncateToWidth("abcdef", 0)).toBe("…");
  });
});