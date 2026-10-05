// @ts-nocheck
/**
 * Camera Lab — the eyes, on their own.
 *
 * Same modules the app uses (CameraEye → MotionTracker + LandmarkEngine →
 * describe), with no avatar, no WebSocket and no language model attached. Two
 * reasons it exists:
 *
 *   1. It is how you check your camera actually works and tune it — pick the
 *      right device, see the frame rate you really get, watch how tracking
 *      behaves in your lighting — before starting a whole AI stack.
 *   2. It prints the *exact* text Atrium would hand the model, so you can see
 *      for yourself what she is reading when she looks at you.
 */

import { CameraEye } from "./vision/camera.js";
import { LandmarkEngine } from "./vision/landmarks.js";
import { Eyes } from "./vision/eyes.js";
import { drawOverlay } from "./vision/overlay.js";
import { summarize, headline } from "./vision/describe.js";

/** @param {string} sel */
const $ = (sel) => /** @type {any} */ (document.querySelector(sel));

const video = $("#lab-video");
const overlay = $("#lab-overlay");
const empty = $("#lab-empty");
const deviceSel = $("#lab-device");
const rateSel = $("#lab-rate");
const mirrorBox = $("#lab-mirror");
const overlayBox = $("#lab-overlay");
const startBtn = $("#lab-start");
const statsEl = $("#lab-stats");
const textEl = $("#lab-text");
const assetsEl = $("#lab-assets");
const fingersEl = $("#readout-fingers");
const headlineEl = $("#readout-headline");
const motionEl = $("#readout-motion");

const camera = new CameraEye();
const landmarks = new LandmarkEngine();
const eyes = new Eyes({
  camera,
  landmarks,
  settings: { mode: "live", minIntervalMs: 250, maxIntervalMs: 2400 },
});

let running = false;
let lastTextAt = 0;

// Build the 3x3 motion bars once.
const bars = [];
for (let i = 0; i < 9; i++) {
  const b = document.createElement("i");
  motionEl.append(b);
  bars.push(b);
}

function settings() {
  return {
    mode: "live",
    minIntervalMs: Number(rateSel.value) || 250,
    maxIntervalMs: Math.max((Number(rateSel.value) || 250) * 4, 2000),
    mirror: mirrorBox.checked,
    frameWidth: 640,
  };
}

async function refreshDevices() {
  await camera.refreshDevices();
  const devices = camera.devices ?? [];
  deviceSel.textContent = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = devices.length ? "Default camera" : "No cameras found";
  deviceSel.append(auto);
  devices.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    deviceSel.append(o);
  });
}

async function reportAssets() {
  try {
    const res = await fetch("/api/vision-assets");
    const info = await res.json();
    if (info.installed) {
      const missing = Object.entries(info.models)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      assetsEl.innerHTML = `MediaPipe runtime installed. Models: hands ${
        info.models.hands ? "✓" : "✗"
      }, pose ${info.models.pose ? "✓" : "✗"}, face ${info.models.face ? "✓" : "✗"}.${
        missing.length ? ` Missing: ${missing.join(", ")} — run <code>python3 download_vision_assets.py</code>.` : ""
      }`;
    } else {
      assetsEl.innerHTML =
        `Landmark models are not installed, so tracking is <strong>motion only</strong> — ` +
        `finger counting will fall back to the language model reading a still frame. ` +
        `For precise tracking run <code>python3 download_vision_assets.py</code> and reload.`;
    }
  } catch {
    assetsEl.textContent = "Could not check for landmark models.";
  }
}

function applyMirror() {
  video.style.transform = mirrorBox.checked ? "scaleX(-1)" : "none";
}

