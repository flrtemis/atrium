/**
 * Tests for the parts of Atrium's vision stack that are pure logic.
 *
 * The interesting behaviour here — finger counting, "what changed?", motion
 * direction — has to be right without a webcam, a GPU or a language model
 * attached, so it is checked against synthetic landmarks and synthetic frames.
 *
 *   bun test
 */

import { test, expect } from "bun:test";
import { countFingers, LandmarkEngine, LANDMARK_MODEL_FILES } from "../src/vision/landmarks.js";
import { MotionTracker } from "../src/vision/motion.js";
import { summarize, headline, signature, changes, fingerWord } from "../src/vision/describe.js";
import { HAND_CONNECTIONS, POSE_CONNECTIONS } from "../src/vision/overlay.js";

// ── Synthetic hands ─────────────────────────────────────────────────────
// Normalized image coordinates, y pointing down, matching MediaPipe's output.
// Layout: wrist low in the frame, knuckles above it, fingertips above those
// when a finger is extended and folded back below the knuckle when it is not.

/**
 * @param {{ thumb?: boolean, index?: boolean, middle?: boolean, ring?: boolean, pinky?: boolean }} up
 */
function makeHand(up = {}) {
  const lm = new Array(21).fill(null);
  const wrist = { x: 0.5, y: 0.8, z: 0 };
  lm[0] = wrist;

  // Thumb: extends sideways, away from the pinky.
  lm[1] = { x: 0.47, y: 0.74, z: 0 };
  lm[2] = { x: 0.44, y: 0.7, z: 0 };
  lm[3] = up.thumb ? { x: 0.4, y: 0.66, z: 0 } : { x: 0.44, y: 0.7, z: 0 };
  lm[4] = up.thumb ? { x: 0.32, y: 0.6, z: 0 } : { x: 0.52, y: 0.68, z: 0 };

  const fingers = [
    { mcp: 5, x: 0.45, base: 0.62 },
    { mcp: 9, x: 0.5, base: 0.6 },
    { mcp: 13, x: 0.55, base: 0.62 },
    { mcp: 17, x: 0.6, base: 0.65 },
  ];
  const keys = ["index", "middle", "ring", "pinky"];
  fingers.forEach((f, i) => {
    const extended = Boolean(up[keys[i]]);
    const pip = { x: f.x, y: f.base - 0.045, z: 0 };
    const dip = { x: f.x, y: extended ? pip.y - 0.03 : pip.y + 0.005, z: 0 };
    const tip = { x: f.x, y: extended ? dip.y - 0.03 : pip.y + 0.05, z: 0 };
    lm[f.mcp] = { x: f.x, y: f.base, z: 0 };
    lm[f.mcp + 1] = pip;
    lm[f.mcp + 2] = dip;
    lm[f.mcp + 3] = tip;
  });

  return lm;
}

test("countFingers: closed fist counts zero", () => {
  expect(countFingers(makeHand({})).count).toBe(0);
});

test("countFingers: open hand counts five", () => {
  const r = countFingers(makeHand({ thumb: true, index: true, middle: true, ring: true, pinky: true }));
  expect(r.count).toBe(5);
  expect(r.up).toEqual(["thumb", "index", "middle", "ring", "pinky"]);
});

test("countFingers: three fingers, thumb tucked", () => {
  const r = countFingers(makeHand({ index: true, middle: true, ring: true }));
  expect(r.count).toBe(3);
  expect(r.up).toEqual(["index", "middle", "ring"]);
  expect(r.thumbUp).toBe(false);
});

test("countFingers: one finger (pointing)", () => {
  expect(countFingers(makeHand({ index: true })).count).toBe(1);
});

test("countFingers: thumb plus two", () => {
  const r = countFingers(makeHand({ thumb: true, index: true, pinky: true }));
  expect(r.count).toBe(3);
  expect(r.thumbUp).toBe(true);
});

