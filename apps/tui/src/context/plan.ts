import type { PlanDisplay } from "../model.js";

/**
 * Parse an `update_plan` tool args JSON payload into a PlanDisplay.
 * Mirrors the old `parse_plan` behavior; lenient on malformed input.
 */
export function parsePlan(raw: string): PlanDisplay | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const stepsRaw = (data as { steps?: unknown }).steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) return null;

  const steps = stepsRaw
    .map((item, index) => {
      if (typeof item !== "object" || item === null) return null;
      const { step, status } = item as { step?: unknown; status?: unknown };
      if (typeof step !== "string") return null;
      const state =
        status === "completed" ? "done" : status === "in_progress" ? "running" : "pending";
      return { description: step, state, order: index };
    })
    .filter((s): s is { description: string; state: "done" | "running" | "pending"; order: number } => s !== null);

  if (steps.length === 0) return null;

  const explanation =
    (data as { explanation?: unknown }).explanation !== undefined
      ? String((data as { explanation?: unknown }).explanation)
      : undefined;

  return {
    title: explanation ?? "Execution plan",
    steps: steps.map(({ description, state }) => ({ description, state })),
  };
}

/** Format an `update_plan` args payload into a one-line transcript summary. */
export function formatPlanMessage(raw: string): string {
  const plan = parsePlan(raw);
  if (!plan) return "Updated the execution plan";
  const done = plan.steps.filter((s) => s.state === "done").length;
  return `Updated the execution plan (${done}/${plan.steps.length} steps complete)`;
}