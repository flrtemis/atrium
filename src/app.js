// @ts-nocheck
/**
 * App wiring: the avatar stage, the speech-to-speech session, and the eyes.
 *
 * A session is one tap away: tap the button → mic → same-origin `/api/session`
 * handshake → WebSocket to the granted compute → talk. The avatar carries all
 * conversational state (listening, thinking, speaking) with its body; the
 * caption under it is a quiet machine-voice echo of the same state.
 *
 * Atrium's addition sits on top of that unchanged loop: an `Eyes` instance
 * watches the webcam and feeds what it sees into the same conversation. The
 * policy for *when* to tell the model something lives here, because only this
 * file knows whether anybody is talking.
 */

/** @typedef {any} HTMLElement */
/** @typedef {any} HTMLButtonElement */
/** @typedef {any} HTMLInputElement */
/** @typedef {any} HTMLDialogElement */
/** @typedef {any} HTMLSelectElement */
/** @typedef {any} HTMLTextAreaElement */
/** @typedef {any} HTMLCanvasElement */
/** @typedef {any} AudioContext */

import { S2sWsRealtimeClient } from "./s2s/s2s-ws-client.js";
import { AvatarStage, AVATAR_MOODS, AVATAR_GESTURES } from "./avatar.js";
import { CameraEye } from "./vision/camera.js";
import { LandmarkEngine } from "./vision/landmarks.js";
import { Eyes, VISION_TOOL_DEFS } from "./vision/eyes.js";
import { drawOverlay } from "./vision/overlay.js";
import { headline } from "./vision/describe.js";

const VOICES = [
  "Aiden",
  "Ryan",
  "Dylan",
  "Eric",
  "Ono_Anna",
  "Serena",
  "Sohee",
  "Uncle_Fu",
  "Vivian",
];
const DEFAULT_VOICE = "Ono_Anna";

const AVATAR_INSTRUCTIONS = [
  "You are a friendly voice assistant with a visible, human-like 3D avatar: the user",
  "sees you as a person on their screen. This is a spoken conversation: keep replies",
  "short, natural and warm, never list-like.",
  "You can control your avatar body with tools: set_mood changes your overall emotional",
  "state, make_hand_gesture plays a hand gesture, make_facial_expression makes a quick",
  "facial expression from a single face emoji. Use them naturally and sparingly to",
  "express yourself: smile when greeting, shrug when unsure, thumbs up when agreeing.",
  "Never mention the tools or that you are controlling an avatar.",
].join(" ");

/**
 * Atrium's own paragraph. It tells the model how to read the perception lines
 * we inject, and — just as importantly — how *not* to talk about them.
 */
const VISION_INSTRUCTIONS = [
  "EYES: you can also see the user through their webcam.",
  'Messages that begin with "[camera" are your own live observations written by your',
  "vision system. They are NOT things the user typed or said — never answer them as if",
  "they were speech, never quote them back, and never thank the user for them. Treat",
  "them as your current picture of the room.",
  "When you need a proper look call look_at_camera. If they hold fingers up, call",
  "count_my_fingers and tell them the number. If they ask what you can see, call",
  "describe_what_you_see. Use start_watching_me and stop_watching_me to control",
  "whether you keep watching on your own.",
  "When you notice something change, react the way a person in the room would, in one",
  'short sentence — "nice, three fingers" — instead of reciting measurements. Never say',
  '"the camera shows" or "according to my vision system"; you are simply looking at',
  "them. If your camera is off, say so plainly and ask them to switch it on.",
].join(" ");

const DEFAULT_INSTRUCTIONS = `${AVATAR_INSTRUCTIONS}\n\n${VISION_INSTRUCTIONS}`;

const STORAGE_KEYS = {
  voice: "atrium.voice",
  instructions: "atrium.instructions",
  directUrl: "atrium.directUrl",
  subtitles: "atrium.subtitles",
  // ── Atrium: vision ──
  visionMode: "atrium.visionMode",
  visionRate: "atrium.visionRate",
  visionSpeak: "atrium.visionSpeak",
  visionImages: "atrium.visionImages",
  visionMirror: "atrium.visionMirror",
  visionOverlay: "atrium.visionOverlay",
  visionHands: "atrium.visionHands",
  visionPose: "atrium.visionPose",
  visionFace: "atrium.visionFace",
  visionCdn: "atrium.visionCdn",
  cameraDevice: "atrium.cameraDevice",
  selfViewVisible: "atrium.selfViewVisible",
};

