#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${G_AGENT_PORT:-3847}"
HOST="${G_AGENT_HOST:-127.0.0.1}"
LOG_FILE="${TMPDIR:-/tmp}/g-agent-server.log"

pnpm --filter @g-agent/server dev >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting server (log: $LOG_FILE)..."

for _ in $(seq 1 50); do
  if curl -sf "http://${HOST}:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server failed to start:" >&2
    cat "$LOG_FILE" >&2
    exit 1
  fi
  sleep 0.1
done

if ! curl -sf "http://${HOST}:${PORT}/" >/dev/null 2>&1; then
  echo "Server did not become ready:" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

cargo run -p g-agent-tui
