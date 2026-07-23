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

require_rust() {
  export PATH="${HOME}/.cargo/bin:${PATH}"

  if ! command -v cargo >/dev/null 2>&1; then
    echo "==> Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
    export PATH="${HOME}/.cargo/bin:${PATH}"
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    echo "Error: Rust/cargo is required. Install from https://rustup.rs" >&2
    exit 1
  fi
}

remove_legacy_pnpm_cli() {
  if ! command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if pnpm list -g --depth 0 2>/dev/null | grep -q '@g-agent/tui'; then
    echo "==> Removing legacy pnpm g-agent CLI..."
    pnpm remove -g @g-agent/tui >/dev/null 2>&1 || true
  fi

  local pnpm_bin="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  rm -f "$pnpm_bin/g-agent"
}

install_from_dir() {
  local dir="$1"
  echo "==> Installing dependencies..."
  cd "$dir"
  CI=1 pnpm install

  echo "==> Building G-Agent..."
  pnpm run build

  remove_legacy_pnpm_cli

  echo "==> Installing g-agent CLI..."
  cargo install --path "$dir/apps/tui" --locked --force

  echo ""
  echo "Done! Run 'g-agent' to start."
  if command -v g-agent >/dev/null 2>&1; then
    if [ "$(command -v g-agent)" != "${HOME}/.cargo/bin/g-agent" ]; then
      echo "Warning: another 'g-agent' appears earlier on PATH than ~/.cargo/bin."
      echo "  Run: pnpm remove -g @g-agent/tui"
      echo "  Or ensure ~/.cargo/bin is before pnpm in PATH."
    fi
  else
    echo "If 'g-agent' is not found, add Cargo to PATH:"
    echo "  export PATH=\"\$HOME/.cargo/bin:\$PATH\""
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
require_rust

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
