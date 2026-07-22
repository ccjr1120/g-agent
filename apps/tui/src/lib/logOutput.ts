import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_INLINE_LOG_TOOL_OUTPUT_CHARS = 32_000;

export type StoredToolResult = {
  inline: string;
  externalPath?: string;
};

export async function storeToolResultOutput(
  name: string,
  output: string,
  startedAt: number,
): Promise<StoredToolResult> {
  if (output.length <= MAX_INLINE_LOG_TOOL_OUTPUT_CHARS) {
    return { inline: output };
  }

  const overflow = output.length - MAX_INLINE_LOG_TOOL_OUTPUT_CHARS;
  const logDir = join(homedir(), ".config", "g-agent", "logs", "tool-results");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const path = join(logDir, `${stamp}-${name}-${crypto.randomUUID().slice(0, 8)}.txt`);
  await writeFile(path, output, "utf8");

  return {
    inline: `${output.slice(0, MAX_INLINE_LOG_TOOL_OUTPUT_CHARS)}\n\n… [truncated ${overflow} chars; full output saved to ${path}]`,
    externalPath: path,
  };
}
