import { DEFAULT_SERVER_PORT } from "@g-agent/shared";

export function getServerHost(): string {
  return process.env.G_AGENT_HOST?.trim() || "127.0.0.1";
}

export function getServerPort(): number {
  const port = Number(process.env.G_AGENT_PORT);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_SERVER_PORT;
}

export function getServerUrl(): string {
  return `ws://${getServerHost()}:${getServerPort()}`;
}
