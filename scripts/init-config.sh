#!/usr/bin/env bash
# Initialize the g-agent user config directory (~/.config/g-agent by default).
#
# - Ensures the config directory exists.
# - Ensures config.json exists; if not, copies it from config.example.json.
#   Existing config.json is never overwritten.
#
# The built-in `default` agent is shipped inside the package and loaded from
# there at runtime; it is not copied into the user directory. To customize an
# agent, create `agents/<name>/` under the config directory yourself.
#
# Idempotent: safe to re-run.
#
# Usage:
#   ./scripts/init-config.sh                 # use default paths
#   G_AGENT_HOME=/path ./scripts/init-config.sh
#   CONFIG_DIR=/path ./scripts/init-config.sh
#
# Environment:
#   CONFIG_DIR       Override the config directory (default ~/.config/g-agent)
#   G_AGENT_HOME     If CONFIG_DIR is unset, defaults to $G_AGENT_HOME
set -euo pipefail

CONFIG_DIR="${CONFIG_DIR:-${G_AGENT_HOME:-$HOME/.config/g-agent}/}"
CONFIG_DIR="${CONFIG_DIR%/}"

# Resolve the repo root (where this script lives, two levels up).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

EXAMPLE_CONFIG="$REPO_ROOT/config.example.json"

if [ ! -f "$EXAMPLE_CONFIG" ]; then
  echo "Error: config.example.json not found at $EXAMPLE_CONFIG" >&2
  echo "(Is the script being run from a g-agent checkout?)" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR"
mkdir -p "$HOME/.agent/skills"

# --- Ensure config.json exists ---
ensure_config() {
  local config="$CONFIG_DIR/config.json"

  if [ ! -f "$config" ]; then
    echo "==> Creating $config from config.example.json"
    cp "$EXAMPLE_CONFIG" "$config"
    return
  fi

  echo "==> $config already exists, leaving it untouched"
}

ensure_config

echo ""
echo "Done. Config directory: $CONFIG_DIR"
echo "  config.json       — edit providers/provider as needed"
echo "  ~/.agent/skills/  — global skills (shared across agents)"
echo "Run 'g-agent' to start."
