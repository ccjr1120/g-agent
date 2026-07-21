#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { initHighlighter } from "ink-stream-markdown";
import { getBannerLines, loadBanner } from "@g-agent/agent";
import { getServerUrl, loadConfig } from "@g-agent/config";
import { DEFAULT_SERVER_URL } from "@g-agent/shared";
import { App } from "./App.js";
import { ensureServerRunning, restartServer } from "./lib/serverBootstrap.js";
import { createMouseFilteredStdin } from "./lib/mouseInput.js";

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
  // Alternate screen keeps the shell buffer untouched. SGR mouse mode gives
  // the app wheel events so scrolling is independent of terminal scrollback.
  process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
};

let fullscreen = false;
const leaveFullscreen = () => {
  if (!fullscreen) return;
  fullscreen = false;
  process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?1049l");
};

enterFullscreen();
fullscreen = true;
process.once("exit", leaveFullscreen);

try {
  const stdin = createMouseFilteredStdin(process.stdin);
  const instance = render(<App serverUrl={serverUrl} banner={banner} />, { stdin });
  await instance.waitUntilExit();
} finally {
  process.off("exit", leaveFullscreen);
  leaveFullscreen();
}
