#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { initHighlighter } from "ink-stream-markdown";
import { getBannerLines, loadBanner } from "@g-agent/agent";
import { getServerUrl, loadConfig } from "@g-agent/config";
import { DEFAULT_SERVER_URL } from "@g-agent/shared";
import { App } from "./App.js";

await loadConfig();
await initHighlighter();

const serverUrl = process.env.G_AGENT_SERVER_URL ?? getServerUrl();
const loadedBanner = await loadBanner();
const banner = getBannerLines(loadedBanner);

render(<App serverUrl={serverUrl || DEFAULT_SERVER_URL} banner={banner} />);
