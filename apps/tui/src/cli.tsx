#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { initHighlighter } from "ink-stream-markdown";
import { getBannerLines, loadBanner } from "@g-agent/agent";
import { getServerUrl, loadConfig } from "@g-agent/config";
import { DEFAULT_SERVER_URL } from "@g-agent/shared";
import { App } from "./App.js";
import { ensureServerRunning, restartServer } from "./lib/serverBootstrap.js";

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

render(<App serverUrl={serverUrl} banner={banner} />);
