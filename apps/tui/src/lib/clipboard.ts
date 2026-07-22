import { spawn } from "node:child_process";

function copyViaOsc52(text: string): boolean {
  if (!process.stdout.isTTY) {
    return false;
  }
  const base64 = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`\x1b]52;c;${base64}\x07`);
  return true;
}

function copyViaCommand(text: string, command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.write(text);
    child.stdin.end();
  });
}

/** Copy plain text to the system clipboard when possible. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (process.platform === "darwin") {
    if (await copyViaCommand(trimmed, "pbcopy", [])) {
      return true;
    }
  } else if (process.platform === "linux") {
    if (await copyViaCommand(trimmed, "wl-copy", [])) {
      return true;
    }
    if (await copyViaCommand(trimmed, "xclip", ["-selection", "clipboard"])) {
      return true;
    }
    if (await copyViaCommand(trimmed, "xsel", ["--clipboard", "--input"])) {
      return true;
    }
  }

  return copyViaOsc52(trimmed);
}
