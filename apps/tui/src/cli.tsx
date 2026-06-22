#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { getActiveProvider, getServerUrl, loadConfig, formatProviderRef } from "@g-agent/config";
import { DEFAULT_SERVER_URL } from "@g-agent/shared";
import { App } from "./App.js";

const { config, path: configPath } = await loadConfig();
const provider = getActiveProvider(config);
const serverUrl = process.env.G_AGENT_SERVER_URL ?? getServerUrl();

render(
  <App
    serverUrl={serverUrl || DEFAULT_SERVER_URL}
    providerName={provider ? formatProviderRef(provider) : null}
    configPath={configPath}
  />,
);
