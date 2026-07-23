import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { createScrollAwareStdin } from "./terminalInput.js";

describe("createScrollAwareStdin", () => {
  test("dispose removes the stdin data listener", () => {
    const stdin = new EventEmitter() as EventEmitter & NodeJS.ReadStream;
    Object.assign(stdin, {
      isTTY: true,
      isRaw: false,
      setRawMode: () => stdin,
      ref: () => stdin,
      unref: () => stdin,
      pause: () => stdin,
    });

    const { stream, dispose } = createScrollAwareStdin(stdin);
    expect(stdin.listenerCount("data")).toBe(1);
    expect(stream.listenerCount("data")).toBe(0);

    dispose();
    expect(stdin.listenerCount("data")).toBe(0);
  });
});
