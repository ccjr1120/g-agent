import { afterEach, describe, expect, test } from "bun:test";
import { runAgent, type AgentStreamEvent, type ResolvedProvider } from "./index.js";

const originalFetch = globalThis.fetch;
const originalRetries = process.env.G_AGENT_MAX_RETRIES;

const provider: ResolvedProvider = {
  name: "test",
  baseUrl: "https://example.test/v1",
  model: "test-model",
  modelName: "test-model",
  apiKey: "test-key",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRetries === undefined) {
    delete process.env.G_AGENT_MAX_RETRIES;
  } else {
    process.env.G_AGENT_MAX_RETRIES = originalRetries;
  }
});

describe("runAgent", () => {
  test("emits a complete response without artificial per-character delay", async () => {
    globalThis.fetch = async () =>
      Response.json({ choices: [{ message: { content: "hello" } }] });
    const events: AgentStreamEvent[] = [];

    await runAgent("hi", (event) => events.push(event), provider);

    expect(events).toEqual([
      { type: "delta", text: "hello" },
      { type: "done" },
    ]);
  });

  test("retries transient HTTP failures", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("busy", { status: 503 })
        : Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    const events: AgentStreamEvent[] = [];

    await runAgent("hi", (event) => events.push(event), provider);

    expect(attempts).toBe(2);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  test("reports cancellation without surfacing it as an error", async () => {
    const controller = new AbortController();
    globalThis.fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    const events: AgentStreamEvent[] = [];
    const running = runAgent(
      "hi",
      (event) => events.push(event),
      provider,
      "",
      [],
      { signal: controller.signal },
    );

    controller.abort();
    await running;

    expect(events).toEqual([{ type: "cancelled" }]);
  });
});
