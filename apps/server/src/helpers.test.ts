import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { makeAskUserHandler } from "./helpers.js";
import type { WsData } from "./state.js";

function makeWs(): { ws: ServerWebSocket<WsData>; data: WsData; sent: unknown[] } {
  const sent: unknown[] = [];
  const data = {
    promptQueue: [],
    draining: false,
    cancelRequested: false,
    pendingAsks: new Map(),
  } as unknown as WsData;
  const ws = {
    data,
    send: (raw: string) => {
      sent.push(JSON.parse(raw));
    },
  } as unknown as ServerWebSocket<WsData>;
  return { ws, data, sent };
}

describe("makeAskUserHandler", () => {
  test("resolves when the matching reply is sent", async () => {
    const { ws, data, sent } = makeWs();
    const ask = makeAskUserHandler(ws);

    const reply = ask("Which DB?", ["postgres", "sqlite"]);
    expect(data.pendingAsks.size).toBe(1);
    const [id, pending] = data.pendingAsks.entries().next().value;
    expect(sent).toEqual([
      { type: "ask_user", id, question: "Which DB?", options: ["postgres", "sqlite"] },
    ]);

    // Mimic the message handler: remove the slot, then resolve the promise.
    data.pendingAsks.delete(id);
    pending.resolve("sqlite");
    await expect(reply).resolves.toBe("sqlite");
    expect(data.pendingAsks.size).toBe(0);
  });

  test("rejects when the connection drops", async () => {
    const { ws, data } = makeWs();
    const ask = makeAskUserHandler(ws);
    const reply = ask("Which DB?");
    const [, pending] = data.pendingAsks.entries().next().value;
    pending.reject(new Error("disconnected"));
    await expect(reply).rejects.toThrow("disconnected");
  });

  test("each question carries its own id and stays answerable", async () => {
    const { ws, data, sent } = makeWs();
    const ask = makeAskUserHandler(ws);

    const first = ask("First question?");
    const second = ask("Second question?");

    // Both questions are announced with distinct ids and neither is rejected.
    expect(sent).toHaveLength(2);
    expect(data.pendingAsks.size).toBe(2);
    const ids = [...data.pendingAsks.keys()];
    expect(new Set(ids).size).toBe(2);

    // Answer the second first, then the first: each resolves independently.
    const secondPending = data.pendingAsks.get(ids[1])!;
    data.pendingAsks.delete(ids[1]);
    secondPending.resolve("answer two");
    await expect(second).resolves.toBe("answer two");

    const firstPending = data.pendingAsks.get(ids[0])!;
    data.pendingAsks.delete(ids[0]);
    firstPending.resolve("answer one");
    await expect(first).resolves.toBe("answer one");
  });

  test("an unknown reply id is ignored", async () => {
    const { ws, data } = makeWs();
    const ask = makeAskUserHandler(ws);
    const reply = ask("Which DB?");
    expect(data.pendingAsks.size).toBe(1);
    expect(data.pendingAsks.has("unknown-id")).toBe(false);
    const [, pending] = data.pendingAsks.entries().next().value;
    pending.resolve("ok");
    await expect(reply).resolves.toBe("ok");
  });

  test("a whole ask_user round resolves once every question is answered", async () => {
    const { ws, data } = makeWs();
    const ask = makeAskUserHandler(ws);

    // The agent loop runs tool calls in a round concurrently (Promise.all), so
    // several questions can be pending at once and must all stay answerable —
    // the earlier ones must not be rejected as "superseded".
    const round = Promise.all([
      ask("First question?"),
      ask("Second question?", ["yes", "no"]),
      ask("Third question?"),
    ]);
    expect(data.pendingAsks.size).toBe(3);

    // Answer them out of order, like a user tabbing between questions.
    const ids = [...data.pendingAsks.keys()];
    const answers = ["third answer", "no", "first answer"];
    for (let i = 0; i < ids.length; i++) {
      const pending = data.pendingAsks.get(ids[i])!;
      data.pendingAsks.delete(ids[i]);
      pending.resolve(answers[i]);
    }

    await expect(round).resolves.toEqual(["third answer", "no", "first answer"]);
    expect(data.pendingAsks.size).toBe(0);
  });
});
