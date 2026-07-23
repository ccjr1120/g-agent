#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { initHighlighter } from "ink-stream-markdown";
import { getBannerLines, loadBanner } from "@g-agent/agent";
import { getServerUrl, loadConfig } from "@g-agent/config";
import { DEFAULT_SERVER_URL } from "@g-agent/shared";
import { App } from "./App.js";
import { ensureServerRunning, restartServer } from "./lib/serverBootstrap.js";
import { createScrollAwareStdin } from "./lib/terminalInput.js";

await loadConfig();

const args = process.argv.slice(2);
const serverUrl = (process.env.G_AGENT_SERVER_URL ?? getServerUrl()) || DEFAULT_SERVER_URL;

if (args[0] === "server" && args[1] === "restart") {
  try {
    await restartServer(serverUrl);
    console.log(`g-agent: server restarted at ${serverUrl}`);
    process.exit(0);
  } catch (error) {
    console.error(
      `g-agent: failed to restart server: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }
}

await initHighlighter();

await ensureServerRunning(serverUrl);
const loadedBanner = await loadBanner();
const banner = getBannerLines(loadedBanner);

const enterFullscreen = () => {
  // Alternate screen keeps the shell buffer untouched. Alternate scroll mode
  // turns wheel events into cursor keys without capturing mouse clicks, so the
  // terminal can still select text for copy.
  process.stdout.write("\x1b[?1049h\x1b[?1007h");
};

let fullscreen = false;
const leaveFullscreen = () => {
  if (!fullscreen) return;
  fullscreen = false;
  process.stdout.write("\x1b[?1007l\x1b[?1049l");
};

enterFullscreen();
fullscreen = true;
process.once("exit", leaveFullscreen);

const scrollAwareStdin = createScrollAwareStdin(process.stdin);

try {
  const instance = render(<App serverUrl={serverUrl} banner={banner} />, {
    stdin: scrollAwareStdin.stream,
  });
  await instance.waitUntilExit();
} finally {
  scrollAwareStdin.dispose();
  process.off("exit", leaveFullscreen);
  leaveFullscreen();
}