test("countFingers: every count from 0 to 5 is reachable", () => {
  const seen = new Set();
  const keys = ["thumb", "index", "middle", "ring", "pinky"];
  for (let mask = 0; mask < 32; mask++) {
    const up = {};
    keys.forEach((k, i) => {
      up[k] = Boolean(mask & (1 << i));
    });
    seen.add(countFingers(makeHand(up)).count);
  }
  for (let n = 0; n <= 5; n++) expect(seen.has(n)).toBe(true);
});

// ── Motion ──────────────────────────────────────────────────────────────

/** @param {number} w @param {number} h @param {(x:number,y:number)=>number} fn */
function frame(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = fn(x / w, y / h);
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

test("MotionTracker: identical frames report no movement", () => {
  const m = new MotionTracker();
  const a = frame(64, 48, () => 100);
  m.update(a);
  const s = m.update(frame(64, 48, () => 100));
  expect(s).not.toBeNull();
  expect(s.level).toBeLessThan(0.005);
  expect(s.direction).toBe("still");
});

test("MotionTracker: a bright blob is located on the correct side", () => {
  const m = new MotionTracker();
  m.update(frame(64, 48, () => 100));
  const right = m.update(frame(64, 48, (x) => (x > 0.66 ? 220 : 100)));
  expect(right.level).toBeGreaterThan(0.1);
  expect(right.centroid.x).toBeGreaterThan(0.6);

  const m2 = new MotionTracker();
  m2.update(frame(64, 48, () => 100));
  const left = m2.update(frame(64, 48, (x) => (x < 0.33 ? 220 : 100)));
  expect(left.centroid.x).toBeLessThan(0.4);
});

test("MotionTracker: a blob sweeping right reads as rightward motion", () => {
  const m = new MotionTracker();
  m.update(frame(64, 48, () => 100));
  let last = null;
  // Sweep the blob across the frame over several frames.
  for (let step = 1; step <= 5; step++) {
    const centre = step / 6;
    last = m.update(frame(64, 48, (x) => (Math.abs(x - centre) < 0.18 ? 220 : 100)));
  }
  expect(last).not.toBeNull();
  expect(last.flow.dx).toBeGreaterThan(0);
  expect(last.direction).toContain("right");
});

test("MotionTracker: brightness reflects how lit the frame is", () => {
  const m = new MotionTracker();
  m.update(frame(64, 48, () => 20));
  const dark = m.last.brightness;
  const m2 = new MotionTracker();
  m2.update(frame(64, 48, () => 230));
  expect(dark).toBeLessThan(0.15);
  expect(m2.last.brightness).toBeGreaterThan(0.85);
});

// ── Describing ──────────────────────────────────────────────────────────

/** @param {Partial<import("../src/vision/describe.js").Perception>} [over] */
function perception(over = {}) {
  return {
    t: Date.now(),
    ok: true,
    source: "landmarks",
    person: true,
    hands: [],
    pose: null,
    face: null,
    motion: { level: 0.02, changed: 1, cells: 100, centroid: { x: 0.5, y: 0.5 }, grid: new Array(9).fill(0), flow: { dx: 0, dy: 0 }, brightness: 0.5, presence: 0.8, direction: "still" },
    mirror: true,
    fps: 30,
    frame: { width: 1280, height: 720 },
    ...over,
  };
}

/** @param {{ hand?: string, fingers?: number, raised?: boolean, side?: string, height?: string }} o */
function hand(o) {
  return {
    hand: o.hand ?? "right",
    side: o.side ?? "centre",
    height: o.height ?? "middle",
    fingers: o.fingers ?? 0,
    fingersUp: [],
    thumbUp: false,
    raised: o.raised ?? true,
    x: 0.5,
    y: 0.5,
  };
}

test("fingerWord reads naturally for every count", () => {
  expect(fingerWord(0)).toBe("a closed fist");
  expect(fingerWord(1)).toBe("one finger");
  expect(fingerWord(3)).toBe("three fingers");
  expect(fingerWord(5)).toBe("an open hand");
  // A hand cannot hold up more than five; anything else clamps rather than
  // producing nonsense like "seven fingers".
  expect(fingerWord(9)).toBe("an open hand");
  expect(fingerWord(-1)).toBe("a closed fist");
});

test("headline names the hand and the count", () => {
  const h = headline(perception({ hands: [hand({ fingers: 3 })] }));
  expect(h).toContain("right hand");
  expect(h).toContain("three fingers");
});

test("summarize produces a readable observation", () => {
  const text = summarize(
    perception({
      face: { visible: true, side: "centre", height: "middle", distance: "close", tiltLabel: "level" },
      pose: { visible: true, side: "centre", distance: "a few steps away", leanLabel: "upright", armsRaised: ["right"], shoulderWidth: 0.2 },
      hands: [hand({ fingers: 3, fingersUp: ["index", "middle", "ring"] })],
    }),
  );
  expect(text).toContain("Camera observation");
  expect(text).toContain("three fingers");
  expect(text).toContain("right arm raised");
});

test("summarize says so when nobody is in frame", () => {
  const text = summarize(perception({ person: false, hands: [] }));
  expect(text).toContain("Nobody is clearly in frame");
});

test("summarize degrades gracefully when the camera is off", () => {
  const text = summarize({ ok: false });
  expect(text).toContain("unavailable");
});

test("signature is stable when nothing meaningful changes", () => {
  const a = perception({ hands: [hand({ fingers: 3 })] });
  const b = perception({ hands: [hand({ fingers: 3, x: 0.51, y: 0.49 })] });
  expect(signature(a)).toBe(signature(b));
});

test("changes: a new finger count is always news", () => {
  const prev = perception({ hands: [hand({ fingers: 2 })] });
  const cur = perception({ hands: [hand({ fingers: 3 })] });
  const diff = changes(prev, cur);
  expect(diff.significant).toBe(true);
  expect(diff.reasons.join(" ")).toContain("three fingers");
});

test("changes: the same scene is not news", () => {
  const prev = perception({ hands: [hand({ fingers: 3 })] });
  const cur = perception({ hands: [hand({ fingers: 3 })] });
  expect(changes(prev, cur).significant).toBe(false);
});

test("changes: coming into view and leaving are news", () => {
  expect(changes(null, perception({})).significant).toBe(true);
  expect(changes(perception({}), perception({ person: false })).reasons.join(" ")).toContain("left the frame");
  expect(changes(perception({ person: false }), perception({})).reasons.join(" ")).toContain("came into view");
});

test("changes: raising an arm is news", () => {
  const prev = perception({ pose: { visible: true, side: "centre", leanLabel: "upright", armsRaised: [] } });
  const cur = perception({ pose: { visible: true, side: "centre", leanLabel: "upright", armsRaised: ["left"] } });
  expect(changes(prev, cur).reasons.join(" ")).toContain("raised your left arm");
});

// ── Structure / integration guards ──────────────────────────────────────

test("overlay topologies only reference valid landmark indices", () => {
  for (const [a, b] of HAND_CONNECTIONS) {
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(21);
  }
  for (const [a, b] of POSE_CONNECTIONS) {
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(33);
  }
});

test("LandmarkEngine reports unavailable rather than throwing with no assets", async () => {
  const engine = new LandmarkEngine();
  // Point it at a path that definitely does not exist in the test runtime.
  await engine.init({ bundleUrl: "/definitely/not/here.mjs", wasmBase: "/nope", modelBase: "/nope" });
  expect(["unavailable", "ready"]).toContain(engine.status);
  expect(engine.status).toBe("unavailable");
  expect(engine.available).toBe(false);
  // detect() must be a no-op, not a crash.
  expect(engine.detect(null)).toBeNull();
});

test("the three landmark model filenames are the ones the downloader fetches", () => {
  expect(LANDMARK_MODEL_FILES.hands).toBe("hand_landmarker.task");
  expect(LANDMARK_MODEL_FILES.pose).toBe("pose_landmarker_lite.task");
  expect(LANDMARK_MODEL_FILES.face).toBe("face_landmarker.task");
});
