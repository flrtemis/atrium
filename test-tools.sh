#!/usr/bin/env bash
# test-tools.sh — Verify Ollama tool calling for Atrium
#
# Atrium gives the model two families of tools: the avatar body (moods,
# gestures, expressions) and the eyes (look at the camera, count fingers,
# describe what is visible). This checks that your model will actually emit
# tool calls for both — if it never does, the avatar never moves and the eyes
# never open, no matter what the browser is doing.
set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
OLLAMA_URL="${1:-http://${OLLAMA_HOST}/v1/chat/completions}"
MODEL="${2:-${OLLAMA_MODEL:-gemma4:31b}}"

echo "Testing function calling on model ${MODEL} via ${OLLAMA_URL}..."

HAND_GESTURE_TOOL='{
  "type": "function",
  "function": {
    "name": "make_hand_gesture",
    "description": "Make a hand gesture with the avatar.",
    "parameters": {
      "type": "object",
      "properties": {
        "gesture": {
          "type": "string",
          "enum": ["handup","index","ok","thumbup","thumbdown","side","shrug"]
        }
      },
      "required": ["gesture"]
    }
  }
}'

FINGER_TOOL='{
  "type": "function",
  "function": {
    "name": "count_my_fingers",
    "description": "Count how many fingers the user is holding up to the camera.",
    "parameters": {"type": "object", "properties": {}}
  }
}'

LOOK_TOOL='{
  "type": "function",
  "function": {
    "name": "look_at_camera",
    "description": "Look through the user’s webcam right now.",
    "parameters": {
      "type": "object",
      "properties": {"question": {"type": "string"}}
    }
  }
}'

ask() {
  local label="$1" prompt="$2" tools="$3"
  local body
  body="$(printf '{
    "model": "%s",
    "stream": false,
    "messages": [
      {"role": "system", "content": "Use the supplied tools when appropriate."},
      {"role": "user", "content": "%s"}
    ],
    "tools": %s
  }' "${MODEL}" "${prompt}" "${tools}")"

  local out
  out="$(curl -s "${OLLAMA_URL}" -H "Content-Type: application/json" -d "${body}")"
  if printf '%s' "$out" | grep -q "tool_calls"; then
    echo "SUCCESS: ${label} — the model reached for a tool."
  else
    echo "NO TOOL CALL: ${label} — check tool support for ${MODEL}."
  fi
}

echo
ask "avatar gestures" "Greet me enthusiastically and give me a thumbs up." "[${HAND_GESTURE_TOOL}]"
ask "finger counting" "How many fingers am I holding up right now?" "[${FINGER_TOOL}]"
ask "camera look" "What can you see in front of me?" "[${LOOK_TOOL}]"
echo
echo "If the finger/camera lines say NO TOOL CALL, the eyes will still work"
echo "when you ask out loud, but she will not look on her own initiative."
