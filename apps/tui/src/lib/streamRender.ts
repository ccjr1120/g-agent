const SHORT_STREAM_RENDER_INTERVAL_MS = 32;
const MEDIUM_STREAM_RENDER_INTERVAL_MS = 50;
const LONG_STREAM_RENDER_INTERVAL_MS = 80;
const EVENT_LOOP_PRESSURE_MS = 30;

export type StreamRenderMetrics = {
  eventLoopLagMs: number;
  intervalMs: number;
};

export function streamRenderInterval(
  textLength: number,
  eventLoopLagMs = 0,
): number {
  let interval = SHORT_STREAM_RENDER_INTERVAL_MS;
  if (textLength >= 16_000) {
    interval = LONG_STREAM_RENDER_INTERVAL_MS;
  } else if (textLength >= 4_000) {
    interval = MEDIUM_STREAM_RENDER_INTERVAL_MS;
  }

  if (eventLoopLagMs >= EVENT_LOOP_PRESSURE_MS) {
    interval = Math.max(interval, MEDIUM_STREAM_RENDER_INTERVAL_MS);
  }
  if (eventLoopLagMs >= EVENT_LOOP_PRESSURE_MS * 2) {
    interval = Math.max(interval, LONG_STREAM_RENDER_INTERVAL_MS);
  }

  return interval;
}

export function createEventLoopLagTracker(): {
  sample(): number;
  stop(): void;
} {
  let expected = performance.now() + 100;
  let lagMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    lagMs = Math.max(0, now - expected);
    expected = now + 100;
  }, 100);

  return {
    sample: () => lagMs,
    stop: () => clearInterval(timer),
  };
}
