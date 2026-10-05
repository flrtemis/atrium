// @ts-nocheck
/**
 * LandmarkEngine — precise body/hand/face tracking, when it is available.
 *
 * A thin, defensive wrapper around MediaPipe Tasks Vision (HandLandmarker,
 * PoseLandmarker, FaceLandmarker). Everything about it is optional: the wasm
 * bundle and the .task models are downloaded separately (`download_vision_assets.py`),
 * so a fresh clone has none of them. When they are missing — or the GPU refuses
 * to initialise, or the network blocked the CDN — this class simply reports
 * `status: "unavailable"` and Atrium carries on with motion tracking and raw
 * camera frames. Nothing else in the app is allowed to depend on it succeeding.
 *
 * It runs in `video` mode and is fed by the perception loop at whatever rate
 * the machine can actually sustain.
 */

/** @typedef {any} HTMLVideoElement */

// Where `download_vision_assets.py` puts things (served from /vendor/...).
const LOCAL_BUNDLE = "/vendor/mediapipe/vision_bundle.mjs";
const LOCAL_WASM = "/vendor/mediapipe/wasm";
const LOCAL_MODELS = "/vendor/mediapipe/models";

// Last-resort public mirrors, used only when the local copies are absent.
const CDN_BUNDLE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";
const CDN_WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const CDN_MODELS = "https://storage.googleapis.com/mediapipe-models";

const MODEL_FILES = {
  hands: "hand_landmarker.task",
  pose: "pose_landmarker_lite.task",
  face: "face_landmarker.task",
};

export class LandmarkEngine {
  /**
   * @param {{ hands?: boolean, pose?: boolean, face?: boolean, allowCdn?: boolean }} [opt]
   */
  constructor(opt = {}) {
    this.want = {
      hands: opt.hands !== false,
      pose: opt.pose !== false,
      face: opt.face !== false,
    };
    /** "off" | "loading" | "ready" | "unavailable" */
    this.status = "off";
    /** Human-readable explanation, shown in the HUD. */
    this.detail = "not started";
    /** Which trackers actually came up. */
    this.have = { hands: false, pose: false, face: false };
    /** @type {any} */
    this._tasks = null;
    /** @type {any} */
    this._hands = null;
    /** @type {any} */
    this._pose = null;
    /** @type {any} */
    this._face = null;
    this._fileset = null;
    this._lastTs = 0;
    this._initPromise = null;
    this.allowCdn = opt.allowCdn !== false;
    /** Smoothed detection cost, in ms — drives the adaptive throttler. */
    this.lastCostMs = 0;
  }

  get available() {
    return this.status === "ready" && (this.have.hands || this.have.pose || this.have.face);
  }

  /**
   * Load the wasm runtime and whichever models are present. Never throws:
   * failures land in `status`/`detail`.
   * @param {{ bundleUrl?: string, wasmBase?: string, modelBase?: string }} [opt]
   */
  async init(opt = {}) {
    if (this._initPromise) return this._initPromise;
    this.status = "loading";
    this.detail = "loading MediaPipe…";
    this._initPromise = this._initInner(opt).catch((err) => {
      this.status = "unavailable";
      this.detail = `landmark tracking unavailable (${err?.message ?? err})`;
      return false;
    });
    return this._initPromise;
  }

