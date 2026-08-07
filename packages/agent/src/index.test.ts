import { afterEach, describe, expect, test } from "bun:test";
import { runAgent, type AgentStreamEvent, type ResolvedProvider } from "./index.js";

const originalFetch = globalThis.fetch;
const originalRetries = process.env.G_AGENT_MAX_RETRIES;
const originalToolRounds = process.env.G_AGENT_MAX_TOOL_ROUNDS;

const provider: ResolvedProvider = {
  name: "test",
  baseUrl: "https://example.test/v1",
  model: "test-model",
  modelName: "test-model",
  apiKey: "test-key",
};

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

const SSE_DONE = "data: [DONE]\n\n";

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRetries === undefined) {
    delete process.env.G_AGENT_MAX_RETRIES;
  } else {
    process.env.G_AGENT_MAX_RETRIES = originalRetries;
  }
  if (originalToolRounds === undefined) {
    delete process.env.G_AGENT_MAX_TOOL_ROUNDS;
  } else {
    process.env.G_AGENT_MAX_TOOL_ROUNDS = originalToolRounds;
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

  test("renders think-tagged content as reasoning instead of answer text", async () => {
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              content:
                "<think>The user greeted me. No tools are needed.</think>你好！有什么可以帮你？",
            },
          },
        ],
      });
    const events: AgentStreamEvent[] = [];

    await runAgent("你好", (event) => events.push(event), provider);

    expect(events).toEqual([
      {
        type: "thinking_delta",
        text: "The user greeted me. No tools are needed.",
      },
      { type: "delta", text: "你好！有什么可以帮你？" },
      { type: "done" },
    ]);
  });

  test("combines reasoning_content with think tags", async () => {
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            message: {
              reasoning_content: "First thought",
              content: "<think>Second thought</think>Answer",
            },
          },
        ],
      });
    const events: AgentStreamEvent[] = [];

    await runAgent("hi", (event) => events.push(event), provider);

    expect(events[0]).toEqual({
      type: "thinking_delta",
      text: "First thought\n\nSecond thought",
    });
    expect(events[1]).toEqual({ type: "delta", text: "Answer" });
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

  test("reserves the last round for an answer instead of failing", async () => {
    process.env.G_AGENT_MAX_TOOL_ROUNDS = "2";
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requestBodies.length === 1) {
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ path: "package.json" }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        choices: [{ message: { content: "answer from collected evidence" } }],
      });
    };
    const events: AgentStreamEvent[] = [];

    await runAgent("inspect", (event) => events.push(event), provider);

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toHaveProperty("tools");
    expect(requestBodies[1]).not.toHaveProperty("tools");
    expect(events.at(-2)).toEqual({
      type: "delta",
      text: "answer from collected evidence",
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  test("does not end with plain text while a plan has unfinished steps", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const round = requestBodies.length;
      if (round === 1) {
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call-plan",
                type: "function",
                function: {
                  name: "update_plan",
                  arguments: JSON.stringify({
                    steps: [
                      { step: "Inspect", status: "completed" },
                      { step: "Build", status: "in_progress" },
                      { step: "Verify", status: "pending" },
                    ],
                  }),
                },
              }],
            },
          }],
        });
      }
      if (round === 2) {
        // The model tries to end mid-plan by asking the user in plain text.
        return Response.json({
          choices: [{ message: { content: "Should I continue building now?" } }],
        });
      }
      if (round === 3) {
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call-read",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ path: "src/main.rs" }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        choices: [{ message: { content: "Feature is built." } }],
      });
    };
    const events: AgentStreamEvent[] = [];

    await runAgent("build the feature", (event) => events.push(event), provider);

    // Round 2 (the "Should I continue?" prose) must NOT be the terminal reply:
    // the loop must have pushed a system nudge and continued to a tool round.
    expect(requestBodies.length).toBeGreaterThanOrEqual(3);
    expect(events).not.toContainEqual({
      type: "delta",
      text: "Should I continue building now?",
    });
    expect(events).toContainEqual({
      type: "tool_call",
      name: "read",
      args: '{"path":"src/main.rs"}',
    });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  test("nudges a freshly created plan to clarify before executing", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const round = requestBodies.length;
      if (round === 1) {
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call-plan",
                type: "function",
                function: {
                  name: "update_plan",
                  arguments: JSON.stringify({
                    steps: [
                      { step: "Plan", status: "in_progress" },
                      { step: "Build", status: "pending" },
                    ],
                  }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        choices: [{ message: { content: "done" } }],
      });
    };
    const events: AgentStreamEvent[] = [];

    await runAgent("build the feature", (event) => events.push(event), provider);

    const secondRound = requestBodies[1]!;
    const systemMessages = (secondRound.messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === "system")
      .map((message) => String(message.content));
    expect(systemMessages.some((text) => text.includes("ask_user"))).toBe(true);
    expect(systemMessages.some((text) => text.includes("only the user can decide"))).toBe(true);
  });

  test("corrects an ask_user that fired only after the plan was committed", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const answered: string[] = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const round = requestBodies.length;
      if (round === 1) {
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call-plan",
                type: "function",
                function: {
                  name: "update_plan",
                  arguments: JSON.stringify({
                    steps: [
                      { step: "Plan", status: "in_progress" },
                      { step: "Build", status: "pending" },
                    ],
                  }),
                },
              }],
            },
          }],
        });
      }
      if (round === 2) {
        return Response.json({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call-ask",
                type: "function",
                function: {
                  name: "ask_user",
                  arguments: JSON.stringify({ question: "Which target?" }),
                },
              }],
            },
          }],
        });
      }
      return Response.json({
        choices: [{ message: { content: "continuing" } }],
      });
    };
    const events: AgentStreamEvent[] = [];
    const options = {
      askUser: async (question: string) => {
        answered.push(question);
        return "use fennel";
      },
    };

    await runAgent("build the feature", (event) => events.push(event), provider, "", [], options);

    expect(answered).toEqual(["Which target?"]);
    const thirdRound = requestBodies[2]!;
    const systemMessages = (thirdRound.messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === "system")
      .map((message) => String(message.content));
    expect(systemMessages.some((text) => text.includes("only after creating a plan"))).toBe(true);
    expect(systemMessages.some((text) => text.includes("use fennel"))).toBe(true);
  });

  test("converts a plain-text question into ask_user", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const answered: string[] = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const round = requestBodies.length;
      if (round === 1) {
        return Response.json({
          choices: [{ message: { content: "Which database should I use?" } }],
        });
      }
      if (round === 2) {
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-ask",
                    type: "function",
                    function: {
                      name: "ask_user",
                      arguments: JSON.stringify({
                        question: "Which database?",
                        hint: "postgres or sqlite",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({ choices: [{ message: { content: "done" } }] });
    };
    const events: AgentStreamEvent[] = [];
    const options = {
      askUser: async (question: string) => {
        answered.push(question);
        return "postgres";
      },
    };

    await runAgent("build a db", (event) => events.push(event), provider, "", [], options);

    expect(answered).toEqual(["Which database?\n(hint: postgres or sqlite)"]);
    const secondRound = requestBodies[1]!;
    const systemMessages = (secondRound.messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === "system")
      .map((message) => String(message.content));
    expect(systemMessages.some((text) => text.includes("ask_user"))).toBe(true);
    // The plain-text question must never be surfaced to the user.
    expect(
      events.some(
        (event) => event.type === "delta" && event.text.includes("Which database"),
      ),
    ).toBe(false);
  });

  test("does not nudge answers that are not questions", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ choices: [{ message: { content: "All done." } }] });
    };
    const events: AgentStreamEvent[] = [];

    await runAgent("hi", (event) => events.push(event), provider);
    expect(requestBodies.length).toBe(1);
    expect(
      events.some((event) => event.type === "delta" && event.text === "All done."),
    ).toBe(true);
  });

  test("converts a multi-line plain-text question into ask_user", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const answered: string[] = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const round = requestBodies.length;
      if (round === 1) {
        // A long multi-line reply that ends its final line with a question —
        // the sort of plain-text question that used to slip past the nudge
        // because single-line detection ignored newlines.
        return Response.json({
          choices: [
            {
              message: {
                content:
                  "这是个大改动，先确认方案。\n请回我：\n- 命名风格（1）\n- 原文件处理（2）\n你选哪种方案？",
              },
            },
          ],
        });
      }
      if (round === 2) {
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-ask",
                    type: "function",
                    function: {
                      name: "ask_user",
                      arguments: JSON.stringify({
                        question: "命名风格和原文件处理你选哪种？",
                        hint: "1 或 2",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({ choices: [{ message: { content: "done" } }] });
    };
    const events: AgentStreamEvent[] = [];
    const options = {
      askUser: async (question: string) => {
        answered.push(question);
        return "1";
      },
    };

    await runAgent("restructure", (event) => events.push(event), provider, "", [], options);

    expect(answered).toHaveLength(1);
    const second = requestBodies[1]!;
    const systemMessages = (second.messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === "system")
      .map((message) => String(message.content));
    expect(systemMessages.some((text) => text.includes("using the ask_user tool"))).toBe(true);
    expect(
      events.some((event) => event.type === "delta" && event.text.includes("请回我")),
    ).toBe(false);
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

  test("streams content incrementally from SSE chunks", async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo wor"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ld"}}]}\n\n',
        SSE_DONE,
      ]);
    const events: AgentStreamEvent[] = [];

    await runAgent("hi", (event) => events.push(event), provider);

    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo wor" },
      { type: "delta", text: "ld" },
      { type: "done" },
    ]);
  });

  test("streams reasoning_content as thinking deltas", async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"ing"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
        SSE_DONE,
      ]);
    const events: AgentStreamEvent[] = [];

    await runAgent("hi", (event) => events.push(event), provider);

    expect(events).toEqual([
      { type: "thinking_delta", text: "think" },
      { type: "thinking_delta", text: "ing" },
      { type: "delta", text: "answer" },
      { type: "done" },
    ]);
  });

  test("accumulates tool call arguments across SSE chunks", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"package.json\\"}"}}]}}]}\n\n',
          SSE_DONE,
        ]);
      }
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"done reading"}}]}\n\n',
        SSE_DONE,
      ]);
    };
    const events: AgentStreamEvent[] = [];

    await runAgent("read package.json", (event) => events.push(event), provider);

    expect(calls).toBe(2);
    expect(events).toContainEqual({
      type: "tool_call",
      name: "read",
      args: '{"path":"package.json"}',
    });
    expect(events.at(-2)).toEqual({ type: "delta", text: "done reading" });
  });

  test("splits think tags across chunk boundaries", async () => {
    globalThis.fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Pre<thi"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"nk>Secret</th"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ink>Final"}}]}\n\n',
        SSE_DONE,
      ]);
    const events: AgentStreamEvent[] = [];

    await runAgent("hi", (event) => events.push(event), provider);

    expect(events).toEqual([
      { type: "delta", text: "Pre" },
      { type: "thinking_delta", text: "Secret" },
      { type: "delta", text: "Final" },
      { type: "done" },
    ]);
  });
});
