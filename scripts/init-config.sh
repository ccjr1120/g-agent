#!/usr/bin/env bash
# Initialize the g-agent user config directory (~/.config/g-agent by default).
#
# - Copies the built-in `default` agent (skills + system prompt) from the
#   repo into the user's agents/ directory so it is editable on disk.
# - Adds the `agent` field to config.json (default: "default"), preserving
#   existing providers/provider and any existing agent value.
# - Migrates a legacy global `builtin-skills/memory/memory.md` into the
#   default agent and removes the now-unused global builtin-skills/prompts/
#   skills directories.
#
# Idempotent: safe to re-run. Existing user files are never overwritten.
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

BUILTIN_AGENTS_SRC="$REPO_ROOT/packages/agent/src/agents/builtin"

if [ ! -d "$BUILTIN_AGENTS_SRC" ]; then
  echo "Error: built-in agents not found at $BUILTIN_AGENTS_SRC" >&2
  echo "(Is the script being run from a g-agent checkout?)" >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR/agents"

# --- 1. Copy the built-in `default` agent into the user's agents/ dir ---
copy_default_agent() {
  local src="$BUILTIN_AGENTS_SRC/default"
  local dst="$CONFIG_DIR/agents/default"

  if [ -d "$dst" ]; then
    echo "==> agents/default already exists, leaving it untouched"
    return
  fi

  echo "==> Copying built-in default agent to $dst"
  mkdir -p "$dst"
  cp -R "$src/." "$dst/"
}

copy_default_agent

# --- 2. Migrate legacy global memory.md, then remove obsolete global dirs ---
migrate_legacy_dirs() {
  local legacy_memory="$CONFIG_DIR/builtin-skills/memory/memory.md"
  local dst_memory="$CONFIG_DIR/agents/default/builtin-skills/memory/memory.md"

  if [ -f "$legacy_memory" ]; then
    if [ -f "$dst_memory" ]; then
      echo "==> Migrated memory.md already present; keeping legacy copy in place"
    else
      echo "==> Migrating legacy memory.md into agents/default"
      mkdir -p "$(dirname "$dst_memory")"
      cp "$legacy_memory" "$dst_memory"
    fi
  fi

  local removed=0
  for sub in builtin-skills prompts skills; do
    if [ -d "$CONFIG_DIR/$sub" ]; then
      echo "==> Removing obsolete global $sub/ (now agent-scoped)"
      rm -rf "$CONFIG_DIR/$sub"
      removed=1
    fi
  done
  if [ "$removed" = "0" ]; then
    echo "==> No legacy global skill/prompt dirs to clean up"
  fi
}

migrate_legacy_dirs

# --- 3. Ensure config.json exists with the `agent` field ---
ensure_config() {
  local config="$CONFIG_DIR/config.json"

  if [ ! -f "$config" ]; then
    echo "==> Creating $config from config.example.json"
    cp "$REPO_ROOT/config.example.json" "$config"
    return
  fi

  # Add the agent field without clobbering anything else. We do a minimal
  # regex edit rather than require jq, so it works on stock macOS.
  if grep -Eq '^[[:space:]]*"agent"[[:space:]]*:' "$config"; then
    echo "==> config.json already has an agent field, leaving it untouched"
    return
  fi

  echo "==> Adding \"agent\": \"default\" to $config"
  # Insert right after the opening brace of the top-level object.
  python3 - "$config" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
data.setdefault("agent", "default")
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

ensure_config

echo ""
echo "Done. Config directory: $CONFIG_DIR"
echo "  agents/default/  — edit system.md / skills / builtin-skills to customize"
echo "  config.json      — set \"agent\" to pick the startup agent"
echo "Run 'g-agent' to start."
