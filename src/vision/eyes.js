// @ts-nocheck
/**
 * Eyes — Atrium's sense of sight.
 *
 * This is the piece gemma-avatar does not have. It owns the loop that turns a
 * webcam into something a language model can reason about, and it is built
 * around one assumption: the machine is slow.
 *
 * So nothing here runs flat out. The loop measures how long a perception pass
 * actually took and stretches its own interval to match — if tracking costs
 * 400 ms on your hardware, you get a new observation every ~600 ms instead of a
 * queue of frames piling up. Landmark tracking is optional and degrades to
 * frame-differencing on its own. Motion tracking always runs, because it costs
 * almost nothing and it is the only thing that still answers "did you move?"
 * when everything else is unavailable.
 *
 * Three modes:
 *   off       – the camera stays closed; no perception at all.
 *   ondemand  – perception runs, but nothing is said unless the model asks
 *               (`look_at_camera`, `count_my_fingers`, …) or the user speaks.
 *   live      – perception runs and *changes* are pushed into the conversation
 *               as they happen, so the model is never looking at a stale world.
 *
 * Emits `observation` (every pass) and `status` (mode / health changes).
 */

import { MotionTracker } from "./motion.js";
import { summarize, headline, changes, fingerWord } from "./describe.js";

/** @typedef {import("./describe.js").Perception} Perception */

const MOTION_W = 32;
const MOTION_H = 24;

/**
 * @typedef {Object} EyesSettings
 * @property {"off" | "ondemand" | "live"} mode
 * @property {number} minIntervalMs   Floor for the perception loop.
 * @property {number} maxIntervalMs   Ceiling for the adaptive interval.
 * @property {number} frameWidth      Width of the frame canvas used for tracking.
 * @property {boolean} mirror
 * @property {boolean} sendImages     Whether the model ever receives real frames.
 * @property {number} imageWidth
 * @property {number} imageQuality
 * @property {boolean} hands
 * @property {boolean} pose
 * @property {boolean} face
 * @property {boolean} allowCdn
 */

export const DEFAULT_EYES_SETTINGS = /** @type {EyesSettings} */ ({
  mode: "live",
  minIntervalMs: 180,
  maxIntervalMs: 2500,
  frameWidth: 640,
  mirror: true,
  sendImages: true,
  imageWidth: 640,
  imageQuality: 0.55,
  hands: true,
  pose: true,
  face: true,
  allowCdn: true,
});

export class Eyes extends EventTarget {
  /**
   * @param {{ camera: import("./camera.js").CameraEye,
   *           landmarks: import("./landmarks.js").LandmarkEngine,
   *           settings?: Partial<EyesSettings> }} opts
   */
  constructor(opts) {
    super();
    this.camera = opts.camera;
    this.landmarks = opts.landmarks;
    this.settings = { ...DEFAULT_EYES_SETTINGS, ...(opts.settings ?? {}) };
    this.motion = new MotionTracker();

    /** @type {Perception | null} */
    this.latest = null;
    /** @type {Perception | null} */
    this.lastReported = null;
    this.running = false;
    this.ticks = 0;
    this.intervalMs = this.settings.minIntervalMs;
    this._timer = 0;
    this._inTick = false;
    this._lastError = null;

    this.camera.addEventListener("error", (e) => {
      this._lastError = /** @type {CustomEvent} */ (e).detail?.error?.message ?? "camera error";
      this._emitStatus();
    });
  }

  get mode() {
    return this.settings.mode;
  }

  get statusText() {
    if (this._lastError) return this._lastError;
    if (!this.running) return "camera off";
    if (this.landmarks.available) return this.landmarks.detail;
    return "motion tracking only";
  }

  /** @param {Partial<EyesSettings>} patch */
  updateSettings(patch) {
    const prevMode = this.settings.mode;
    const prevParts = `${this.settings.hands}${this.settings.pose}${this.settings.face}`;
    Object.assign(this.settings, patch);
    this.camera.mirror = this.settings.mirror;
    this.intervalMs = Math.max(this.settings.minIntervalMs, Math.min(this.intervalMs, this.settings.maxIntervalMs));

    const nextParts = `${this.settings.hands}${this.settings.pose}${this.settings.face}`;
    if (prevParts !== nextParts && this.running) {
      // The set of trackers changed: rebuild the landmarkers.
      this.landmarks.want = {
        hands: this.settings.hands,
        pose: this.settings.pose,
        face: this.settings.face,
      };
      this.landmarks.close();
      void this.landmarks.init({ allowCdn: this.settings.allowCdn }).then(() => this._emitStatus());
    }

    if (this.settings.mode !== prevMode) {
      if (this.settings.mode === "off") void this.stop();
      else if (!this.running) void this.start();
    }
    this._emitStatus();
  }

