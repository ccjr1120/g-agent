#!/usr/bin/env bun
import {
  autostartStatus,
  disableAutostart,
  enableAutostart,
  ensureServerRunning,
  restartServer,
  runServerForeground,
  serverStatus,
  stopServer,
  tailLogs,
} from "./server.js";
import { loadBannerLines, serverUrl } from "./config.js";
import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { App } from "./app.js";

const COMMANDS: Record<string, { run: () => Promise<string | string[] | void>; help: string }> = {
  "server start": {
    help: "start the background server if it is not already running",
    run: async () => {
      await ensureServerRunning(serverUrl());
      return [`g-agent: server running at ${serverUrl()}`];
    },
  },
  "server stop": {
    help: "stop the background server process",
    run: async () => {
      await stopServer(serverUrl());
      return ["g-agent: server stopped"];
    },
  },
  "server restart": {
    help: "restart the background server process",
    run: async () => {
      await restartServer(serverUrl());
      return [`g-agent: server restarted at ${serverUrl()}`];
    },
  },
  "server status": {
    help: "show whether the server is running and where",
    run: async () => serverStatus(serverUrl()),
  },
  "server logs": {
    help: "print the server log (--follow to follow)",
    run: async () => tailLogs(false),
  },
  "server logs --follow": {
    help: "follow the server log like tail -f",
    run: async () => tailLogs(true),
  },
  "server run": {
    help: "run the server in the foreground (used by launchd/debugging)",
    run: async () => {
      await runServerForeground();
    },
  },
  "autostart enable": {
    help: "install and load the launchd agent",
    run: async () => enableAutostart(),
  },
  "autostart disable": {
    help: "unload and remove the launchd agent",
    run: async () => disableAutostart(),
  },
  "autostart status": {
    help: "show whether the launchd agent is installed",
    run: async () => autostartStatus(),
  },
};

async function parseCli(argv: string[]): Promise<"tui" | boolean> {
  const args = argv.slice(2);
  if (args.length === 0) return "tui";
  if (args[0] === "server" || args[0] === "autostart") {
    const sub = args.join(" ");
    const command = COMMANDS[sub];
    if (!command) return printUsageAndExit();
    const output = await command.run();
    if (output) {
      const lines = Array.isArray(output) ? output : [output];
      for (const line of lines) console.log(line);
    }
    return false;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return printUsageAndExit();
  }
  return printUsageAndExit();
}

function printUsageAndExit(): never {
  console.log("g-agent — G-Agent terminal agent");
  console.log("");
  console.log("Usage: g-agent [command]");
  console.log("");
  console.log("Commands:");
  for (const [name, def] of Object.entries(COMMANDS)) console.log(`  g-agent ${name.padEnd(26)} ${(def as { help: string }).help}`);
  console.log("  g-agent                          launch the TUI");
  process.exit(0);
}

async function runTui() {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 60,
    autoFocus: false,
    useKittyKeyboard: {},
  });

  await ensureServerRunning(serverUrl());
  const banner = loadBannerLines();
  const url = serverUrl();

  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    renderer.destroy();
  };

  await render(() => <App serverUrl={url} banner={banner} onQuit={quit} />, renderer);
  await new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
  renderer.destroy();
}

export function main() {
  parseCli(process.argv)
    .then(async (mode) => {
      if (mode === "tui") await runTui();
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

if (import.meta.main) main();