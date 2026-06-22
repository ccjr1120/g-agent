#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { getServerUrl, loadConfig } from "@g-agent/config";
import { DEFAULT_SERVER_URL } from "@g-agent/shared";
import { App } from "./App.js";

await loadConfig();
const serverUrl = process.env.G_AGENT_SERVER_URL ?? getServerUrl();

render(<App serverUrl={serverUrl || DEFAULT_SERVER_URL} />);
