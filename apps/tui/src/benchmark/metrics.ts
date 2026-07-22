export type BenchmarkMetrics = {
  scenario: string;
  durationMs: number;
  rssMb: number;
  heapMb: number;
  eventLoopP50Ms: number;
  eventLoopP95Ms: number;
  markdownParses: number;
  measureElementCalls: number;
};

export function sampleMemory(): { rssMb: number; heapMb: number } {
  const usage = process.memoryUsage();
  return {
    rssMb: Math.round((usage.rss / (1024 * 1024)) * 10) / 10,
    heapMb: Math.round((usage.heapUsed / (1024 * 1024)) * 10) / 10,
  };
}

export async function measureEventLoopDelays(sampleCount = 40): Promise<{ p50: number; p95: number }> {
  const delays: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const expected = performance.now() + 16;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
    delays.push(Math.max(0, performance.now() - expected));
  }
  delays.sort((a, b) => a - b);
  const p50 = delays[Math.floor(delays.length * 0.5)] ?? 0;
  const p95 = delays[Math.floor(delays.length * 0.95)] ?? 0;
  return { p50, p95 };
}

export function createBenchmarkCounters() {
  return {
    markdownParses: 0,
    measureElementCalls: 0,
  };
}

export function formatBenchmarkReport(results: BenchmarkMetrics[]): string {
  const lines = [
    "# TUI benchmark report",
    "",
    "| Scenario | Duration (ms) | RSS (MB) | Heap (MB) | Event-loop P50 | Event-loop P95 | Markdown parses | measureElement |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.scenario} | ${result.durationMs.toFixed(1)} | ${result.rssMb} | ${result.heapMb} | ${result.eventLoopP50Ms.toFixed(1)} | ${result.eventLoopP95Ms.toFixed(1)} | ${result.markdownParses} | ${result.measureElementCalls} |`,
    );
  }

  return lines.join("\n");
}
