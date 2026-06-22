#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${G_AGENT_REPO:-https://github.com/ccjr1120/g-agent.git}"
BRANCH="${G_AGENT_BRANCH:-main}"
INSTALL_DIR="${G_AGENT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/g-agent}"

require_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "==> Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
  fi

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"

  if ! command -v bun >/dev/null 2>&1; then
    echo "Error: Bun is required. Install from https://bun.sh" >&2
    exit 1
  fi
}

require_pnpm() {
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "==> Installing pnpm..."
    curl -fsSL https://get.pnpm.io/install.sh | sh -
  fi

  export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  case ":$PATH:" in
    *":$PNPM_HOME:"*) ;;
    *) export PATH="$PNPM_HOME:$PATH" ;;
  esac

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "Error: pnpm is required. Install from https://pnpm.io" >&2
    exit 1
  fi

  if ! pnpm bin -g >/dev/null 2>&1; then
    echo "==> Configuring pnpm global bin..."
    SHELL="${SHELL:-/bin/bash}" pnpm setup >/dev/null
    export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
    export PATH="$PNPM_HOME:$PATH"
  fi
}

install_from_dir() {
  local dir="$1"
  echo "==> Installing dependencies..."
  cd "$dir"
  CI=1 pnpm install

  echo "==> Building G-Agent..."
  pnpm run build

  echo "==> Linking g-agent globally..."
  ( cd "$dir/apps/tui" && pnpm link --global )

  echo ""
  echo "Done! Run 'g-agent' to start."
  if ! command -v g-agent >/dev/null 2>&1; then
    echo "If 'g-agent' is not found, add pnpm to PATH:"
    echo "  export PNPM_HOME=\"\$HOME/.local/share/pnpm\""
    echo "  export PATH=\"\$PNPM_HOME:\$PATH\""
  fi
}

resolve_repo_root() {
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -f "$script_dir/package.json" ] && [ -d "$script_dir/apps/tui" ]; then
      echo "$script_dir"
      return 0
    fi
  fi
  return 1
}

require_bun
require_pnpm

if repo_root="$(resolve_repo_root)"; then
  echo "==> Installing G-Agent from local checkout..."
  install_from_dir "$repo_root"
  exit 0
fi

echo "==> Installing G-Agent to $INSTALL_DIR ..."

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required for remote install." >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> Updating existing checkout..."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

install_from_dir "$INSTALL_DIR"
