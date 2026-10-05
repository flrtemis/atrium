# Atrium

**A 3D avatar you can talk to — that can see you back.**

Atrium is [gemma-avatar](https://github.com/flrtemis/gemma-avatar), complete and unchanged, with one
capability added: **eyes**. Your local Ollama model keeps doing everything it did before — listening,
thinking, speaking through a lip-synced 3D head — and now it can also look through your webcam while
you talk. Hold up three fingers and it tells you there are three. Step to the left and it knows you
stepped to the left.

> She could always see you. Now she can see you *see her*.

---

## The pipeline (inherited, untouched)

```
mic → silero-VAD → parakeet STT → Ollama (Gemma) → Qwen3-TTS → TalkingHead 3D avatar
                                        ↑
                               OpenAI Realtime WebSocket
```

That is gemma-avatar's stack exactly. Atrium adds a second, independent input that joins it at the
Ollama step:

```
webcam → motion tracking ─┐
       → MediaPipe landmarks (optional) ─┼→ one line of text → the same conversation
       → JPEG stills ────────────────────┘
```

Nothing about the voice pipeline changed. If you already run gemma-avatar, you already know how to
run this.

## How the eyes work

| Layer | What it gives you | Cost | Needs |
|---|---|---|---|
| **Motion tracking** | Someone is there; something moved; which way it went; is the room lit | ~1 ms/frame, pure JS | nothing, ever |
| **Landmark tracking** | Exact finger counts, hand position, posture, lean, raised arms, face position | ~30–400 ms/frame | `download_vision_assets.py` |
| **Camera frames** | Anything at all that a vision model can read — text you hold up, objects, colours, expressions | one LLM inference | a vision-capable Ollama model |

The three layers are independent and **each one degrades on its own**. No models installed? You still
get motion tracking and frames. No vision model? You still get exact finger counts from landmarks.
A laptop from 2014? The loop measures how long each pass actually takes and stretches its own interval
to match — you get a slower Atrium, never a broken one.

### Finger counting, specifically

The headline request, so here is exactly what happens when you hold up fingers:

1. MediaPipe's hand landmarker finds 21 points per hand (`hand_landmarker.task`).
2. A finger counts as **up** when its tip is farther from the wrist than its middle knuckle, and the
   thumb when its tip is farther from the pinky knuckle than its thumb joint is — distance tests, so
   they survive your hand tilting or rotating.
3. The number goes into the conversation as `your right hand is holding up three fingers`
   (index, middle, ring), and the model is asked to say it out loud.

No image round-trip is needed for that, so it is instant and it works on a text-only model. If the
landmark models are not installed, Atrium falls back to sending a still frame and letting the model
count from the picture.

---

## Run it

Same two commands as gemma-avatar:

```bash
cd atrium
OLLAMA_MODEL=gemma4:26b PATH="$HOME/.bun/bin:$PATH" ./run-all-local.sh
```

Then open **<http://localhost:3000>**.

Two extra things Atrium gives you:

```bash
# Optional: exact finger/body/face tracking (~40 MB, downloaded once)
python3 download_vision_assets.py

# Test the camera on its own, with no model running
# open http://localhost:3000/lab
```

### First conversation

1. Press **Start talking** — the browser asks for the microphone, and for the camera.
2. Allow the camera. The self-view appears bottom-left and the chip in the top-left turns
   **`EYES LIVE`**.
3. Hold up some fingers and say *"how many?"*. She answers.
4. Move to the left. She notices on her own and says so.
5. Ask *"what can you see?"* — she calls `look_at_camera` and gets a real still from the webcam.

The camera button in the controls turns the eyes off again at any time.

---

## Atrium's tools

These are declared to the model alongside gemma-avatar's three avatar-body tools.

| Tool | What it does |
|---|---|
| `look_at_camera` | Take a fresh look, with a real frame attached. She uses it whenever you refer to something she can see. |
| `count_my_fingers` | Count raised fingers precisely, from landmarks when available. |
| `describe_what_you_see` | Full observation: person, face, posture, hands, motion. |
| `start_watching_me` / `stop_watching_me` | She decides whether to keep watching on her own. |
| `set_mood`, `make_hand_gesture`, `make_facial_expression` | gemma-avatar's avatar-body tools, unchanged. |

---

## Settings

Everything under **Settings → Eyes**:

| Setting | Default | Notes |
|---|---|---|
| **Camera** | default | Any video input the browser can see. |
| **Watching** | Live | *Live* pushes changes into the conversation as they happen. *On demand* only looks when she is asked or when you speak. |
| **Pace** | Balanced | A floor for the perception loop. The loop still backs off on its own if your machine cannot keep up — this is a ceiling on how hard it tries. |
| **Speak up when she notices something** | on | The unprompted "nice, three fingers" moments. Off means she watches silently. |
| **Send real camera frames** | on | Needs a vision-capable model. Off leaves landmark tracking, which is cheaper and works everywhere. |
| **Mirror** | on | Mirrors the view so left means the same to both of you. Handedness follows automatically. |
| **Overlay** | on | Draws tracked landmarks, motion grid and finger counts on the self-view. |
| **Tracking detail** | all on | Switch off body or face tracking to save CPU; keep hands for finger counting. |
| **CDN fallback** | on | If the local landmark models are missing, try the public CDN instead. Turn off to stay strictly offline. |

---

## Camera Lab — `/lab`

A separate page that runs the whole vision pipeline with no avatar, no WebSocket and no model:

* pick your camera and see the frame rate you actually get
* watch the overlay track your hands and body
* read **the exact text Atrium hands the model**, live
* a big finger-count readout to check against your own hand
* 3×3 live motion bars

It is the fastest way to answer *"is my camera the problem, or is the model?"*

---

## Configuration

### Frontend (Bun)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `LOAD_BALANCER_URL` / `SESSION_PROXY_URL` | unset | gemma-avatar's session proxy, unchanged. Unset ⇒ direct mode. |

### Backend (speech-to-speech)

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `gemma4:31b` | The chat model. |
| `ATRIUM_MAX_IMAGE_EDGE` | `768` | Longest edge of a camera frame after server-side resize. `0` disables. |
| `ATRIUM_IMAGE_QUALITY` | `70` | JPEG re-encode quality. |
| `ATRIUM_MAX_IMAGES_PER_ITEM` | `4` | Frames kept from a single message. |
| `ATRIUM_STRIP_IMAGES` | `0` | `1` replaces frames with a text note, for text-only models. |
| `S2S_CHAT_SIZE` | `30` | History length. Live vision adds a trickle of one-line observations; raise this if you want her to remember more conversation, lower it if her context is tight. |

---

## Which model should I use?

| Model type | What you get |
|---|---|
| Text-only (e.g. `gemma4:26b`) | Everything except reading raw frames. **Finger counting works** — it comes from landmarks, not pixels. Set `ATRIUM_STRIP_IMAGES=1` to stop frames being sent. |
| Vision-capable (`gemma3`, `llava`, `qwen2.5vl`, `minicpm-v`) | All of the above, plus she can read the actual picture: what you are holding, what you are wearing, text on a page. |

Either way, install the landmark models. They are what makes the eyes fast and exact instead of a
full LLM inference per glance.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chip says `NO CAMERA` | The browser blocked camera access. Allow it for `localhost:3000` and press the camera button again. |
| Chip says `EYES LIVE · MOTION`, no finger counts | Landmark models missing. Run `python3 download_vision_assets.py` and reload. |
| She never mentions what she sees | Settings → Eyes → **Watching** is probably *On demand*, or **Speak up** is off. |
| She counts fingers wrong | Check `/lab`: if the overlay is not drawing on your hand, the lighting is too dark or your hand is too far away. If the overlay is correct but she is not, your model is ignoring the tool result — try `test-tools.sh`. |
| Everything is slow | Settings → Eyes → **Pace** → *Slowest*, switch off face and body tracking, and uncheck **Send real camera frames**. The loop will also back off by itself. |
| She describes the camera lines back at me | Her instructions are being overridden. Clear **Extra instructions** in Settings. |

---

## Layout

```
index.ts                     Bun server: static assets, /api/session proxy (gemma-avatar) + /lab, /api/vision-assets
index.html                   The app shell
index-lab.html               The Camera Lab
src/
  app.js                     Wiring: session, avatar, and the eyes
  avatar.js                  TalkingHead stage, lip-sync, moods, gestures  (gemma-avatar)
  style.css                  Design language + Atrium's camera UI
  s2s/                       Realtime WebSocket client                     (gemma-avatar)
  vendor/headaudio.min.mjs   Audio → visemes                               (gemma-avatar)
  vision/
    camera.js                CameraEye — one getUserMedia stream, JPEG snapshots
    motion.js                MotionTracker — frame differencing, zero dependencies
    landmarks.js             LandmarkEngine — MediaPipe hands/pose/face, optional
    describe.js              perception → the sentences the model reads
    eyes.js                  Eyes — the adaptive perception loop + the vision tools
    overlay.js               Draws tracked landmarks onto the self-view
  lab.js, lab.css            The Camera Lab
local_s2s_launcher.py        s2s launcher (gemma-avatar) + Atrium frame handling
download_vision_assets.py    Optional landmark models
tests/vision.test.js         Pure-logic tests for the vision stack
```

---

## Notes

* **Privacy.** The camera never leaves your machine. Frames are tracked in your browser; only short
  lines of text — and, if you enable it, still frames — cross the WebSocket to your own local Ollama
  server. There is no third-party call in the default configuration. The CDN fallback for landmark
  models is a checkbox you can turn off, and once `download_vision_assets.py` has run, nothing is
  fetched at all.
* **Why not just send frames?** Because a local 7B vision model takes seconds per image, and you want
  to know how many fingers *now*. Landmarks answer in milliseconds; frames are for the questions
  landmarks cannot answer.
* **On slow machines:** Atrium is designed to degrade, not to fail. Worst case she sees you at one
  frame a second and still sees you.
* Built on [gemma-avatar](https://github.com/flrtemis/gemma-avatar) by flrtemis, which is built on
  huggingface's [speech-to-speech](https://github.com/huggingface/speech-to-speech) and
  met4citizen's [TalkingHead](https://github.com/met4citizen/TalkingHead).