/** Function tools declared to the backend: the model plays the avatar and uses its eyes. */
/** @type {import("./s2s/s2s-ws-client.js").ToolDef[]} */
const TOOL_DEFS = [
  {
    type: /** @type {"function"} */ ("function"),
    name: "set_mood",
    description: "Change your avatar's overall mood/emotional state.",
    parameters: {
      type: "object",
      properties: {
        mood: { type: "string", enum: AVATAR_MOODS, description: "Mood name." },
      },
      required: ["mood"],
    },
  },
  {
    type: /** @type {"function"} */ ("function"),
    name: "make_hand_gesture",
    description: "Make a hand gesture with your avatar.",
    parameters: {
      type: "object",
      properties: {
        gesture: { type: "string", enum: AVATAR_GESTURES, description: "Gesture name." },
      },
      required: ["gesture"],
    },
  },
  {
    type: /** @type {"function"} */ ("function"),
    name: "make_facial_expression",
    description: "Make a quick facial expression with your avatar, given as a single face emoji (e.g. 😊, 😮, 🤔).",
    parameters: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "A single face emoji." },
      },
      required: ["emoji"],
    },
  },
  ...VISION_TOOL_DEFS,
];

const VISION_TOOL_NAMES = new Set(VISION_TOOL_DEFS.map((t) => t.name));

// How often the model is refreshed even when nothing seems to change, so its
// mental picture never goes stale during a long silence.
const VISION_HEARTBEAT_MS = 15000;
// Floor between two "something changed" pushes, so a jittery webcam can't spam.
const VISION_PUSH_MIN_MS = 1200;
// Floor between two moments where the avatar speaks up unprompted.
const VISION_SPEAK_MIN_MS = 4000;

// ── DOM ──────────────────────────────────────────────────────────────────
/** @param {string} sel */
const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const stageNode = $("#stage");
const mainBtn = /** @type {HTMLButtonElement} */ ($("#main-btn"));
const mainBtnLabel = $("#main-btn-label");
const attachBtn = /** @type {HTMLButtonElement} */ ($("#attach-btn"));
const muteBtn = /** @type {HTMLButtonElement} */ ($("#mute-btn"));
const uploadInput = /** @type {HTMLInputElement} */ ($("#upload-input"));
const promptForm = /** @type {HTMLFormElement} */ ($("#prompt-form"));
const promptInput = /** @type {HTMLTextAreaElement} */ ($("#prompt-input"));
const promptSend = /** @type {HTMLButtonElement} */ ($("#prompt-send"));
const caption = $("#caption");
const subtitles = $("#subtitles");
const loading = $("#loading");
const settingsBtn = /** @type {HTMLButtonElement} */ ($("#settings-btn"));
const settingsDialog = /** @type {HTMLDialogElement} */ ($("#settings"));
const inputVoice = /** @type {HTMLSelectElement} */ ($("#voice"));
const inputInstructions = /** @type {HTMLTextAreaElement} */ ($("#instructions"));
const inputDirectUrl = /** @type {HTMLInputElement} */ ($("#direct-url"));
const inputSubtitles = /** @type {HTMLInputElement} */ ($("#subtitles-toggle"));
const directUrlRow = $("#direct-url-row");

// ── Atrium: vision DOM ───────────────────────────────────────────────────
const cameraBtn = /** @type {HTMLButtonElement} */ ($("#camera-btn"));
const selfView = $("#selfview");
const selfViewVideo = /** @type {HTMLVideoElement} */ ($("#selfview-video"));
const selfViewOverlay = /** @type {HTMLCanvasElement} */ ($("#selfview-overlay"));
const selfViewClose = /** @type {HTMLButtonElement} */ ($("#selfview-close"));
const selfViewStatus = $("#selfview-status");
const selfViewStats = $("#selfview-stats");
const selfViewEmpty = $("#selfview-empty");
const visionHud = $("#vision-hud");
const eyesChip = /** @type {HTMLButtonElement} */ ($("#eyes-chip"));
const eyesChipText = $("#eyes-chip-text");

const inputCameraDevice = /** @type {HTMLSelectElement} */ ($("#camera-device"));
const inputVisionMode = /** @type {HTMLSelectElement} */ ($("#vision-mode"));
const inputVisionRate = /** @type {HTMLSelectElement} */ ($("#vision-rate"));
const inputVisionSpeak = /** @type {HTMLInputElement} */ ($("#vision-speak"));
const inputVisionImages = /** @type {HTMLInputElement} */ ($("#vision-images"));
const inputVisionMirror = /** @type {HTMLInputElement} */ ($("#vision-mirror"));
const inputVisionOverlay = /** @type {HTMLInputElement} */ ($("#vision-overlay"));
const inputVisionHands = /** @type {HTMLInputElement} */ ($("#vision-hands"));
const inputVisionPose = /** @type {HTMLInputElement} */ ($("#vision-pose"));
const inputVisionFace = /** @type {HTMLInputElement} */ ($("#vision-face"));
const inputVisionCdn = /** @type {HTMLInputElement} */ ($("#vision-cdn"));
const visionAssetHint = $("#vision-asset-hint");

