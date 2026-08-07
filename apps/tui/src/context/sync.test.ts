import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import type { ClientMessage, ServerMessage } from "@g-agent/shared";
import { createSyncStore, type Sync } from "./sync.js";

class FakeClient {
  sent: ClientMessage[] = [];
  private handler: ((event: ServerMessage) => void) | null = null;
  onOpen: (() => void) | undefined;
  onClose: (() => void) | undefined;

  connect() {}
  close() {}
  send(message: ClientMessage) {
    this.sent.push(message);
  }
  on(handler: (event: ServerMessage) => void): () => void {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }
  emit(event: ServerMessage) {
    this.handler?.(event);
  }
}

function makeStore() {
  const client = new FakeClient();
  let store!: Sync;
  let dispose!: () => void;
  createRoot((d) => {
    dispose = d;
    store = createSyncStore("ws://test", [], client);
    store.connect();
  });
  return { client, store, dispose };
}

describe("submit queueing", () => {
  test("an idle submit is never queued", () => {
    const { client, store, dispose } = makeStore();
    store.submit("hello");
    expect(store.lines()).toHaveLength(1);
    expect(store.lines()[0].role).toBe("user");
    expect(store.lines()[0].queued).toBe(false);
    expect(store.queuedLines()).toHaveLength(0);
    expect(client.sent).toContainEqual({ type: "chat", message: "hello" });
    dispose();
  });

  test("a busy submit is queued and dequeued when its turn starts", () => {
    const { client, store, dispose } = makeStore();
    client.emit({ type: "start" });
    store.submit("second");
    expect(store.queuedLines()).toHaveLength(1);
    expect(store.queuedLines()[0].text).toBe("second");
    expect(store.lines()[0].queued).toBe(true);
    client.emit({ type: "done" });
    client.emit({ type: "start" });
    expect(store.queuedLines()).toHaveLength(0);
    expect(store.lines()[0].queued).toBe(false);
    dispose();
  });

  test("queued lines drain FIFO across consecutive starts", () => {
    const { client, store, dispose } = makeStore();
    client.emit({ type: "start" });
    store.submit("one");
    store.submit("two");
    expect(store.queuedLines()).toHaveLength(2);
    client.emit({ type: "done" });
    client.emit({ type: "start" });
    expect(store.queuedLines().map((l) => l.text)).toEqual(["two"]);
    expect(store.lines().filter((l) => l.queued).map((l) => l.text)).toEqual(["two"]);
    dispose();
  });

  test("cancel drops every queued line and unhides their transcript copies", () => {
    const { client, store, dispose } = makeStore();
    client.emit({ type: "start" });
    store.submit("one");
    store.submit("two");
    expect(store.queuedLines()).toHaveLength(2);
    store.cancel();
    expect(store.queuedLines()).toHaveLength(0);
    expect(store.lines().every((l) => !l.queued)).toBe(true);
    expect(client.sent).toContainEqual({ type: "cancel" });
    dispose();
  });
});

describe("ask_user integration", () => {
  test("the ask_user tool call alone does not create a pending ask", () => {
    const { client, store, dispose } = makeStore();
    client.emit({ type: "start" });
    client.emit({ type: "tool_call", name: "ask_user", args: '{"question":"which one?"}' });
    expect(store.asks()).toHaveLength(0);
    dispose();
  });

  test("the ask_user event creates exactly one pending ask with the real id", () => {
    const { client, store, dispose } = makeStore();
    client.emit({ type: "start" });
    client.emit({ type: "tool_call", name: "ask_user", args: '{"question":"which one?"}' });
    client.emit({ type: "ask_user", id: "real-id", question: "which one?" });
    expect(store.asks()).toHaveLength(1);
    expect(store.asks()[0].id).toBe("real-id");
    expect(store.asks()[0].question).toBe("which one?");
    const live = store.streaming();
    expect(live).not.toBeNull();
    expect(live!.segments.filter((s) => s.type === "ask")).toHaveLength(1);
    dispose();
  });

  test("the reply is sent with the real id and removes the pending ask", () => {
    const { client, store, dispose } = makeStore();
    client.emit({ type: "start" });
    client.emit({ type: "ask_user", id: "real-id", question: "pick one" });
    store.submitAskReply("b");
    expect(client.sent).toContainEqual({ type: "ask_user_reply", id: "real-id", reply: "b" });
    expect(store.asks()).toHaveLength(0);
    dispose();
  });

  test("skip sends a skip reply and removes the pending ask", () => {
    const { client, store, dispose } = makeStore();
    client.emit({ type: "start" });
    client.emit({ type: "ask_user", id: "real-id", question: "pick one" });
    store.skipAsk();
    expect(client.sent).toContainEqual({ type: "ask_user_reply", id: "real-id", reply: "skip" });
    expect(store.asks()).toHaveLength(0);
    dispose();
  });
});
