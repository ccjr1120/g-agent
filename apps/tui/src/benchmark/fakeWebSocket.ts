import type { ServerMessage } from "@g-agent/shared";

export type ReplayEvent = {
  atMs: number;
  message: ServerMessage;
};

export type ReplayScript = {
  name: string;
  events: ReplayEvent[];
};

function delta(text: string, atMs: number): ReplayEvent {
  return { atMs, message: { type: "delta", text } };
}

export function createStartupScript(messageCount: number): ReplayScript {
  const events: ReplayEvent[] = [
    { atMs: 0, message: { type: "ready" } },
    { atMs: 0, message: { type: "agents", agents: [{ name: "default", description: "Default", active: true }], active: "default", model: "bench" } },
    { atMs: 0, message: { type: "skills", skills: [] } },
    { atMs: 0, message: { type: "mcp", servers: [] } },
  ];

  for (let index = 0; index < messageCount; index += 1) {
    const base = index * 40;
    events.push(
      { atMs: base + 1, message: { type: "start" } },
      delta(`Assistant reply ${index + 1}: ${"lorem ipsum ".repeat(8)}\n`, base + 2),
      { atMs: base + 3, message: { type: "done" } },
    );
  }

  return { name: `startup-${messageCount}`, events };
}

export function createStreamScript(tokenCount: number): ReplayScript {
  const chunkSize = 32;
  const events: ReplayEvent[] = [
    { atMs: 0, message: { type: "ready" } },
    { atMs: 0, message: { type: "start" } },
  ];

  let emitted = 0;
  let atMs = 1;
  while (emitted < tokenCount) {
    const chunk = "word ".repeat(Math.min(chunkSize, tokenCount - emitted));
    events.push(delta(chunk, atMs));
    emitted += chunkSize;
    atMs += 8;
  }

  events.push({ atMs, message: { type: "done" } });
  return { name: `stream-${tokenCount}`, events };
}

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(private readonly script: ReplayScript) {}

  send(_data: string): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  start(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    for (const event of this.script.events) {
      setTimeout(() => {
        if (this.readyState !== FakeWebSocket.OPEN) return;
        this.onmessage?.({ data: JSON.stringify(event.message) });
      }, event.atMs);
    }
  }
}

export async function replayScript(
  script: ReplayScript,
  onMessage: (message: ServerMessage) => void,
  options: { realtime?: boolean } = {},
): Promise<number> {
  const started = performance.now();
  const realtime = options.realtime ?? false;

  for (const event of script.events) {
    if (realtime && event.atMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, event.atMs));
    }
    onMessage(event.message);
  }

  return performance.now() - started;
}