// Hierarchy panel (present in the markup, never wired up before Atrium).
const hierarchyBtn = /** @type {HTMLButtonElement} */ ($("#hierarchy-btn"));
const hierarchyPanel = $("#hierarchy-panel");
const hierarchyClose = /** @type {HTMLButtonElement} */ ($("#hierarchy-close"));
const hierarchyList = $("#hierarchy-list");

// ── State ────────────────────────────────────────────────────────────────
const stage = new AvatarStage(stageNode);
const camera = new CameraEye();
const landmarks = new LandmarkEngine();
/** @type {S2sWsRealtimeClient | null} */
let client = null;
let muted = false;
let subtitleTimer = 0;
/** @type {{ lb: boolean, allowDirect: boolean }} */
let config = { lb: false, allowDirect: true };

/** @type {Eyes} */
let eyes;

function readBool(key, fallback) {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === "1";
}

function loadSettings() {
  return {
    voice: localStorage.getItem(STORAGE_KEYS.voice) || DEFAULT_VOICE,
    instructions: localStorage.getItem(STORAGE_KEYS.instructions) || "",
    directUrl:
      localStorage.getItem(STORAGE_KEYS.directUrl) ||
      "ws://localhost:8765/v1/realtime",
    subtitles: readBool(STORAGE_KEYS.subtitles, true),
    // ── Atrium: vision ──
    visionMode:
      /** @type {"live" | "ondemand" | "off"} */ (
        localStorage.getItem(STORAGE_KEYS.visionMode) || "live"
      ),
    visionRate: Number(localStorage.getItem(STORAGE_KEYS.visionRate) || 250),
    visionSpeak: readBool(STORAGE_KEYS.visionSpeak, true),
    visionImages: readBool(STORAGE_KEYS.visionImages, true),
    visionMirror: readBool(STORAGE_KEYS.visionMirror, true),
    visionOverlay: readBool(STORAGE_KEYS.visionOverlay, true),
    visionHands: readBool(STORAGE_KEYS.visionHands, true),
    visionPose: readBool(STORAGE_KEYS.visionPose, true),
    visionFace: readBool(STORAGE_KEYS.visionFace, true),
    visionCdn: readBool(STORAGE_KEYS.visionCdn, true),
    cameraDevice: localStorage.getItem(STORAGE_KEYS.cameraDevice) || "",
    selfViewVisible: readBool(STORAGE_KEYS.selfViewVisible, true),
  };
}
let settings = loadSettings();

function saveSettings() {
  localStorage.setItem(STORAGE_KEYS.voice, settings.voice);
  localStorage.setItem(STORAGE_KEYS.instructions, settings.instructions);
  localStorage.setItem(STORAGE_KEYS.directUrl, settings.directUrl);
  localStorage.setItem(STORAGE_KEYS.subtitles, settings.subtitles ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.visionMode, settings.visionMode);
  localStorage.setItem(STORAGE_KEYS.visionRate, String(settings.visionRate));
  localStorage.setItem(STORAGE_KEYS.visionSpeak, settings.visionSpeak ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.visionImages, settings.visionImages ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.visionMirror, settings.visionMirror ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.visionOverlay, settings.visionOverlay ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.visionHands, settings.visionHands ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.visionPose, settings.visionPose ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.visionFace, settings.visionFace ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.visionCdn, settings.visionCdn ? "1" : "0");
  localStorage.setItem(STORAGE_KEYS.cameraDevice, settings.cameraDevice);
  localStorage.setItem(STORAGE_KEYS.selfViewVisible, settings.selfViewVisible ? "1" : "0");
}

/** Persona + whatever extra guidance the user typed in Settings. */
function effectiveInstructions() {
  const extra = settings.instructions.trim();
  return extra ? `${DEFAULT_INSTRUCTIONS}\n\nAdditional instructions from the user:\n${extra}` : DEFAULT_INSTRUCTIONS;
}

/** The vision settings, flattened into the shape `Eyes` understands. */
function eyesSettings() {
  return {
    mode: settings.visionMode,
    minIntervalMs: settings.visionRate,
    maxIntervalMs: Math.max(settings.visionRate * 4, 2000),
    frameWidth: 640,
    mirror: settings.visionMirror,
    sendImages: settings.visionImages,
    imageWidth: 640,
    imageQuality: 0.55,
    hands: settings.visionHands,
    pose: settings.visionPose,
    face: settings.visionFace,
    allowCdn: settings.visionCdn,
    deviceId: settings.cameraDevice,
  };
}

// ── Captions / subtitles ─────────────────────────────────────────────────
/** @param {string} text @param {""|"live"|"error"} [kind] */
function setCaption(text, kind = "") {
  caption.textContent = text;
  caption.className = kind;
}

/** @param {string} text */
function showSubtitles(text) {
  if (!settings.subtitles) return;
  clearTimeout(subtitleTimer);
  subtitles.textContent = text;
  subtitles.classList.add("visible");
}

