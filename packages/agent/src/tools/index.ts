import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ScheduledTaskManager } from "../schedules/index.js";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const MAX_OUTPUT = 30_000;
const BASH_TIMEOUT_MS = 120_000;

export const builtinTools: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command and return combined stdout and stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: {
          type: "string",
          description: "Working directory (defaults to current process cwd)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read",
    description: "Read a text file and return its contents.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write text to a file. Creates or overwrites the file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. **/*.ts or src/**/*.tsx",
        },
        cwd: {
          type: "string",
          description: "Directory to search from (defaults to process cwd)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search for a regex pattern in a file or directory.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression pattern" },
        path: {
          type: "string",
          description: "File or directory to search (defaults to cwd)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "update_plan",
    description:
      "Create or update the execution plan for a multi-step task. Keep exactly one step in progress while work remains, and update the plan after meaningful progress.",
    parameters: {
      type: "object",
      properties: {
        explanation: {
          type: "string",
          description: "Optional short explanation of why the plan changed",
        },
        steps: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              step: {
                type: "string",
                description: "Concrete, outcome-oriented task step",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
          description: "The complete current plan, not only changed steps",
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user a blocking question and wait for their reply. Use to clarify requirements, constraints, or ambiguous choices before starting work or committing to a plan — a few targeted questions up front prevent derailing mid-task. Also use when execution depends on a decision only the user can make.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user, phrased so it can be answered briefly",
        },
        hint: {
          type: "string",
          description:
            "Optional guidance on expected answers, e.g. valid options or the default you will use if the user says 'up to you'",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "schedule_task",
    description:
      "Schedule a recurring background task that runs its prompt automatically every intervalSeconds and reports when something changes. Use for periodic checks such as 'fetch the requirements list every 10 minutes and tell me about updates'. It never disturbs the main conversation; results appear in the Scheduled Tasks panel.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What to do on every run, e.g. 'fetch the requirements list and summarize any changes'",
        },
        intervalSeconds: {
          type: "number",
          description: "How often to run, in seconds (e.g. 600 for 10 minutes). Min 30.",
        },
        label: {
          type: "string",
          description: "Short label shown in the Scheduled Tasks panel",
        },
      },
      required: ["prompt", "intervalSeconds"],
      additionalProperties: false,
    },
  },
  {
    name: "unschedule_task",
    description: "Cancel a recurring background task by its id.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Task id returned by schedule_task",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_scheduled_tasks",
    description: "List the currently scheduled recurring background tasks.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export function toOpenAITools(tools: ToolDefinition[]): OpenAITool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} chars]`;
}

function resolvePath(path: string, cwd?: string): string {
  const base = cwd ? resolvePath(cwd) : process.cwd();
  const expanded = path.startsWith("~")
    ? join(homedir(), path.slice(1).replace(/^\//, ""))
    : path;
  return resolve(base, expanded);
}

async function runBash(
  args: Record<string, unknown>,
  agentName?: string,
): Promise<string> {
  const command = String(args.command ?? "").trim();
  if (!command) {
    return "Error: command is required";
  }

  const cwd = args.cwd ? resolvePath(String(args.cwd)) : process.cwd();
  const env = { ...process.env };
  if (agentName?.trim()) {
    env.G_AGENT_AGENT = agentName.trim();
  }
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const timer = setTimeout(() => proc.kill(), BASH_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  if (parts.length === 0) {
    parts.push(`(exit ${exitCode})`);
  } else if (exitCode !== 0) {
    parts.push(`(exit ${exitCode})`);
  }

  return truncate(parts.join("\n").trimEnd());
}

async function runRead(args: Record<string, unknown>): Promise<string> {
  const path = resolvePath(String(args.path ?? ""));
  if (!existsSync(path)) {
    return `Error: file not found: ${path}`;
  }

  const content = await readFile(path, "utf8");
  return truncate(content);
}

async function runWrite(args: Record<string, unknown>): Promise<string> {
  const path = resolvePath(String(args.path ?? ""));
  const content = String(args.content ?? "");
  await writeFile(path, content, "utf8");
  return `Wrote ${content.length} bytes to ${path}`;
}

async function runGlob(args: Record<string, unknown>): Promise<string> {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) {
    return "Error: pattern is required";
  }

  const cwd = args.cwd ? resolvePath(String(args.cwd)) : process.cwd();
  const glob = new Bun.Glob(pattern);
  const matches: string[] = [];

  for await (const file of glob.scan({ cwd, dot: false })) {
    matches.push(file);
    if (matches.length >= 500) {
      matches.push("…[truncated at 500 matches]");
      break;
    }
  }

  if (matches.length === 0) {
    return "(no matches)";
  }

  return matches.join("\n");
}

async function runGrep(args: Record<string, unknown>): Promise<string> {
  const patternText = String(args.pattern ?? "").trim();
  if (!patternText) {
    return "Error: pattern is required";
  }

  let regex: RegExp;
  try {
    regex = new RegExp(patternText);
  } catch (error) {
    return `Error: invalid regex: ${error instanceof Error ? error.message : "unknown"}`;
  }

  const target = args.path
    ? resolvePath(String(args.path))
    : process.cwd();
  const hits: string[] = [];

  async function searchFile(filePath: string): Promise<void> {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]!)) {
        hits.push(`${filePath}:${i + 1}:${lines[i]}`);
        if (hits.length >= 200) {
          return;
        }
      }
      regex.lastIndex = 0;
    }
  }

  async function walk(dir: string): Promise<void> {
    if (hits.length >= 200) return;

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (hits.length >= 200) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        await searchFile(full);
      }
    }
  }

  const file = Bun.file(target);
  if (await file.exists()) {
    const stat = await file.stat();
    if (stat.isFile()) {
      await searchFile(target);
    } else if (stat.isDirectory()) {
      await walk(target);
    }
  } else {
    return `Error: path not found: ${target}`;
  }

  if (hits.length === 0) {
    return "(no matches)";
  }

  if (hits.length >= 200) {
    hits.push("…[truncated at 200 matches]");
  }

  return hits.join("\n");
}