  /** @param {{ bundleUrl?: string, wasmBase?: string, modelBase?: string }} [opt] */
  async _initInner(opt = {}) {
    const sources = [];
    if (opt.bundleUrl || !this.allowCdn) {
      sources.push({
        bundle: opt.bundleUrl ?? LOCAL_BUNDLE,
        wasm: opt.wasmBase ?? LOCAL_WASM,
        models: opt.modelBase ?? LOCAL_MODELS,
      });
    } else {
      // Prefer the local copies (fast, offline, no third-party request); fall
      // back to the CDNs so a fresh clone still gets precise tracking.
      sources.push({ bundle: LOCAL_BUNDLE, wasm: LOCAL_WASM, models: LOCAL_MODELS });
      sources.push({ bundle: CDN_BUNDLE, wasm: CDN_WASM, models: CDN_MODELS });
    }

    let lastError = null;
    for (const src of sources) {
      try {
        const ok = await this._trySource(src);
        if (ok) return true;
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(lastError?.message ?? "no MediaPipe source could be loaded");
  }

  async _trySource(src) {
    // Probe the bundle first: a 404 on the local copy should move us to the
    // CDN rather than blow up inside the wasm loader.
    const probe = await fetch(src.bundle, { method: "GET", cache: "force-cache" });
    if (!probe.ok) throw new Error(`${src.bundle} → HTTP ${probe.status}`);

    // Check for models *before* loading the runtime. The wasm is ~11 MB; on a
    // fresh clone with no models installed, pulling it down to then discover
    // there is nothing to run would be a slow way to reach a known answer.
    const wanted = /** @type {("hands" | "pose" | "face")[]} */ (
      Object.keys(this.want).filter((k) => this.want[/** @type {keyof typeof this.want} */ (k)])
    );
    const found = await Promise.all(
      wanted.map(async (key) => {
        try {
          const res = await fetch(`${src.models}/${MODEL_FILES[key]}`, { method: "HEAD" });
          return res.ok ? key : null;
        } catch {
          return null;
        }
      }),
    );
    if (!found.some(Boolean)) {
      throw new Error("no landmark models found (run download_vision_assets.py)");
    }

    const tasks = await import(/* @vite-ignore */ src.bundle);
    this._tasks = tasks;
    const fileset = await tasks.FilesetResolver.forVisionTasks(src.wasm);
    this._fileset = fileset;

    const present = new Set(found.filter(Boolean));
    const results = await Promise.all([
      present.has("hands") ? this._makeHand(tasks, fileset, src.models) : null,
      present.has("pose") ? this._makePose(tasks, fileset, src.models) : null,
      present.has("face") ? this._makeFace(tasks, fileset, src.models) : null,
    ]);
    [this._hands, this._pose, this._face] = results;
    this.have = { hands: Boolean(this._hands), pose: Boolean(this._pose), face: Boolean(this._face) };

    if (!this.have.hands && !this.have.pose && !this.have.face) {
      throw new Error("no landmark models found (run download_vision_assets.py)");
    }

    const parts = Object.entries(this.have)
      .filter(([, v]) => v)
      .map(([k]) => k);
    this.status = "ready";
    this.detail = `tracking: ${parts.join(", ")}`;
    return true;
  }

  async _makeHand(tasks, fileset, modelBase) {
    if (!this.want.hands) return null;
    return this._create(tasks.HandLandmarker, fileset, {
      baseOptions: { modelAssetPath: `${modelBase}/${MODEL_FILES.hands}`, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  async _makePose(tasks, fileset, modelBase) {
    if (!this.want.pose) return null;
    return this._create(tasks.PoseLandmarker, fileset, {
      baseOptions: { modelAssetPath: `${modelBase}/${MODEL_FILES.pose}`, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  async _makeFace(tasks, fileset, modelBase) {
    if (!this.want.face) return null;
    return this._create(tasks.FaceLandmarker, fileset, {
      baseOptions: { modelAssetPath: `${modelBase}/${MODEL_FILES.face}`, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  /** Create a landmarker, retrying on the CPU delegate if the GPU one fails. */
  async _create(Cls, fileset, options) {
    if (!Cls) return null;
    try {
      return await Cls.createFromOptions(fileset, options);
    } catch (err) {
      // GPU delegate is the usual culprit (headless, blocklisted driver, no
      // WebGL). Retry on CPU — slower, but "slow and working" is the goal.
      try {
        return await Cls.createFromOptions(fileset, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: "CPU" },
        });
      } catch {
        console.warn("[vision] landmarker unavailable:", err?.message ?? err);
        return null;
      }
    }
  }

  /**
   * Run every enabled tracker over the current frame.
   *
   * `source` is any MediaPipe `ImageSource` — normally the (already mirrored)
   * frame canvas the perception loop prepared, so that "left" means the same
   * thing to MediaPipe, to the model, and to the person in front of the screen.
   *
   * @param {HTMLVideoElement | HTMLCanvasElement} source
   * @param {{ mirror?: boolean }} [opt]
   * @returns {{hands: any[], pose: any, face: any} | null}
   */
  detect(source, opt = {}) {
    const mirror = opt.mirror !== false;
    if (!this.available || !source) return null;
    if (source instanceof HTMLVideoElement && (source.readyState < 2 || !source.videoWidth)) return null;

    const t0 = performance.now();
    // MediaPipe requires strictly increasing timestamps; a paused or looping
    // video can hand back the same currentTime twice in a row.
    const now = typeof source.currentTime === "number" ? source.currentTime * 1000 : performance.now();
    const ts = Math.max(Math.round(now), this._lastTs + 1);
    this._lastTs = ts;

    /** @type {any} */
    const out = { hands: [], pose: null, face: null };

    try {
      if (this._hands) {
        const res = this._hands.detectForVideo(source, ts);
        const marks = res?.landmarks ?? [];
        const handed = res?.handedness ?? res?.handednesses ?? [];
        for (let i = 0; i < marks.length; i++) {
          const lm = marks[i];
          if (!lm || lm.length < 21) continue;
          const label = handed[i]?.[0]?.categoryName ?? "";
          const score = handed[i]?.[0]?.score ?? 0;
          out.hands.push(readHand(lm, label, score, mirror));
        }
      }
    } catch (err) {
      console.warn("[vision] hand detection failed:", err);
    }

    try {
      if (this._pose) {
        const res = this._pose.detectForVideo(source, ts);
        const lm = res?.landmarks?.[0];
        if (lm && lm.length >= 25) out.pose = readPose(lm);
      }
    } catch (err) {
      console.warn("[vision] pose detection failed:", err);
    }

    try {
      if (this._face) {
        const res = this._face.detectForVideo(source, ts);
        const lm = res?.faceLandmarks?.[0];
        if (lm && lm.length > 263) out.face = readFace(lm);
      }
    } catch (err) {
      console.warn("[vision] face detection failed:", err);
    }

    this.lastCostMs = performance.now() - t0;
    return out;
  }

  close() {
    try {
      this._hands?.close?.();
      this._pose?.close?.();
      this._face?.close?.();
    } catch {
      // ignored
    }
    this._hands = null;
    this._pose = null;
    this._face = null;
    this.status = "off";
    this.detail = "closed";
    this._initPromise = null;
  }
}

// ── Reading the landmarks ────────────────────────────────────────────────
// Landmark indices are fixed by the MediaPipe models:
//   hand: 0 wrist · 1-4 thumb · 5-8 index · 9-12 middle · 13-16 ring · 17-20 pinky
//   pose: 0 nose · 11/12 shoulders · 13/14 elbows · 15/16 wrists · 23/24 hips
//   face: 33 / 263 outer eye corners (the 468-point mesh)

/** @param {number} x @param {number} y */
function zoneX(x) {
  return x < 0.33 ? "left" : x > 0.67 ? "right" : "centre";
}

/** @param {number} y */
function zoneY(y) {
  return y < 0.33 ? "upper" : y > 0.67 ? "lower" : "middle";
}

/** @param {{x:number,y:number,z?:number}} a @param {{x:number,y:number,z?:number}} b */
function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Count extended fingers. A finger counts as up when its tip is farther from
 * the wrist than its middle knuckle — a distance test, so it survives the hand
 * rotating or tilting. The thumb is measured against the pinky knuckle instead,
 * because it extends sideways rather than away.
 * @param {{x:number,y:number,z:number}[]} lm
 */
export function countFingers(lm) {
  const wrist = lm[0];
  const tips = [
    { name: "index", tip: lm[8], knuckle: lm[5] },
    { name: "middle", tip: lm[12], knuckle: lm[9] },
    { name: "ring", tip: lm[16], knuckle: lm[13] },
    { name: "pinky", tip: lm[20], knuckle: lm[17] },
  ];
  let count = 0;
  /** @type {string[]} */
  const up = [];
  for (const f of tips) {
    if (!f.tip || !f.knuckle) continue;
    if (dist2(f.tip, wrist) > dist2(f.knuckle, wrist) * 1.12) {
      count++;
      up.push(f.name);
    }
  }
  // Thumb: tip farther from the pinky MCP than the thumb IP is.
  const thumbUp = lm[4] && lm[3] && lm[17] ? dist2(lm[4], lm[17]) > dist2(lm[3], lm[17]) * 1.12 : false;
  if (thumbUp) {
    count++;
    up.unshift("thumb");
  }
  return { count, up, thumbUp };
}

/**
 * @param {{x:number,y:number,z:number}[]} lm
 * @param {string} handedness MediaPipe's label ("Left"/"Right").
 * @param {number} score
 * @param {boolean} mirror Whether the frame was mirrored before tracking.
 */
function readHand(lm, handedness, score, mirror) {
  const wrist = lm[0];
  const fingers = countFingers(lm);
  // Is the hand held up (fingertips above the wrist in image space)?
  const tipY = (lm[8].y + lm[12].y + lm[16].y) / 3;
  const raised = tipY < wrist.y - 0.02;
  // Rough hand size in the frame → distance proxy.
  const span = dist2(lm[0], lm[9]) || 0.001;
  // MediaPipe labels handedness as if the image were a mirrored selfie. We feed
  // it the mirrored frame, so its label is already the user's real hand; on a
  // raw (unmirrored) frame the two are swapped.
  const who = !handedness
    ? "a"
    : mirror
      ? handedness.toLowerCase()
      : handedness === "Left"
        ? "right"
        : "left";
  return {
    side: zoneX(wrist.x),
    screenSide: zoneX(wrist.x),
    height: zoneY(wrist.y),
    x: wrist.x,
    y: wrist.y,
    fingers: fingers.count,
    fingersUp: fingers.up,
    thumbUp: fingers.thumbUp,
    raised,
    spread: span,
    hand: who,
    confidence: score,
    landmarks: lm,
  };
}

/**
 * @param {{x:number,y:number,z:number,visibility?:number}[]} lm
 */
function readPose(lm) {
  const nose = lm[0];
  const lSh = lm[11];
  const rSh = lm[12];
  const lEl = lm[13];
  const rEl = lm[14];
  const lWr = lm[15];
  const rWr = lm[16];
  const lHip = lm[23];
  const rHip = lm[24];
  const visible = Boolean(nose && lSh && rSh);

  const shoulderMid = { x: (lSh.x + rSh.x) / 2, y: (lSh.y + rSh.y) / 2 };
  const hipMid = lHip && rHip ? { x: (lHip.x + rHip.x) / 2, y: (lHip.y + rHip.y) / 2 } : shoulderMid;
  const shoulderWidth = dist2(lSh, rSh) || 0.001;

  // Leaning is a horizontal offset between the shoulder and hip midpoints,
  // normalised by shoulder width so it holds at any distance.
  const lean = (shoulderMid.x - hipMid.x) / shoulderWidth;
  let leanLabel = "upright";
  if (lean > 0.15) leanLabel = "leaning right";
  else if (lean < -0.15) leanLabel = "leaning left";

  // An arm counts as raised when its wrist sits above its shoulder.
  const armUp = (wrist, shoulder) => Boolean(wrist && shoulder && wrist.y < shoulder.y - 0.04);
  const arms = [];
  if (armUp(lWr, lSh)) arms.push("left");
  if (armUp(rWr, rSh)) arms.push("right");

  return {
    visible,
    x: shoulderMid.x,
    y: shoulderMid.y,
    nose: { x: nose.x, y: nose.y },
    side: zoneX(shoulderMid.x),
    shoulderWidth,
    lean,
    leanLabel,
    armsRaised: arms,
    // Bigger shoulders in frame == closer to the camera.
    distance: shoulderWidth > 0.34 ? "very close" : shoulderWidth > 0.22 ? "close" : shoulderWidth > 0.14 ? "a few steps away" : "far away",
    landmarks: lm,
    key: { lSh, rSh, lEl, rEl, lWr, rWr, lHip, rHip, nose },
  };
}

/**
 * @param {{x:number,y:number,z:number}[]} lm
 */
function readFace(lm) {
  const lEye = lm[33];
  const rEye = lm[263];
  const noseTip = lm[4] ?? lm[1];
  const eyeDist = dist2(lEye, rEye) || 0.001;
  // Roll of the head, from the line between the outer eye corners.
  const tilt = (Math.atan2(rEye.y - lEye.y, rEye.x - lEye.x) * 180) / Math.PI;
  let tiltLabel = "level";
  if (tilt < -12) tiltLabel = "tilted left";
  else if (tilt > 12) tiltLabel = "tilted right";
  return {
    visible: true,
    x: noseTip.x,
    y: noseTip.y,
    side: zoneX(noseTip.x),
    height: zoneY(noseTip.y),
    eyeDistance: eyeDist,
    distance: eyeDist > 0.22 ? "very close to the camera" : eyeDist > 0.13 ? "close" : eyeDist > 0.07 ? "a few steps away" : "far away",
    tilt,
    tiltLabel,
    landmarks: lm,
  };
}

export const LANDMARK_MODEL_FILES = MODEL_FILES;
export { LOCAL_BUNDLE, LOCAL_WASM, LOCAL_MODELS, CDN_BUNDLE, CDN_WASM, CDN_MODELS };