function fadeSubtitles(delayMs = 2600) {
  clearTimeout(subtitleTimer);
  subtitleTimer = window.setTimeout(() => subtitles.classList.remove("visible"), delayMs);
}

/** @param {File} file */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const out = String(reader.result || "");
      const base64 = out.includes(",") ? out.slice(out.indexOf(",") + 1) : out;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

/** @param {File} file */
async function analyzeUpload(file) {
  if (!client || client.status === "closed" || client.status === "error") {
    setCaption("START TALKING FIRST, THEN ATTACH A FILE", "error");
    return;
  }
  const mime = file.type || "application/octet-stream";
  if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
    setCaption("ONLY IMAGE OR VIDEO FILES ARE SUPPORTED", "error");
    return;
  }

  attachBtn.disabled = true;

  try {
    const base64 = await readFileAsBase64(file);
    client.sendUserFile(base64, file.name, mime);
    client.requestResponse();
  } catch (err) {
    console.error("upload analysis failed", err);
    setCaption("UPLOAD FAILED, TRY ANOTHER FILE", "error");
  } finally {
    attachBtn.disabled = false;
  }
}

// ── Button ───────────────────────────────────────────────────────────────
/** @type {"start" | "join" | "stop" | "busy"} */
let mainAction = "start";

/** @param {"start" | "join" | "stop" | "busy"} action @param {string} label */
function setMainButton(action, label) {
  mainAction = action;
  mainBtnLabel.textContent = label;
  mainBtn.disabled = action === "busy";
  mainBtn.classList.toggle("live", action === "stop");
  muteBtn.hidden = action !== "stop";
}

// ── Status handling ──────────────────────────────────────────────────────
/** @type {Record<string, string>} */
const CAPTIONS = {
  idle: "TAP TO TALK",
  "creating-session": "REQUESTING A SLOT…",
  queued: "WAITING IN LINE…",
  "your-turn": "YOUR TURN, TAP TO JOIN",
  connecting: "CONNECTING…",
  connected: "GO AHEAD, I'M LISTENING",
  "user-speaking": "LISTENING",
  processing: "THINKING…",
  "ai-speaking": "SPEAKING",
  closed: "TAP TO TALK",
  error: "SOMETHING BROKE, TAP TO RETRY",
};

/** Statuses in which the conversation is live and worth telling things to. */
const LIVE_STATUSES = new Set(["connected", "user-speaking", "processing", "ai-speaking"]);

function sessionIsLive() {
  return Boolean(client) && LIVE_STATUSES.has(/** @type {any} */ (client).status);
}

/** @param {string} status */
function onStatus(status) {
  stage.setConversationState(status);
  setCaption(CAPTIONS[status] ?? status, status === "error" ? "error" : status === "idle" || status === "closed" ? "" : "live");

  switch (status) {
    case "idle":
    case "closed":
      setMainButton("start", "Start talking");
      break;
    case "error":
      setMainButton("start", "Retry");
      break;
    case "creating-session":
    case "connecting":
      setMainButton("busy", "Connecting…");
      break;
    case "queued":
      setMainButton("stop", "Leave queue");
      break;
    case "your-turn":
      setMainButton("join", "Join now");
      break;
    default:
      // connected / user-speaking / processing / ai-speaking
      setMainButton("stop", "End conversation");
      break;
  }

  if (status === "user-speaking") {
    subtitles.classList.remove("visible");
    // They are about to say something — make sure the model is looking at the
    // room as it is right now, not as it was thirty seconds ago.
    pushVisionContext("user-speaking");
  }
}

// ── Tool executor ────────────────────────────────────────────────────────
/** @param {string} name @param {string} argsJson @param {string} callId */
function runTool(name, argsJson, callId) {
  if (!client) return;
  /** @type {Record<string, unknown>} */
  let args = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    // keep {}
  }

  // Atrium: vision tools answer with a perception, and usually carry a still
  // frame into the response the model is about to speak.
  if (VISION_TOOL_NAMES.has(name)) {
    const res = eyes.runTool(name, args);
    client.sendToolOutput(callId, res.text);
    client.requestResponse(res.image ? { image: res.image } : {});
    if (res.mode) {
      settings.visionMode = /** @type {"live" | "ondemand" | "off"} */ (res.mode);
      saveSettings();
      syncVisionUi();
    }
    return;
  }

  const result = stage.runTool(name, args) ?? `Unknown tool: ${name}`;
  client.sendToolOutput(callId, result);
  // The turn continues after a tool call only when we ask for the follow-up.
  client.requestResponse();
}

// ── Atrium: the eyes ─────────────────────────────────────────────────────

let lastVisionPush = 0;
let lastVisionSpeak = 0;
/** Kept so the overlay canvas is only resized when its box actually changes. */
let lastOverlayBox = { w: 0, h: 0 };

