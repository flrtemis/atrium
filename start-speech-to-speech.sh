#!/usr/bin/env bash
# start-speech-to-speech.sh — Launch local Hugging Face Speech-to-Speech server bridging Ollama to Realtime WS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Force offline mode for pre-warmed HF caches
export HF_HUB_OFFLINE="${HF_HUB_OFFLINE:-1}"
export TRANSFORMERS_OFFLINE="${TRANSFORMERS_OFFLINE:-1}"
export HF_DATASETS_OFFLINE="${HF_DATASETS_OFFLINE:-1}"

VENV_PATH="${VENV_PATH:-$HOME/venvs/gemma-avatar-s2s}"
OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
LOCAL_LLM_REQUEST_TIMEOUT_S="${LOCAL_LLM_REQUEST_TIMEOUT_S:-300}"
QWEN3_GGUF_DIR="${QWEN3_GGUF_DIR:-$SCRIPT_DIR/models/qwen3-tts-gguf}"
QWEN3_GGUF_TALKER_PATH="${QWEN3_GGUF_TALKER_PATH:-$QWEN3_GGUF_DIR/qwen-talker-1.7b-customvoice-BF16.gguf}"
QWEN3_GGUF_CODEC_PATH="${QWEN3_GGUF_CODEC_PATH:-$QWEN3_GGUF_DIR/qwen-tokenizer-12hz-BF16.gguf}"
QWEN3_TTS_BACKEND="${QWEN3_TTS_BACKEND:-torch}"
QWEN3_TTS_MODEL_NAME="${QWEN3_TTS_MODEL_NAME:-Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice}"
QWEN3_TTS_CACHE_ROOT="${QWEN3_TTS_CACHE_ROOT:-$HOME/.cache/huggingface/hub/models--Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice/snapshots}"

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

if [ -f "$VENV_PATH/bin/activate" ]; then
  echo "Activating virtualenv at $VENV_PATH..."
  source "$VENV_PATH/bin/activate"
else
  echo "Warning: Virtualenv at $VENV_PATH not found. Using system Python."
fi

MODEL_NAME="$(pick_model "${1:-}")"
OLLAMA_URL="${OLLAMA_URL:-http://${OLLAMA_HOST}/v1}"
export OLLAMA_MODEL="$MODEL_NAME"
export LOCAL_LLM_REQUEST_TIMEOUT_S

if [ -f "$QWEN3_GGUF_TALKER_PATH" ] && [ -f "$QWEN3_GGUF_CODEC_PATH" ]; then
  export QWEN3_GGUF_TALKER_PATH
  export QWEN3_GGUF_CODEC_PATH
  echo "Using local GGUF TTS assets from $QWEN3_GGUF_DIR"
elif [ "$QWEN3_TTS_BACKEND" = "ggml" ]; then
  echo "Local GGUF TTS assets not found; ggml backend will require either cached Hugging Face GGUF files or a one-time run of download_tts_assets.py."
fi

if [ "$QWEN3_TTS_BACKEND" = "torch" ] && [ -d "$QWEN3_TTS_CACHE_ROOT" ]; then
  QWEN3_TTS_LOCAL_SNAPSHOT="$(find "$QWEN3_TTS_CACHE_ROOT" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -n "$QWEN3_TTS_LOCAL_SNAPSHOT" ]; then
    QWEN3_TTS_MODEL_NAME="$QWEN3_TTS_LOCAL_SNAPSHOT"
    echo "Using cached local Qwen3-TTS snapshot: $QWEN3_TTS_MODEL_NAME"
  fi
fi

# ── Atrium: camera-frame handling ─────────────────────────────────────────
# The browser sends webcam frames into the conversation as images. These are
# resized server-side so a small local model can actually hold them.
export ATRIUM_MAX_IMAGE_EDGE="${ATRIUM_MAX_IMAGE_EDGE:-768}"
export ATRIUM_IMAGE_QUALITY="${ATRIUM_IMAGE_QUALITY:-70}"
export ATRIUM_MAX_IMAGES_PER_ITEM="${ATRIUM_MAX_IMAGES_PER_ITEM:-4}"
export ATRIUM_STRIP_IMAGES="${ATRIUM_STRIP_IMAGES:-0}"
# Live vision adds a steady trickle of one-line observations to the history.
# Raise this if you want her to remember more of the conversation; lower it if
# her context window is small.
S2S_CHAT_SIZE="${S2S_CHAT_SIZE:-30}"

echo "Starting speech-to-speech server on ws://127.0.0.1:8765/v1/realtime..."
echo "LLM Model: ${MODEL_NAME} | LLM Endpoint: ${OLLAMA_URL} | Timeout: ${LOCAL_LLM_REQUEST_TIMEOUT_S}s | TTS Backend: ${QWEN3_TTS_BACKEND}"
echo "Atrium vision: frames<=${ATRIUM_MAX_IMAGE_EDGE}px q${ATRIUM_IMAGE_QUALITY} max ${ATRIUM_MAX_IMAGES_PER_ITEM}/msg strip=${ATRIUM_STRIP_IMAGES} | chat_size=${S2S_CHAT_SIZE}"
if [ "${ATRIUM_STRIP_IMAGES}" = "0" ]; then
  echo "  Note: ${MODEL_NAME} must accept images for her to read camera frames."
  echo "  With a text-only model, either set ATRIUM_STRIP_IMAGES=1 or rely on"
  echo "  landmark tracking (finger counting) which needs no vision model."
fi

exec python ./local_s2s_launcher.py \
  --mode realtime \
  --thresh 0.6 \
  --stt parakeet-tdt \
  --llm_backend chat-completions \
  --tts qwen3 \
  --qwen3_tts_model_name "${QWEN3_TTS_MODEL_NAME}" \
  --qwen3_tts_speaker Sohee \
  --qwen3_tts_language auto \
  --qwen3_tts_backend "${QWEN3_TTS_BACKEND}" \
  --qwen3_tts_non_streaming_mode False \
  --model_name "${MODEL_NAME}" \
  --chat_size "${S2S_CHAT_SIZE}" \
  --responses_api_base_url "${OLLAMA_URL}" \
  --responses_api_api_key "ollama" \
  --responses_api_reasoning_effort none \
  --responses_api_stream \
  --enable_live_transcription
