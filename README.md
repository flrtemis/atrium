# Orbit — Local Agent Shell

A deliberately quiet, offline-first UI for a voice-led agent workspace. It connects only to an Ollama daemon on the same device through a same-origin local bridge; it does not require a cloud key.

## Run

1. Install and run [Ollama](https://ollama.com/) locally.
2. Make the requested model available locally:
   ```sh
   ollama pull gemma4:31b
   ```
3. Start Orbit:
   ```sh
   npm run dev
   ```
4. Open `http://localhost:4173`.

`OLLAMA_HOST` can point to another **private/local** Ollama address when needed. The browser never talks to it directly; `server.js` keeps the model bridge same-origin.

## What is implemented

- Full-body digital-human presence with pointer parallax, speaking state, and an explicit handoff point for a true local 3D avatar renderer (VRM/glTF/WebGPU).
- Local camera + microphone preview for presence sessions. Permission is requested only after the user clicks **Start local camera**; streams stay in the browser and are stopped on exit.
- Voice-input integration when the browser exposes the Web Speech API, with a graceful typed-input fallback.
- Real calls to `gemma4:31b` via `/api/chat`, connection/model detection, persistent local task history, and native local device speech for responses.
- An intentional approval-first action rail. The UI never silently runs a tool or sends data outside the device.

## Production renderer note

The included avatar is a full-body high-fidelity visual stand-in. A genuinely animated photoreal 3D avatar needs a locally packaged rigged asset plus a renderer/runtime (for example VRM + Three.js/WebGPU), facial blend-shape tracking, and a local speech/viseme pipeline. `public/app.js` exposes the presence state transitions at the integration seam rather than pretending that a flat image is a 3D model.
