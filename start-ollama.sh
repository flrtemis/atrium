#!/usr/bin/env bash
# start-ollama.sh — Start Ollama local server and verify Gemma 4 model
set -euo pipefail

export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"

pick_model() {
  if [ -n "${1:-}" ]; then
    printf '%s\n' "$1"
    return
  fi
  if [ -n "${OLLAMA_MODEL:-}" ]; then
    printf '%s\n' "$OLLAMA_MODEL"
    return
  fi
  if ollama list 2>/dev/null | grep -q '^gemma4:31b'; then
    printf '%s\n' 'gemma4:31b'
    return
  fi
  if ollama list 2>/dev/null | grep -q '^gemma4:26b'; then
    printf '%s\n' 'gemma4:26b'
    return
  fi
  if ollama list 2>/dev/null | grep -q '^gemma4:12b'; then
    printf '%s\n' 'gemma4:12b'
    return
  fi
  if ollama list 2>/dev/null | grep -q '^gemma4:latest'; then
    printf '%s\n' 'gemma4:latest'
    return
  fi
  printf '%s\n' 'gemma4:31b'
}

echo "Starting Ollama service on http://${OLLAMA_HOST}..."
if pgrep -x "ollama" > /dev/null; then
  echo "Ollama is already running."
else
  ollama serve &
  sleep 3
fi

MODEL="$(pick_model "${1:-}")"
export OLLAMA_MODEL="$MODEL"
echo "Checking model availability: ${MODEL}..."
if ! ollama list | grep -q "${MODEL}"; then
  echo "Model ${MODEL} not found locally. Pulling now..."
  ollama pull "${MODEL}"
fi

echo "Ollama is ready for local Gemma inference."
echo "Gemma 4 models (gemma4:26b, gemma4:31b) include vision out of the box!"
echo "Finger counting and motion tracking work on any model via landmark tracking."
