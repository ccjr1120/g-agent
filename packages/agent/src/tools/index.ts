import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

async function runBash(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? "").trim();
  if (!command) {
    return "Error: command is required";
  }

  const cwd = args.cwd ? resolvePath(String(args.cwd)) : process.cwd();
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
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

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case "bash":
        return await runBash(args);
      case "read":
        return await runRead(args);
      case "write":
        return await runWrite(args);
      case "glob":
        return await runGlob(args);
      case "grep":
        return await runGrep(args);
      default:
        return `Error: unknown tool "${name}"`;
    }
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : "tool failed"}`;
  }
}