  /** Open the camera, load the trackers, start the loop. */
  async start() {
    if (this.running) return;
    if (this.settings.mode === "off") return;
    this._lastError = null;
    this._emitStatus();

    if (!this.camera.ready) {
      await this.camera.start({
        deviceId: this.settings.deviceId || "",
        width: 1280,
        height: 720,
        frameRate: 30,
      });
    }

    this.running = true;
    this._emitStatus();

    // Trackers load in the background — perception starts immediately with
    // motion only, and upgrades itself the moment the models are ready.
    void this.landmarks
      .init({ allowCdn: this.settings.allowCdn })
      .then(() => this._emitStatus())
      .catch(() => this._emitStatus());

    this._schedule();
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = 0;
    this.camera.stop();
    this.motion.reset();
    this.latest = null;
    this.lastReported = null;
    this._emitStatus();
  }

  _schedule() {
    if (!this.running) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = window.setTimeout(() => {
      this._timer = 0;
      void this._tick();
    }, this.intervalMs);
  }

  async _tick() {
    if (!this.running || this._inTick) return this._schedule();
    this._inTick = true;
    const t0 = performance.now();
    try {
      const p = this.observe();
      if (p) {
        const diff = changes(this.lastReported, p);
        // Advance the baseline *before* dispatching: the change detector
        // compares consecutive passes, so without this every tick would look
        // like a brand-new scene and the model would be told "you came into
        // view" over and over.
        this.lastReported = p;
        this.latest = p;
        this.ticks++;
        this.dispatchEvent(new CustomEvent("observation", { detail: { perception: p, changes: diff } }));
      }
    } catch (err) {
      console.warn("[vision] perception pass failed:", err);
    } finally {
      this._inTick = false;
    }

    // Adaptive pacing: never let the loop run faster than the machine can
    // actually deliver, and back off hard if a pass was expensive.
    const cost = performance.now() - t0;
    const target = Math.max(this.settings.minIntervalMs, Math.min(cost * 1.6 + 40, this.settings.maxIntervalMs));
    this.intervalMs = this.intervalMs * 0.7 + target * 0.3;
    this._schedule();
  }

  /**
   * Run one perception pass right now and return what was seen.
   * @param {{ withImage?: boolean }} [opt]
   * @returns {Perception | null}
   */
  observe(opt = {}) {
    const cam = this.camera;
    if (!cam.ready) return null;

    const mirror = this.settings.mirror;
    const motionSample = this.motion.update(cam.grabPixels(MOTION_W, MOTION_H, { mirror }));

    let hands = /** @type {any[]} */ ([]);
    let pose = null;
    let face = null;
    let source = /** @type {"landmarks" | "motion" | "none"} */ ("motion");

    if (this.landmarks.available) {
      const frame = cam.renderFrame({ maxWidth: this.settings.frameWidth, mirror });
      if (frame) {
        const res = this.landmarks.detect(frame.canvas, { mirror });
        if (res) {
          hands = res.hands ?? [];
          pose = res.pose ?? null;
          face = res.face ?? null;
          source = "landmarks";
        }
      }
    }

    const person = Boolean(
      pose?.visible || face?.visible || hands.length > 0 || (motionSample && motionSample.presence > 0.32),
    );

    /** @type {Perception} */
    const p = {
      t: Date.now(),
      ok: true,
      source,
      person,
      hands,
      pose,
      face,
      motion: motionSample,
      mirror,
      fps: cam.fps,
      frame: { width: cam.width, height: cam.height },
    };
    if (opt.withImage) p.image = this.snapshot();
    return p;
  }

  /**
   * A JPEG still of the current frame, small enough to ship to a local model.
   * @param {{ maxWidth?: number, quality?: number }} [opt]
   * @returns {string | null} data URL
   */
  snapshot(opt = {}) {
    if (!this.camera.ready) return null;
    const snap = this.camera.capture({
      maxWidth: opt.maxWidth ?? this.settings.imageWidth,
      quality: opt.quality ?? this.settings.imageQuality,
      mirror: this.settings.mirror,
    });
    return snap?.dataUrl ?? null;
  }

