#!/usr/bin/env bash
# start-avatar-frontend.sh — Serve 3D TalkingHead Gemma Avatar client
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Add Bun to PATH if installed in user's home directory
if [ -d "$HOME/.bun/bin" ] && [[ ":$PATH:" != *":$HOME/.bun/bin:"* ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Check if bun is installed
if ! command -v bun &> /dev/null; then
  echo "Error: bun is not installed or not in PATH."
  echo "Install it with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# Ensure frontend dependencies are installed
if [ ! -d "node_modules/@met4citizen/talkinghead" ]; then
  echo "Installing frontend dependencies (bun install)..."
  bun install
fi

export PORT="${PORT:-3000}"

echo "Starting Gemma Avatar frontend on http://localhost:${PORT}..."
exec bun run dev

