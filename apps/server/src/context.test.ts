import { describe, expect, test } from "bun:test";
import { trimHistory } from "./context.js";
import type { ConversationMessage } from "@g-agent/agent";

const estimate = (text: string | null | undefined): number =>
  Math.ceil((text ?? "").length / 4);

function user(text: string): ConversationMessage {
  return { role: "user", content: text };
}
function assistant(text: string): ConversationMessage {
  return { role: "assistant", content: text };
}

describe("trimHistory", () => {
  test("drops old assistant replies before user messages", () => {
    const history = [
      user("task: summarize the codebase"),
      assistant("I will read the source."),
      user("ok"),
      assistant("Done."),
    ];
    const { history: result, dropped } = trimHistory(
      8, // tiny budget to force trimming
      "system",
      history,
      estimate,
    );
    expect(dropped).toBeGreaterThan(0);
    // The first user message (task) and the most recent message survive.
    expect(result[0]).toEqual(history[0]);
    expect(result[result.length - 1]).toEqual(history[history.length - 1]);
  });

  test("never drops below two messages", () => {
    const history = [user("task"), assistant("a very long reply " + "x".repeat(500))];
    const { history: result } = trimHistory(2, "system", history, estimate);
    expect(result.length).toBe(2);
  });

  test("returns the input unchanged when already under budget", () => {
    const history = [user("hi"), assistant("hello")];
    const { history: result, dropped } = trimHistory(
      1000,
      "system",
      history,
      estimate,
    );
    expect(dropped).toBe(0);
    expect(result).toEqual(history);
  });
});
