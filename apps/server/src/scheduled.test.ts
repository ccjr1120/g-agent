import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_RUN_HISTORY,
  normalizePersistedTask,
  recordRun,
  SCHEDULE_AUTH_REQUIRED_MARKER,
  scheduledTaskInfo,
  scheduledTasksPath,
  stripScheduleMarker,
  type ScheduledTask,
} from "./scheduled.js";

const originalHome = process.env.G_AGENT_HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.G_AGENT_HOME;
  } else {
    process.env.G_AGENT_HOME = originalHome;
  }
});

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "st01",
    label: "需求列表",
    prompt: "fetch requirements",
    intervalSeconds: 600,
    nextRunAt: Date.now() + 600_000,
    running: false,
    lastStatus: "scheduled",
    unread: false,
    authRequired: false,
    runs: [],
    ...overrides,
  };
}

describe("scheduled module", () => {
  test("normalizes a persisted task and shifts overdue next runs", () => {
    const now = 1_000_000;
    const task = normalizePersistedTask(
      {
        id: "st01",
        label: "需求列表",
        prompt: "fetch requirements",
        intervalSeconds: 600,
        nextRunAt: 500, // long overdue
        lastStatus: "ok",
        lastSummary: "no changes",
        unread: false,
      },
      now,
    );
    expect(task).not.toBeNull();
    expect(task!.intervalSeconds).toBe(600);
    expect(task!.nextRunAt).toBe(now + 600 * 1000);
    expect(task!.runs).toEqual([]);
  });

  test("rejects persisted entries with invalid intervals", () => {
    expect(
      normalizePersistedTask(
        { id: "bad", prompt: "x", intervalSeconds: 5 },
        Date.now(),
      ),
    ).toBeNull();
    expect(normalizePersistedTask(null, Date.now())).toBeNull();
  });

  test("strips update/no-update/auth markers from output", () => {
    expect(stripScheduleMarker("[UPDATE] found two new items")).toBe("found two new items");
    expect(stripScheduleMarker("[NO_UPDATE] nothing changed")).toBe("nothing changed");
    expect(
      stripScheduleMarker(`${SCHEDULE_AUTH_REQUIRED_MARKER} meegle 登录已过期`),
    ).toBe("meegle 登录已过期");
    expect(stripScheduleMarker("plain reply")).toBe("plain reply");
  });

  test("includes authRequired in the protocol info when set", () => {
    expect(scheduledTaskInfo(makeTask()).authRequired).toBeUndefined();
    expect(scheduledTaskInfo(makeTask({ authRequired: true })).authRequired).toBe(true);
  });

  test("keeps only the most recent runs", () => {
    const task = makeTask();
    for (let i = 0; i < MAX_RUN_HISTORY + 5; i++) {
      task.lastRunAt = Date.now() + i;
      task.lastStatus = "ok";
      task.lastSummary = `run ${i}`;
      recordRun(task);
    }
    expect(task.runs.length).toBe(MAX_RUN_HISTORY);
    expect(task.runs[task.runs.length - 1]?.summary).toBe(`run ${MAX_RUN_HISTORY + 4}`);
  });

  test("resolves the persistence path from G_AGENT_HOME", () => {
    process.env.G_AGENT_HOME = "/tmp/g-agent-home";
    expect(scheduledTasksPath()).toBe("/tmp/g-agent-home/scheduled-tasks.json");
  });
});
