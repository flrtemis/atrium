#!/usr/bin/env bash
# run-all-local.sh — Local Atrium master launcher
#
#   Ollama (LLM)  →  speech-to-speech realtime pipeline  →  Atrium frontend
#
# plus Atrium's addition: the browser-side camera vision loop. The tracking
# models it can use are optional and downloaded separately; without them the
# eyes still work on motion tracking and real camera frames.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================================"
echo " Starting Local Atrium Stack"
echo "============================================================"

export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-gemma4:31b}"
export LOCAL_LLM_REQUEST_TIMEOUT_S="${LOCAL_LLM_REQUEST_TIMEOUT_S:-300}"

# ── Atrium: camera vision ─────────────────────────────────────────────────
# Frames are resized server-side before they reach the model; these defaults
# are chosen for small local models on modest hardware. See README.md.
export ATRIUM_MAX_IMAGE_EDGE="${ATRIUM_MAX_IMAGE_EDGE:-768}"
export ATRIUM_IMAGE_QUALITY="${ATRIUM_IMAGE_QUALITY:-70}"
export ATRIUM_MAX_IMAGES_PER_ITEM="${ATRIUM_MAX_IMAGES_PER_ITEM:-4}"
# Set to 1 if your Ollama model cannot take images (e.g. a text-only Gemma):
# camera frames are replaced by a note, and Atrium's landmark tracking still
# answers "how many fingers am I holding up?" from numbers rather than pixels.
export ATRIUM_STRIP_IMAGES="${ATRIUM_STRIP_IMAGES:-0}"

# Make scripts executable
chmod +x start-ollama.sh start-speech-to-speech.sh start-avatar-frontend.sh test-tools.sh

# 0/4 Optional landmark models. They are what makes finger counting exact and
# instant; Atrium runs perfectly well without them.
ATRUM_VISION_AUTO_DOWNLOAD="${ATRUM_VISION_AUTO_DOWNLOAD:-1}"
if [ ! -f "public/vendor/mediapipe/models/hand_landmarker.task" ]; then
  if [ "$ATRUM_VISION_AUTO_DOWNLOAD" = "1" ]; then
    echo "0/4 Fetching optional landmark models (finger/body/face tracking)…"
    python3 download_vision_assets.py || echo "    (skipped — Atrium will use motion tracking)"
  else
    echo "0/4 Landmark models not installed (motion tracking only)."
    echo "    Install them later with: python3 download_vision_assets.py"
  fi
else
  echo "0/4 Landmark models already installed."
fi

echo "1/4 Starting Ollama LLM Service..."
./start-ollama.sh &
OLLAMA_PID=$!

echo "Waiting for Ollama to initialize..."
sleep 3

echo "2/4 Starting Speech-to-Speech Realtime Pipeline..."
./start-speech-to-speech.sh &
S2S_PID=$!

echo "Waiting for models to initialize..."
sleep 5

echo "3/4 Starting Atrium Frontend..."
echo "  Talk to her: http://localhost:${PORT:-3000}"
echo "  Test just the camera: http://localhost:${PORT:-3000}/lab"
./start-avatar-frontend.sh &
FRONTEND_PID=$!

trap "kill $OLLAMA_PID $S2S_PID $FRONTEND_PID 2>/dev/null || true" EXIT

# Stay in the foreground so the trap above actually runs on Ctrl-C.
wait