/**
 * Build the Eyes orchestrator. Separate from `boot()` because it needs settings
 * and must exist before the first session starts.
 */
function createEyes() {
  eyes = new Eyes({ camera, landmarks, settings: eyesSettings() });

  eyes.addEventListener("observation", (e) => {
    const { perception, changes } = /** @type {CustomEvent} */ (e).detail;
    renderSelfView(perception);
    onObservation(perception, changes);
  });

  eyes.addEventListener("status", () => {
    syncVisionUi();
  });

  camera.addEventListener("started", () => {
    camera.attach(selfViewVideo);
    applyVideoMirror();
    syncVisionUi();
  });
  camera.addEventListener("stopped", () => {
    selfViewVideo.srcObject = null;
    syncVisionUi();
  });
  camera.addEventListener("error", (e) => {
    const msg = /** @type {CustomEvent} */ (e).detail?.error?.message ?? "camera error";
    console.warn("[vision]", msg);
    setCaption("CAMERA UNAVAILABLE — CHECK PERMISSIONS", "error");
    syncVisionUi(msg);
  });
  camera.addEventListener("devices", () => {
    renderCameraDevices();
  });
}

/** The preview is mirrored by CSS; the tracked frame is mirrored in the canvas. */
function applyVideoMirror() {
  selfViewVideo.style.transform = settings.visionMirror ? "scaleX(-1)" : "none";
}

/**
 * Draw the overlay and the HUD read-out under the self-view.
 * @param {import("./vision/describe.js").Perception} p
 */
function renderSelfView(p) {
  if (!p) return;

  // Size the overlay to its displayed box. getBoundingClientRect() forces
  // layout, so only do it when the element's size has actually changed.
  const w = selfViewVideo.clientWidth;
  const h = selfViewVideo.clientHeight;
  if (w > 0 && h > 0 && (lastOverlayBox.w !== w || lastOverlayBox.h !== h)) {
    lastOverlayBox = { w, h };
    selfViewOverlay.width = w;
    selfViewOverlay.height = h;
  }
  const ctx = /** @type {CanvasRenderingContext2D} */ (selfViewOverlay.getContext("2d"));
  if (ctx) {
    drawOverlay(ctx, p, {
      width: w,
      height: h,
      show: {
        hands: settings.visionOverlay,
        pose: settings.visionOverlay,
        face: settings.visionOverlay,
        motion: settings.visionOverlay,
        labels: settings.visionOverlay,
      },
    });
  }

  const hud = headline(p);
  selfViewStatus.textContent = hud;
  const fps = p.fps ? `${Math.round(p.fps)} fps` : "";
  selfViewStats.textContent = [fps, `${Math.round(eyes.intervalMs)} ms`].filter(Boolean).join(" · ");
  visionHud.textContent = `SEEING: ${hud.toUpperCase()}`;
}

/**
 * Decide whether a new observation is worth telling the model about.
 *
 * Two paths: a genuine change is news as soon as it is detected (rate-limited),
 * and a quiet heartbeat keeps the model's picture fresh when nothing moves at
 * all. Both only fire during a live conversation — nothing is queued up while
 * the session is closed.
 *
 * @param {import("./vision/describe.js").Perception} p
 * @param {{ significant: boolean, reasons: string[] }} changes
 */
function onObservation(p, changes) {
  if (eyes.mode !== "live") return;
  if (!sessionIsLive()) return;

  const now = Date.now();

  if (changes.significant) {
    if (now - lastVisionPush < VISION_PUSH_MIN_MS) return;
    lastVisionPush = now;
    const why = changes.reasons.join("; ");
    client?.sendUserText(`[camera · live] ${why}. ${headline(p)}.`);

    // Only speak up when the floor has passed and the line is genuinely idle.
    // "processing" is excluded on purpose: a response is already being written,
    // and asking for another would just queue behind it.
    const idle = /** @type {any} */ (client).status === "connected";
    if (settings.visionSpeak && idle && now - lastVisionSpeak > VISION_SPEAK_MIN_MS) {
      lastVisionSpeak = now;
      // Frames are the expensive part: send one only when the text alone is
      // not enough to be trusted (no landmark tracking) or fingers are involved.
      const wantsImage =
        settings.visionImages && (p.source === "motion" || p.hands.some((h) => h.fingers > 0));
      client?.sendUserText(`[camera · you just noticed] ${why}. React in one short sentence.`);
      client?.requestResponse(wantsImage ? { image: eyes.snapshot() } : {});
    }
    return;
  }

  if (now - lastVisionPush > VISION_HEARTBEAT_MS) {
    lastVisionPush = now;
    client?.sendUserText(`[camera · live] ${headline(p)}.`);
  }
}

/**
 * Put the current observation into the conversation without asking for a
 * reply. Called when the user starts talking and when they send a typed
 * message, so the model answers with the room as it is *now*.
 * @param {string} [_reason]
 */