function updatePlan(args: Record<string, unknown>): string {
  const rawSteps = args.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length < 2 || rawSteps.length > 8) {
    return "Error: steps must contain between 2 and 8 items";
  }

  const steps: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }> = [];
  for (const rawStep of rawSteps) {
    if (!rawStep || typeof rawStep !== "object") {
      return "Error: every plan item must be an object";
    }
    const item = rawStep as Record<string, unknown>;
    const step = String(item.step ?? "").trim();
    const status = String(item.status ?? "");
    if (!step) {
      return "Error: every plan item requires a non-empty step";
    }
    if (!["pending", "in_progress", "completed"].includes(status)) {
      return `Error: invalid plan status "${status}"`;
    }
    steps.push({
      step,
      status: status as "pending" | "in_progress" | "completed",
    });
  }

  const activeCount = steps.filter((step) => step.status === "in_progress").length;
  const hasRemaining = steps.some((step) => step.status !== "completed");
  if (activeCount > 1) {
    return "Error: at most one plan item may be in_progress";
  }
  if (hasRemaining && activeCount === 0) {
    return "Error: exactly one plan item must be in_progress while work remains";
  }

  const icons = {
    pending: "○",
    in_progress: "●",
    completed: "✓",
  } as const;
  const explanation = String(args.explanation ?? "").trim();
  return [
    ...(explanation ? [explanation, ""] : []),
    ...steps.map((item) => `${icons[item.status]} ${item.step}`),
  ].join("\n");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

function runScheduleTask(
  args: Record<string, unknown>,
  scheduleManager?: ScheduledTaskManager | null,
): string {
  if (!scheduleManager) {
    return "Error: scheduled task support is not available in this runtime";
  }
  const intervalSeconds = Number(args.intervalSeconds);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 30) {
    return "Error: intervalSeconds must be a number of at least 30";
  }
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt) {
    return "Error: prompt is required";
  }
  const label = String(args.label ?? "").trim() || "Scheduled task";
  const task = scheduleManager.schedule({
    label,
    prompt,
    intervalSeconds: Math.round(intervalSeconds),
  });
  return `Scheduled task "${task.label}" runs every ${formatDuration(
    task.intervalSeconds * 1000,
  )}. id=${task.id}`;
}

function runUnscheduleTask(
  args: Record<string, unknown>,
  scheduleManager?: ScheduledTaskManager | null,
): string {
  if (!scheduleManager) {
    return "Error: scheduled task support is not available in this runtime";
  }
  const id = String(args.id ?? "").trim();
  if (!id) {
    return "Error: id is required";
  }
  const result = scheduleManager.unschedule(id);
  if (!result.ok) {
    return `Error: ${result.error ?? "unknown task"}`;
  }
  return `Scheduled task ${id} cancelled`;
}

function runListScheduledTasks(
  _args: Record<string, unknown>,
  scheduleManager?: ScheduledTaskManager | null,
): string {
  if (!scheduleManager) {
    return "Error: scheduled task support is not available in this runtime";
  }
  const tasks = scheduleManager.list();
  if (tasks.length === 0) {
    return "No scheduled tasks";
  }
  return tasks
    .map((task) => {
      const state = task.running
        ? "running"
        : `next in ${formatDuration(Math.max(0, task.nextRunAt - Date.now()))}`;
      return `[${task.lastStatus}] ${task.label} · ${state} · id=${task.id}${
        task.unread ? " · update" : ""
      }`;
    })
    .join("\n");
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  scheduleManager?: ScheduledTaskManager | null,
  agentName?: string,
  askUser?: (question: string) => Promise<string>,
): Promise<string> {
  try {
    switch (name) {
      case "bash":
        return await runBash(args, agentName);
      case "read":
        return await runRead(args);
      case "write":
        return await runWrite(args);
      case "glob":
        return await runGlob(args);
      case "grep":
        return await runGrep(args);
      case "update_plan":
        return updatePlan(args);
      case "ask_user":
        return await runAskUser(args, askUser);
      case "schedule_task":
        return await runScheduleTask(args, scheduleManager);
      case "unschedule_task":
        return await runUnscheduleTask(args, scheduleManager);
      case "list_scheduled_tasks":
        return await runListScheduledTasks(args, scheduleManager);
      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "tool failed"}`;
  }
}

function runAskUser(
  args: Record<string, unknown>,
  askUser?: (question: string) => Promise<string>,
): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) {
    return Promise.resolve("Error: question is required");
  }
  if (!askUser) {
    return Promise.resolve(
      "Error: user input is not available in this runtime. State what you need and continue with the most reasonable assumption, noting the assumption clearly.",
    );
  }
  const hint = String(args.hint ?? "").trim();
  return askUser(hint ? `${question}\n(hint: ${hint})` : question);
}