async function start() {
  startBtn.disabled = true;
  startBtn.textContent = "Starting…";
  try {
    eyes.updateSettings({ ...settings(), deviceId: deviceSel.value });
    camera.mirror = mirrorBox.checked;
    await camera.start({ deviceId: deviceSel.value, width: 1280, height: 720, frameRate: 30 });
    camera.attach(video);
    applyMirror();
    running = true;
    empty.hidden = true;
    startBtn.textContent = "Stop camera";
    await landmarks.init({ allowCdn: true });
    eyes.updateSettings(settings());
    await eyes.start();
    await refreshDevices();
  } catch (err) {
    empty.hidden = false;
    empty.textContent = String(err?.message ?? err);
    startBtn.textContent = "Start camera";
  } finally {
    startBtn.disabled = false;
  }
}

function stop() {
  eyes.stop();
  running = false;
  empty.hidden = false;
  empty.textContent = "Camera off — press “Start camera”";
  startBtn.textContent = "Start camera";
  fingersEl.textContent = "—";
  headlineEl.textContent = "camera off";
  textEl.textContent = "—";
  statsEl.textContent = "idle";
  for (const b of bars) b.style.setProperty("--v", "0");
  const ctx = overlay.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
}

eyes.addEventListener("observation", (e) => {
  const { perception } = /** @type {CustomEvent} */ (e).detail;
  render(perception);
});

eyes.addEventListener("status", () => {
  if (running) {
    statsEl.textContent = `${eyes.statusText} · ${Math.round(eyes.intervalMs)} ms/frame · ${eyes.ticks} observations`;
  }
});

/** @param {import("./vision/describe.js").Perception} p */
function render(p) {
  // Overlay
  const w = video.clientWidth;
  const h = video.clientHeight;
  if (w > 0 && h > 0 && (overlay.width !== w || overlay.height !== h)) {
    overlay.width = w;
    overlay.height = h;
  }
  const ctx = /** @type {CanvasRenderingContext2D} */ (overlay.getContext("2d"));
  if (ctx) {
    drawOverlay(ctx, p, {
      width: w,
      height: h,
      show: {
        hands: overlayBox.checked,
        pose: overlayBox.checked,
        face: overlayBox.checked,
        motion: overlayBox.checked,
        labels: overlayBox.checked,
      },
    });
  }

  // Big finger readout — the one number people come here to check.
  const total = (p.hands ?? []).reduce((n, h) => n + h.fingers, 0);
  fingersEl.textContent = p.hands?.length ? String(total) : p.person ? "0" : "—";

  headlineEl.textContent = headline(p);

  // Motion bars
  const grid = p.motion?.grid ?? [];
  for (let i = 0; i < 9; i++) {
    bars[i].style.setProperty("--v", String(Math.min(1, (grid[i] ?? 0) * 4)));
  }

  // The exact text the model receives. Re-rendered at most 4x/second so it
  // stays readable instead of flickering.
  const now = performance.now();
  if (now - lastTextAt > 250) {
    lastTextAt = now;
    textEl.textContent = summarize(p);
  }

  statsEl.textContent = [
    `${camera.width}×${camera.height}`,
    `${Math.round(camera.fps)} fps`,
    `${Math.round(eyes.intervalMs)} ms/frame`,
    `${eyes.ticks} observations`,
    eyes.statusText,
  ].join(" · ");
}

startBtn.addEventListener("click", () => {
  if (running) stop();
  else void start();
});

deviceSel.addEventListener("change", async () => {
  if (!running) return;
  stop();
  await start();
});

rateSel.addEventListener("change", () => {
  eyes.updateSettings(settings());
});

mirrorBox.addEventListener("change", () => {
  camera.mirror = mirrorBox.checked;
  eyes.updateSettings({ mirror: mirrorBox.checked });
  applyMirror();
});

camera.addEventListener("error", (e) => {
  const msg = /** @type {CustomEvent} */ (e).detail?.error?.message ?? "camera error";
  empty.hidden = false;
  empty.textContent = msg;
  statsEl.textContent = msg;
});

void refreshDevices();
void reportAssets();

Object.assign(window, { lab: { camera, landmarks, eyes } });