function pushVisionContext(_reason) {
  if (!eyes || eyes.mode === "off" || !sessionIsLive()) return;
  const p = eyes.observe();
  if (!p) return;
  client?.sendUserText(`[camera · live] ${headline(p)}.`);
}

// ── Vision UI ────────────────────────────────────────────────────────────

/** @param {string} [errorOverride] */
function syncVisionUi(errorOverride) {
  const mode = settings.visionMode;
  const on = mode !== "off";

  cameraBtn.classList.toggle("is-off", !on);
  cameraBtn.classList.toggle("is-live", on && camera.ready);
  cameraBtn.setAttribute("aria-pressed", String(on));
  cameraBtn.setAttribute("aria-label", on ? "Turn my camera off" : "Turn on my camera");
  cameraBtn.title = on ? "Turn my camera off" : "Let her see you — turn on my camera";

  selfView.classList.toggle("hidden", !(on && settings.selfViewVisible));
  selfViewEmpty.hidden = camera.ready;
  selfView.classList.toggle("is-off", !camera.ready);

  eyesChip.hidden = false;
  eyesChip.classList.remove("is-off", "is-live", "is-idle");
  if (!on) {
    eyesChip.classList.add("is-off");
    eyesChipText.textContent = "EYES OFF";
  } else if (errorOverride || !camera.ready) {
    eyesChip.classList.add("is-off");
    eyesChipText.textContent = errorOverride ? "NO CAMERA" : "CAMERA OFF";
  } else if (mode === "live") {
    eyesChip.classList.add("is-live");
    eyesChipText.textContent = landmarks.available ? "EYES LIVE" : "EYES LIVE · MOTION";
  } else {
    eyesChip.classList.add("is-idle");
    eyesChipText.textContent = "EYES READY";
  }

  // The "seeing" line is worth showing whenever the camera is on, whether or
  // not the overlay on the self-view is enabled.
  visionHud.hidden = !(on && camera.ready);

  if (!camera.ready) {
    selfViewStatus.textContent = errorOverride ?? "camera off";
    selfViewStats.textContent = "";
  }

  const hint = visionAssetHint;
  if (hint) {
    if (landmarks.status === "ready") {
      hint.textContent = `Landmark models loaded: ${landmarks.detail.replace("tracking: ", "")}.`;
    } else if (landmarks.status === "loading") {
      hint.textContent = "Loading landmark models…";
    } else if (landmarks.status === "unavailable" && on) {
      hint.textContent =
        "Landmark models not found — running on motion tracking only. For finger counting and body tracking, run: python3 download_vision_assets.py";
    } else if (landmarks.status === "unavailable") {
      hint.textContent = "";
    } else {
      hint.textContent = "";
    }
  }
}

function renderCameraDevices() {
  if (!inputCameraDevice) return;
  const devices = camera.devices ?? [];
  const current = settings.cameraDevice;
  inputCameraDevice.textContent = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = devices.length ? "Default camera" : "No cameras found";
  inputCameraDevice.append(auto);
  devices.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    inputCameraDevice.append(o);
  });
  inputCameraDevice.value = devices.some((d) => d.deviceId === current) ? current : "";
}

/** Turn the camera on or off from the controls button. */
async function toggleCamera() {
  const turningOn = settings.visionMode === "off";
  if (turningOn) {
    settings.visionMode = "live";
    saveSettings();
    syncVisionUi();
    try {
      await eyes.start();
    } catch (err) {
      console.warn("[vision] camera start failed:", err);
      setCaption("COULD NOT OPEN THE CAMERA", "error");
    }
    // Instructions and tools don't change, but nudging the session keeps the
    // model's persona in step with the eyes coming online.
    client?.updateSession({ instructions: effectiveInstructions() });
  } else {
    settings.visionMode = "off";
    saveSettings();
    eyes.stop();
    syncVisionUi();
    visionHud.hidden = true;
  }
}

