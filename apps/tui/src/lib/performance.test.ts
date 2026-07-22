import { describe, expect, test } from "bun:test";
import { MessageHeightCache, buildOffsets } from "./heightCache.js";
import { splitStreamingMarkdown } from "./streamingMarkdown.js";
import { streamRenderInterval } from "./streamRender.js";
import { computeVirtualRange, quantizeScrollDelta } from "./virtualScroll.js";

describe("heightCache", () => {
  test("caches by message id and terminal columns", () => {
    const cache = new MessageHeightCache();
    cache.set("a", 100, 12);
    expect(cache.get("a", 100)).toBe(12);
    expect(cache.get("a", 80)).toBeUndefined();
  });

  test("scales heights when terminal width changes", () => {
    const cache = new MessageHeightCache();
    cache.set("a", 100, 20);
    cache.scaleColumns(100, 50);
    expect(cache.get("a", 50)).toBe(40);
  });
});

describe("streamingMarkdown", () => {
  test("advances stable prefix at blank-line boundaries", () => {
    const first = splitStreamingMarkdown("Hello\n\nWorld", "");
    expect(first.stablePrefix).toBe("Hello\n\n");
    expect(first.unstableSuffix).toBe("World");

    const second = splitStreamingMarkdown("Hello\n\nWorld!", first.stablePrefix);
    expect(second.stablePrefix).toBe("Hello\n\n");
    expect(second.unstableSuffix).toBe("World!");
  });
});

describe("virtualScroll", () => {
  test("mounts only a bounded window for long histories", () => {
    const cache = new MessageHeightCache();
    const itemIds = Array.from({ length: 500 }, (_, index) => `m-${index}`);
    for (const id of itemIds) {
      cache.set(id, 100, 4);
    }
    const offsets = buildOffsets(itemIds, 100, cache);
    const range = computeVirtualRange({
      itemCount: itemIds.length,
      offsets,
      viewportHeight: 24,
      historyOffset: 0,
      followBottom: true,
      columns: 100,
      cache,
      itemIds,
      measuredKeys: new Set(itemIds),
      previousRange: null,
      scrollVelocity: 0,
    });
    expect(range[1] - range[0]).toBeLessThanOrEqual(300);
    expect(range[1]).toBe(500);
  });

  test("quantizes large scroll deltas", () => {
    expect(quantizeScrollDelta(1)).toBe(1);
    expect(quantizeScrollDelta(8)).toBe(8);
    expect(quantizeScrollDelta(45)).toBe(60);
  });
});

describe("streamRender", () => {
  test("slows down under sustained output and event-loop pressure", () => {
    expect(streamRenderInterval(500)).toBe(32);
    expect(streamRenderInterval(5000)).toBe(50);
    expect(streamRenderInterval(20000)).toBe(80);
    expect(streamRenderInterval(500, 35)).toBe(50);
  });
});
