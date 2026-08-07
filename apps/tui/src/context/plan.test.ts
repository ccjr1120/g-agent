import { describe, expect, test } from "bun:test";
import { formatPlanMessage, parsePlan } from "./plan.js";

describe("parsePlan", () => {
  test("parses steps with completed/in_progress/pending states", () => {
    const plan = parsePlan(
      JSON.stringify({
        explanation: "Refactor the module",
        steps: [
          { step: "Read source", status: "completed" },
          { step: "Extract helpers", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("Refactor the module");
    expect(plan!.steps).toEqual([
      { description: "Read source", state: "done" },
      { description: "Extract helpers", state: "running" },
      { description: "Run tests", state: "pending" },
    ]);
  });

  test("defaults title when explanation is missing", () => {
    const plan = parsePlan(JSON.stringify({ steps: [{ step: "a", status: "completed" }] }));
    expect(plan!.title).toBe("Execution plan");
  });

  test("returns null on malformed JSON", () => {
    expect(parsePlan("not json")).toBeNull();
  });

  test("returns null on empty or missing steps", () => {
    expect(parsePlan(JSON.stringify({ steps: [] }))).toBeNull();
    expect(parsePlan(JSON.stringify({ explanation: "x" }))).toBeNull();
  });

  test("drops malformed step entries", () => {
    const plan = parsePlan(
      JSON.stringify({ steps: [{ step: 123, status: "completed" }, { step: "ok", status: "completed" }] }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.steps).toEqual([{ description: "ok", state: "done" }]);
  });
});

describe("formatPlanMessage", () => {
  test("reports completion count", () => {
    const message = formatPlanMessage(
      JSON.stringify({
        steps: [
          { step: "a", status: "completed" },
          { step: "b", status: "pending" },
        ],
      }),
    );
    expect(message).toContain("1/2");
  });

  test("falls back on unparseable payload", () => {
    expect(formatPlanMessage("garbage")).toBe("Updated the execution plan");
  });
});