// ── Session lifecycle ────────────────────────────────────────────────────
async function startSession() {
  // Everything audible hangs off the avatar's AudioContext; resume it inside
  // the tap gesture or iOS keeps it suspended (silent).
  stage.resume();

  let micStream;
  if (new URLSearchParams(location.search).has("fakemic")) {
    // Dev/testing hook: a silent synthetic mic, so the session can be driven
    // end-to-end (handshake, WS, TTS playback, lip-sync) without a real mic
    // or a native permission prompt.
    const ctx = /** @type {AudioContext} */ (stage.audioCtx);
    micStream = ctx.createMediaStreamDestination().stream;
  } else {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setCaption("MIC BLOCKED, ALLOW IT IN THE BROWSER AND RETRY", "error");
      return;
    }
  }

  const audioCtx = stage.audioCtx;
  const voiceSink = stage.voiceSink;
  if (!audioCtx || !voiceSink) return;

  const c = new S2sWsRealtimeClient({
    ...(config.lb ? { sessionUrl: "api/session" } : { directUrl: settings.directUrl }),
    voice: settings.voice,
    instructions: effectiveInstructions(),
    micStream,
    audioContext: audioCtx,
    outputNode: voiceSink,
    workletBaseUrl: "/worklets/",
    tools: TOOL_DEFS,
  });
  client = c;

  c.addEventListener("status", (e) => onStatus(/** @type {CustomEvent} */ (e).detail.status));

  c.addEventListener("queue", (e) => {
    const { position } = /** @type {CustomEvent} */ (e).detail;
    setCaption(position > 0 ? `#${position} IN LINE…` : "ALMOST THERE…", "live");
  });

  c.addEventListener("transcript", (e) => {
    const { role, text } = /** @type {CustomEvent} */ (e).detail;
    if (role === "assistant" && text) showSubtitles(text);
  });

  c.addEventListener("response-finished", () => {
    fadeSubtitles();
  });

  c.addEventListener("toolcall", (e) => {
    const { name, arguments: args, callId } = /** @type {CustomEvent} */ (e).detail;
    runTool(name, args, callId);
  });

  c.addEventListener("server-error", (e) => {
    const error = /** @type {CustomEvent} */ (e).detail.error;
    console.warn("server error:", error);
  });

  c.addEventListener("error", () => {
    void endSession();
  });

  // Atrium: if the eyes are on, open them for this conversation too. The camera
  // permission prompt lands inside the same tap that started the session.
  if (settings.visionMode !== "off" && !eyes.running) {
    void eyes.start().catch((err) => {
      console.warn("[vision] could not start the camera with the session:", err);
      syncVisionUi();
    });
  }

  try {
    await c.connect();
  } catch (err) {
    const code = /** @type {Error & {code?: string}} */ (err)?.code;
    if (code === "limit") {
      setCaption("DAILY CONVERSATION LIMIT REACHED, TRY AGAIN TOMORROW", "error");
    } else if (code === "queue-full") {
      setCaption("EVERY SEAT IS TAKEN, TRY AGAIN SHORTLY", "error");
    } else if (code === "join-expired") {
      setCaption("YOUR SPOT EXPIRED, TAP TO TRY AGAIN", "error");
    } else if (code !== "aborted") {
      console.error(err);
      setCaption("COULD NOT CONNECT, TAP TO RETRY", "error");
    }
    await endSession(true);
    return;
  }
}

/** @param {boolean} [silent] Keep the current caption (e.g. an error). */
async function endSession(silent = false) {
  const c = client;
  client = null;
  if (c) {
    for (const track of c.options.micStream?.getTracks() ?? []) track.stop();
    await c.close().catch(() => {});
  }
  stage.setConversationState("idle");
  subtitles.classList.remove("visible");
  if (!silent) setCaption(CAPTIONS.idle);
  setMainButton("start", "Start talking");
}

// ── Text messaging ───────────────────────────────────────────────────────
async function sendTypedPrompt() {
  const text = promptInput.value.trim();
  if (!text) return;

  if (!client || client.status === "closed" || client.status === "error") {
    await startSession();
    if (!client || client.status === "closed" || client.status === "error") {
      return;
    }
  }

  promptInput.value = "";
  promptInput.style.height = "auto";
  // Atrium: the model reads the room at the moment the message is sent.
  pushVisionContext("typed");
  client.sendUserText(text);
  client.requestResponse();
}

// ── UI events ────────────────────────────────────────────────────────────
promptForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  void sendTypedPrompt();
});

promptInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendTypedPrompt();
  }
});

promptInput?.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
});

mainBtn.addEventListener("click", () => {
  if (mainAction === "start") void startSession();
  else if (mainAction === "join") {
    stage.resume(); // fresh gesture: re-arm audio before dialing
    client?.join();
  } else if (mainAction === "stop") void endSession();
});

muteBtn.addEventListener("click", () => {
  muted = !muted;
  client?.setMuted(muted);
  muteBtn.classList.toggle("active", muted);
  muteBtn.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
});

attachBtn.addEventListener("click", () => {
  uploadInput.click();
});

uploadInput.addEventListener("change", () => {
  const file = uploadInput.files?.[0];
  if (file) void analyzeUpload(file);
  uploadInput.value = "";
});

cameraBtn.addEventListener("click", () => {
  void toggleCamera();
});

selfViewClose.addEventListener("click", () => {
  settings.selfViewVisible = false;
  saveSettings();
  syncVisionUi();
});

eyesChip.addEventListener("click", () => {
  settings.selfViewVisible = true;
  saveSettings();
  syncVisionUi();
  if (settings.visionMode === "off") void toggleCamera();
});

