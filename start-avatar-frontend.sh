#!/usr/bin/env bash
# start-avatar-frontend.sh — Serve 3D TalkingHead Gemma Avatar client
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PORT="${PORT:-3000}"

echo "Starting Gemma Avatar frontend on http://localhost:${PORT}..."
exec bun run dev