  /**
   * Execute one of Atrium's vision tools on behalf of the model.
   * Returns the text the model should read, plus optionally a still frame to
   * attach to the very response it is about to speak.
   *
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @returns {{ text: string, image?: string | null, mode?: string }}
   */
  runTool(name, args) {
    if (!this.camera.ready || this.settings.mode === "off") {
      return {
        text:
          "Your camera is off, so you cannot see the user right now. Say, out loud, that they need to switch the camera on (the camera button in the controls) before you can see them.",
      };
    }

    switch (name) {
      case "look_at_camera": {
        const p = this.observe({ withImage: this.settings.sendImages });
        if (!p) return { text: "The camera is not returning frames right now." };
        const question = typeof args.question === "string" ? args.question.trim() : "";
        const body = summarize(p);
        return {
          text: question
            ? `${body}\n\nThey asked: "${question}". Answer it using what you can see.`
            : `${body}\n\nSay what you noticed, in your own words, in one short sentence.`,
          image: p.image ?? null,
        };
      }

      case "count_my_fingers": {
        const p = this.observe({ withImage: this.settings.sendImages });
        if (!p) return { text: "The camera is not returning frames right now." };
        if (!p.hands.length) {
          // No landmark tracking — hand the frame over and let the model count.
          return {
            text: p.image
              ? "No hands could be tracked automatically. A still from the camera is attached — look at it and count the raised fingers yourself. If you genuinely cannot see a hand, say so."
              : "No hands could be tracked automatically and no frame could be captured. Ask them to hold their hand up to the camera, palm towards it, and try again.",
            image: p.image ?? null,
          };
        }
        const bits = p.hands.map(
          (h) => `your ${h.hand} hand is holding up ${fingerWord(h.fingers)} (${h.fingersUp.join(", ") || "none"})`,
        );
        const total = p.hands.reduce((n, h) => n + h.fingers, 0);
        return {
          text: `${headline(p)}. Counting precisely: ${bits.join("; ")}${p.hands.length > 1 ? `; ${total} fingers across both hands` : ""}. Tell them the number.`,
          image: this.settings.sendImages ? p.image ?? null : null,
        };
      }

      case "describe_what_you_see": {
        const p = this.observe({ withImage: this.settings.sendImages });
        if (!p) return { text: "The camera is not returning frames right now." };
        return { text: summarize(p), image: p.image ?? null };
      }

      case "start_watching_me": {
        this.updateSettings({ mode: "live" });
        return { text: "You are now watching them continuously. You will notice when they move or change what they are holding up.", mode: "live" };
      }

      case "stop_watching_me": {
        this.updateSettings({ mode: "ondemand" });
        return { text: "You stopped watching continuously. You will only look when they ask.", mode: "ondemand" };
      }

      case "camera_status": {
        const parts = [
          `Camera: ${this.camera.ready ? `${this.camera.width}x${this.camera.height} @ ${Math.round(this.camera.fps)} fps` : "off"}`,
          `Mode: ${this.settings.mode}`,
          `Tracking: ${this.landmarks.available ? this.landmarks.detail : "motion only"}`,
          `Perception loop: ${Math.round(this.intervalMs)} ms (${this.ticks} observations)`,
        ];
        if (this.latest) parts.push(`Right now: ${headline(this.latest)}`);
        return { text: parts.join(" · ") };
      }

      default:
        return { text: `Unknown vision tool: ${name}` };
    }
  }

  _emitStatus() {
    this.dispatchEvent(
      new CustomEvent("status", {
        detail: {
          mode: this.settings.mode,
          running: this.running,
          text: this.statusText,
          landmarks: this.landmarks.status,
          intervalMs: Math.round(this.intervalMs),
        },
      }),
    );
  }
}

/** The tool definitions Atrium declares to the model, on top of gemma-avatar's. */
export const VISION_TOOL_DEFS = [
  {
    type: "function",
    name: "look_at_camera",
    description:
      "Look through the user's webcam right now. Use this whenever they refer to something they can see, show, hold, wear or do, or when you need to know what is in front of them.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Optional: the specific thing you want to check." },
      },
    },
  },
  {
    type: "function",
    name: "count_my_fingers",
    description:
      "Count how many fingers the user is holding up to the camera. Use this whenever they ask how many fingers, hold up a number, or ask you to count.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "describe_what_you_see",
    description: "Describe everything you can currently see through the camera: the person, their face, posture and hands.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "start_watching_me",
    description: "Watch the user continuously and react on your own when they move or change what they are doing.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "stop_watching_me",
    description: "Stop watching continuously; only look when asked.",
    parameters: { type: "object", properties: {} },
  },
];