// Avatar parts panel.
hierarchyBtn?.addEventListener("click", () => {
  const { groups } = stage.listParts();
  hierarchyList.textContent = "";
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "hierarchy-empty";
    empty.textContent = "The avatar has not loaded yet.";
    hierarchyList.append(empty);
  }
  for (const group of groups) {
    const h = document.createElement("h4");
    h.textContent = `${group.title} (${group.items.length})`;
    hierarchyList.append(h);
    const ul = document.createElement("ul");
    for (const item of group.items) {
      const li = document.createElement("li");
      li.textContent = item.name;
      li.title = item.kind;
      ul.append(li);
    }
    hierarchyList.append(ul);
  }
  hierarchyPanel.classList.remove("hidden");
});

hierarchyClose?.addEventListener("click", () => {
  hierarchyPanel.classList.add("hidden");
});

settingsBtn.addEventListener("click", () => {
  inputVoice.value = settings.voice;
  inputInstructions.value = settings.instructions;
  inputDirectUrl.value = settings.directUrl;
  inputSubtitles.checked = settings.subtitles;

  inputVisionMode.value = settings.visionMode;
  inputVisionRate.value = String(settings.visionRate);
  inputVisionSpeak.checked = settings.visionSpeak;
  inputVisionImages.checked = settings.visionImages;
  inputVisionMirror.checked = settings.visionMirror;
  inputVisionOverlay.checked = settings.visionOverlay;
  inputVisionHands.checked = settings.visionHands;
  inputVisionPose.checked = settings.visionPose;
  inputVisionFace.checked = settings.visionFace;
  inputVisionCdn.checked = settings.visionCdn;

  renderCameraDevices();
  syncVisionUi();
  settingsDialog.showModal();
});

settingsDialog.addEventListener("close", () => {
  const prevMode = settings.visionMode;
  const prevDevice = settings.cameraDevice;

  settings = {
    ...settings,
    voice: inputVoice.value || DEFAULT_VOICE,
    instructions: inputInstructions.value,
    directUrl: inputDirectUrl.value.trim(),
    subtitles: inputSubtitles.checked,
    visionMode: /** @type {"live" | "ondemand" | "off"} */ (inputVisionMode.value),
    visionRate: Number(inputVisionRate.value) || 250,
    visionSpeak: inputVisionSpeak.checked,
    visionImages: inputVisionImages.checked,
    visionMirror: inputVisionMirror.checked,
    visionOverlay: inputVisionOverlay.checked,
    visionHands: inputVisionHands.checked,
    visionPose: inputVisionPose.checked,
    visionFace: inputVisionFace.checked,
    visionCdn: inputVisionCdn.checked,
    cameraDevice: inputCameraDevice.value ?? "",
  };
  saveSettings();
  if (!settings.subtitles) subtitles.classList.remove("visible");

  // Voice/instructions apply live to an ongoing session.
  client?.updateSession({ voice: settings.voice, instructions: effectiveInstructions() });

  // Push the new vision configuration into the running loop.
  eyes.updateSettings(eyesSettings());
  applyVideoMirror();

  const deviceChanged = settings.cameraDevice !== prevDevice;
  const shouldRun = settings.visionMode !== "off";
  if (shouldRun && (prevMode === "off" || deviceChanged)) {
    void eyes.start().catch(() => syncVisionUi());
  } else if (!shouldRun) {
    eyes.stop();
  }
  syncVisionUi();
});

window.addEventListener("beforeunload", () => {
  client?.close();
});

// ── Boot ─────────────────────────────────────────────────────────────────
async function boot() {
  for (const v of VOICES) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v.replaceAll("_", " ");
    inputVoice.append(o);
  }

  try {
    const resp = await fetch("api/config");
    if (resp.ok) config = { ...config, ...(await resp.json()) };
  } catch {
    // defaults keep direct mode available
  }
  directUrlRow.hidden = !config.allowDirect;

  createEyes();
  // enumerateDevices() needs no permission, so the picker can be filled in
  // before the first start (labels stay blank until access is granted).
  void camera.refreshDevices().then(renderCameraDevices);
  renderCameraDevices();
  syncVisionUi();

  setCaption("WAKING HER UP…");
  setMainButton("busy", "Loading…");
  try {
    await stage.init({
      onprogress: (ev) => {
        if (ev.lengthComputable) {
          const pct = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
          loading.textContent = `Loading avatar ${pct}%`;
        }
      },
    });
  } catch (err) {
    console.error(err);
    loading.textContent = "The avatar failed to load. Check the console and reload.";
    setCaption("AVATAR FAILED TO LOAD", "error");
    return;
  }
  loading.classList.add("done");
  setCaption(CAPTIONS.idle);
  setMainButton("start", "Start talking");
  attachBtn.disabled = false;

  // Debug handles
  Object.assign(window, { stage, camera, landmarks, eyes, getClient: () => client, settings: () => settings });
}

void boot();
