#!/usr/bin/env bun
import { MessageHeightCache, buildOffsets } from "../lib/heightCache.js";
import { splitStreamingMarkdown } from "../lib/streamingMarkdown.js";
import { streamRenderInterval } from "../lib/streamRender.js";
import {
  computeVirtualRange,
  quantizeScrollDelta,
} from "../lib/virtualScroll.js";
import {
  createStartupScript,
  createStreamScript,
  replayScript,
} from "./fakeWebSocket.js";
import {
  createBenchmarkCounters,
  formatBenchmarkReport,
  measureEventLoopDelays,
  sampleMemory,
  type BenchmarkMetrics,
} from "./metrics.js";

async function benchmarkStartup(messageCount: number): Promise<BenchmarkMetrics> {
  const cache = new MessageHeightCache();
  const counters = createBenchmarkCounters();
  const itemIds = Array.from({ length: messageCount }, (_, index) => `m-${index}`);
  for (const [index, id] of itemIds.entries()) {
    cache.set(id, 100, 3 + (index % 5));
  }

  const started = performance.now();
  const offsets = buildOffsets(itemIds, 100, cache);
  computeVirtualRange({
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
  computeVirtualRange({
    itemCount: itemIds.length,
    offsets,
    viewportHeight: 24,
    historyOffset: 120,
    followBottom: false,
    columns: 100,
    cache,
    itemIds,
    measuredKeys: new Set(itemIds),
    previousRange: [Math.max(0, itemIds.length - 40), itemIds.length],
    scrollVelocity: 24,
  });
  counters.measureElementCalls += itemIds.length;

  const script = createStartupScript(messageCount);
  await replayScript(script, () => {
    counters.markdownParses += 1;
  });

  const eventLoop = await measureEventLoopDelays();
  const memory = sampleMemory();
  return {
    scenario: `startup-${messageCount}`,
    durationMs: performance.now() - started,
    rssMb: memory.rssMb,
    heapMb: memory.heapMb,
    eventLoopP50Ms: eventLoop.p50,
    eventLoopP95Ms: eventLoop.p95,
    markdownParses: counters.markdownParses,
    measureElementCalls: counters.measureElementCalls,
  };
}

async function benchmarkStream(tokenCount: number): Promise<BenchmarkMetrics> {
  const counters = createBenchmarkCounters();
  let stable = "";
  const text = "word ".repeat(tokenCount);
  const started = performance.now();

  for (let index = 0; index < 200; index += 1) {
    const slice = text.slice(0, Math.floor((text.length * index) / 200));
    const split = splitStreamingMarkdown(slice, stable);
    stable = split.stablePrefix;
    counters.markdownParses += split.unstableSuffix ? 1 : 0;
  }

  const script = createStreamScript(tokenCount);
  await replayScript(script, () => {
    counters.markdownParses += 1;
  });

  const eventLoop = await measureEventLoopDelays();
  const memory = sampleMemory();
  return {
    scenario: `stream-${tokenCount}`,
    durationMs: performance.now() - started,
    rssMb: memory.rssMb,
    heapMb: memory.heapMb,
    eventLoopP50Ms: eventLoop.p50,
    eventLoopP95Ms: eventLoop.p95,
    markdownParses: counters.markdownParses,
    measureElementCalls: counters.measureElementCalls,
  };
}

async function benchmarkScrollSession(): Promise<BenchmarkMetrics> {
  const cache = new MessageHeightCache();
  const itemIds = Array.from({ length: 1000 }, (_, index) => `m-${index}`);
  for (const [index, id] of itemIds.entries()) {
    cache.set(id, 100, 4);
  }
  const offsets = buildOffsets(itemIds, 100, cache);
  const started = performance.now();
  let previousRange: readonly [number, number] | null = null;

  for (let step = 0; step < 200; step += 1) {
    const delta = quantizeScrollDelta(step % 2 === 0 ? 8 : -8);
    const historyOffset = Math.max(0, Math.min(800, step * 4 + delta));
    previousRange = computeVirtualRange({
      itemCount: itemIds.length,
      offsets,
      viewportHeight: 24,
      historyOffset,
      followBottom: historyOffset === 0,
      columns: 100,
      cache,
      itemIds,
      measuredKeys: new Set(itemIds),
      previousRange,
      scrollVelocity: Math.abs(delta),
    });
  }

  const eventLoop = await measureEventLoopDelays();
  const memory = sampleMemory();
  return {
    scenario: "scroll-session",
    durationMs: performance.now() - started,
    rssMb: memory.rssMb,
    heapMb: memory.heapMb,
    eventLoopP50Ms: eventLoop.p50,
    eventLoopP95Ms: eventLoop.p95,
    markdownParses: 0,
    measureElementCalls: 200,
  };
}

async function main(): Promise<void> {
  const results: BenchmarkMetrics[] = [];
  for (const count of [100, 500, 1000]) {
    results.push(await benchmarkStartup(count));
  }
  for (const tokens of [5000, 20000]) {
    results.push(await benchmarkStream(tokens));
  }
  results.push(await benchmarkScrollSession());

  console.log(formatBenchmarkReport(results));
  console.log("");
  console.log(`Adaptive stream interval @20k chars: ${streamRenderInterval(20_000)}ms`);
}

await main();
