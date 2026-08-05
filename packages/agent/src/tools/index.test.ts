import { describe, expect, test } from "bun:test";
import { builtinTools, executeTool } from "./index.js";
import type { ScheduledTaskManager, ScheduledTaskEntry } from "../schedules/index.js";

function makeScheduleManager(): {
  manager: ScheduledTaskManager;
  tasks: ScheduledTaskEntry[];
} {
  const tasks: ScheduledTaskEntry[] = [];
  let next = 1;
  return {
    tasks,
    manager: {
      schedule({ label, prompt, intervalSeconds }) {
        const task: ScheduledTaskEntry = {
          id: `s${next++}`,
          label,
          prompt,
          intervalSeconds,
          nextRunAt: Date.now() + intervalSeconds * 1000,
          running: false,
          lastStatus: "scheduled",
          unread: false,
        };
        tasks.push(task);
        return task;
      },
      unschedule(id) {
        const index = tasks.findIndex((task) => task.id === id);
        if (index === -1) return { ok: false, error: `Unknown task "${id}"` };
        tasks.splice(index, 1);
        return { ok: true };
      },
      list() {
        return tasks.map((task) => ({ ...task }));
      },
    },
  };
}

describe("scheduled task tools", () => {
  test("schedule_task registers a recurring task", async () => {
    const { manager, tasks } = makeScheduleManager();
    const output = await executeTool(
      "schedule_task",
      { prompt: "fetch requirements", intervalSeconds: 600, label: "需求列表" },
      manager,
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.intervalSeconds).toBe(600);
    expect(output).toContain("10m");
    expect(output).toContain(`id=${tasks[0]?.id}`);
  });

  test("schedule_task rejects too-frequent intervals", async () => {
    const { manager } = makeScheduleManager();
    const output = await executeTool(
      "schedule_task",
      { prompt: "fetch", intervalSeconds: 10 },
      manager,
    );
    expect(output).toContain("Error");
  });

  test("unschedule_task removes a task", async () => {
    const { manager, tasks } = makeScheduleManager();
    await executeTool(
      "schedule_task",
      { prompt: "fetch", intervalSeconds: 600 },
      manager,
    );
    const id = tasks[0]!.id;

    const output = await executeTool("unschedule_task", { id }, manager);
    expect(output).toBe(`Scheduled task ${id} cancelled`);
    expect(tasks).toHaveLength(0);
  });

  test("list_scheduled_tasks summarizes tasks", async () => {
    const { manager } = makeScheduleManager();
    await executeTool(
      "schedule_task",
      { prompt: "fetch", intervalSeconds: 600, label: "需求列表" },
      manager,
    );
    const output = await executeTool("list_scheduled_tasks", {}, manager);
    expect(output).toContain("需求列表");
    expect(output).toContain("next in");
  });

  test("schedule tools report when the manager is unavailable", async () => {
    const output = await executeTool("schedule_task", {
      prompt: "fetch",
      intervalSeconds: 600,
    });
    expect(output).toContain("scheduled task support is not available");
  });

  test("schedule tools are advertised as built-in tools", () => {
    const names = builtinTools.map((tool) => tool.name);
    expect(names).toContain("schedule_task");
    expect(names).toContain("unschedule_task");
    expect(names).toContain("list_scheduled_tasks");
  });
});

describe("bash tool agent context", () => {
  test("sets G_AGENT_AGENT for the subprocess when an agent name is given", async () => {
    const output = await executeTool(
      "bash",
      { command: "printf '%s' \"$G_AGENT_AGENT\"" },
      undefined,
      "obsidian-agent",
    );
    expect(output).toBe("obsidian-agent");
  });

  test("does not set G_AGENT_AGENT when no agent name is given", async () => {
    const output = await executeTool(
      "bash",
      { command: "printf '[%s]' \"${G_AGENT_AGENT:-}\"" },
    );
    expect(output).toBe("[]");
  });

  test("inherits an existing G_AGENT_AGENT from the parent process", async () => {
    const previous = process.env.G_AGENT_AGENT;
    process.env.G_AGENT_AGENT = "legacy-agent";
    try {
      const output = await executeTool(
        "bash",
        { command: "printf '%s' \"$G_AGENT_AGENT\"" },
        undefined,
        "obsidian-agent",
      );
      expect(output).toBe("obsidian-agent");
    } finally {
      if (previous === undefined) {
        delete process.env.G_AGENT_AGENT;
      } else {
        process.env.G_AGENT_AGENT = previous;
      }
    }
  });
});
