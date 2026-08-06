import { afterEach, describe, expect, test } from "bun:test";
import type { AgentConfig, ConversationMessage, LoadedAgents } from "@g-agent/agent";
import {
  agentTasksPath,
  hydrateAgentTask,
  normalizePersistedTask,
  toPersistedTask,
  type PersistedAgentTask,
} from "./agent-tasks.js";
import type { BackgroundAgentTask } from "./state.js";

const originalHome = process.env.G_AGENT_HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.G_AGENT_HOME;
  } else {
    process.env.G_AGENT_HOME = originalHome;
  }
});

function makeAgent(name: string): AgentConfig {
  return {
    name,
    description: `agent ${name}`,
    systemPromptBody: null,
    systemPromptPath: null,
    memoryBody: null,
    memoryPath: null,
    skills: [],
    skillConflicts: [],
    builtinSkillsPath: `/agents/${name}/builtin-skills`,
    selfSkillsPath: null,
    sharedSkillsPath: null,
    gagentSkillsPath: null,
    skillWatchPaths: [],
    source: "builtin",
  };
}

function makeTask(overrides: Partial<BackgroundAgentTask> = {}): BackgroundAgentTask {
  return {
    slot: 1,
    agent: makeAgent("coder"),
    title: "Refactor the parser",
    status: "completed",
    createdAt: 1_000,
    completedAt: 2_000,
    unread: false,
    history: [{ role: "user", content: "do it" }] as ConversationMessage[],
    transcript: [
      {
        role: "user",
        content: "do it",
      },
      {
        role: "assistant",
        content: "done",
        thinking: "hmm",
        tools: [{ name: "read", args: "{}" }],
        durationMs: 500,
      },
    ],
    promptQueue: [],
    draining: false,
    ...overrides,
  };
}

function makeLoaded(agents: AgentConfig[]): LoadedAgents {
  return {
    agents: new Map(agents.map((agent) => [agent.name, agent])),
    list: agents,
    builtinPath: "",
    userPath: null,
    sharedSkillsPath: null,
    gagentSkillsPath: null,
    skillWatchPaths: [],
    skillConflicts: [],
    defaultName: "default",
    defaultSystemBody: "",
  };
}

describe("agent-tasks module", () => {
  test("serializes a task without in-flight state", () => {
    const task = makeTask();
    const persisted = toPersistedTask(task);
    expect(persisted.agent).toBe("coder");
    expect(persisted.slot).toBe(1);
    expect(persisted.status).toBe("completed");
    expect(persisted.history).toEqual(task.history);
    expect(persisted.transcript).toEqual(task.transcript);
    expect(persisted).not.toHaveProperty("promptQueue");
    expect(persisted).not.toHaveProperty("mcpManager");
    expect(persisted).not.toHaveProperty("activeTurn");
  });

  test("normalizes a persisted entry and resets busy statuses to idle", () => {
    const persisted = normalizePersistedTask({
      slot: 3,
      agent: "coder",
      title: "in-flight",
      status: "responding",
      activity: "Writing response",
      createdAt: 100,
      unread: false,
      history: [{ role: "user", content: "hi" }],
      transcript: [],
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe("idle");
    expect(persisted!.title).toBe("in-flight");
    expect(persisted!.history).toHaveLength(1);
    expect(persisted!.activity).toBe("Writing response");
  });

  test("rejects entries with invalid slot or agent", () => {
    expect(normalizePersistedTask({ slot: 0, agent: "x" })).toBeNull();
    expect(normalizePersistedTask({ slot: 1, agent: "" })).toBeNull();
    expect(normalizePersistedTask(null)).toBeNull();
    expect(normalizePersistedTask("nope")).toBeNull();
  });

  test("drops invalid history and transcript entries", () => {
    const persisted = normalizePersistedTask({
      slot: 1,
      agent: "coder",
      title: "",
      history: [
        { role: "user", content: "ok" },
        { role: "system", content: "bad" },
        { role: "assistant" },
      ],
      transcript: [
        { role: "user", content: "ok" },
        { role: "system", content: "bad" },
        "nope",
      ],
    });
    expect(persisted!.history).toHaveLength(1);
    expect(persisted!.history[0]!.content).toBe("ok");
    expect(persisted!.transcript).toHaveLength(1);
  });

  test("hydrates a task with a resolved agent config", () => {
    const persisted: PersistedAgentTask = {
      slot: 5,
      agent: "coder",
      title: "title",
      status: "idle",
      createdAt: 100,
      unread: true,
      history: [],
      transcript: [],
    };
    const task = hydrateAgentTask(persisted, makeAgent("coder"));
    expect(task.slot).toBe(5);
    expect(task.agent.name).toBe("coder");
    expect(task.status).toBe("idle");
    expect(task.unread).toBe(true);
    expect(task.promptQueue).toEqual([]);
    expect(task.draining).toBe(false);
    expect(task.mcpManager).toBeUndefined();
  });

  test("loads persisted entries and skips those whose agent no longer exists", async () => {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "g-agent-tasks-"));
    process.env.G_AGENT_HOME = dir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "agent-tasks.json"),
      JSON.stringify([
        { slot: 1, agent: "coder", title: "kept", status: "idle", createdAt: 1, unread: false, history: [], transcript: [] },
        { slot: 2, agent: "missing", title: "dropped", status: "idle", createdAt: 1, unread: false, history: [], transcript: [] },
      ]),
    );
    const { loadPersistedAgentTasks } = await import("./agent-tasks.js");
    const tasks = await loadPersistedAgentTasks(makeLoaded([makeAgent("coder")]));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.slot).toBe(1);
    expect(tasks[0]!.agent.name).toBe("coder");
  });

  test("resolves the persistence path from G_AGENT_HOME", () => {
    process.env.G_AGENT_HOME = "/tmp/g-agent-home";
    expect(agentTasksPath()).toBe("/tmp/g-agent-home/agent-tasks.json");
  });
});
