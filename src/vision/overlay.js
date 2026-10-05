// @ts-nocheck
/**
 * overlay.js — draw what the AI sees, on top of what you see.
 *
 * Landmark topology is inlined rather than pulled from the MediaPipe bundle so
 * the overlay still works when the models were never downloaded (motion grid
 * only) and so it can be used by the Camera Lab without loading wasm at all.
 */

// MediaPipe hands: wrist → thumb → index → middle → ring → pinky.
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// BlazePose 33-point topology.
export const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

const COLORS = {
  hand: "#5eead4",
  handFinger: "#a7f3d0",
  pose: "#93c5fd",
  poseJoint: "#dbeafe",
  face: "#f0abfc",
  motion: "rgba(251, 191, 36, ",
  text: "rgba(255,255,255,0.92)",
};

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import("./describe.js").Perception | null} p
 * @param {{ width: number, height: number,
 *           show?: { hands?: boolean, pose?: boolean, face?: boolean, motion?: boolean, labels?: boolean } }} opt
 */
export function drawOverlay(ctx, p, opt) {
  const { width: w, height: h } = opt;
  ctx.clearRect(0, 0, w, h);
  if (!p || !p.ok) return;

  const show = { hands: true, pose: true, face: true, motion: true, labels: true, ...(opt.show ?? {}) };

  if (show.motion && p.motion) drawMotion(ctx, p.motion, w, h);
  if (show.face && p.face?.landmarks) drawFace(ctx, p.face, w, h);
  if (show.pose && p.pose?.landmarks) drawPose(ctx, p.pose, w, h);
  if (show.hands) for (const hand of p.hands ?? []) drawHand(ctx, hand, w, h);
  if (show.labels) drawLabels(ctx, p, w, h);
}

/** @param {import("./describe.js").Perception} p */
function drawLabels(ctx, p, w, h) {
  const scale = Math.min(w, h) / 400;
  const font = Math.max(9, Math.round(11 * scale));
  ctx.font = `600 ${font}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "top";

  for (const hand of p.hands ?? []) {
    const lm = hand.landmarks;
    if (!lm) continue;
    const wrist = lm[0];
    const x = wrist.x * w;
    const y = wrist.y * h;
    const label = `${hand.hand === "a" ? "" : `${hand.hand} · `}${hand.fingers}↑`;
    const tw = ctx.measureText(label).width;
    const bx = Math.max(2, Math.min(w - tw - 10, x - tw / 2));
    const by = Math.max(2, Math.min(h - font - 10, y + 12 * scale));
    ctx.fillStyle = "rgba(6, 20, 26, 0.72)";
    ctx.fillRect(bx - 4, by - 3, tw + 8, font + 8);
    ctx.fillStyle = COLORS.handFinger;
    ctx.fillText(label, bx, by);
  }
}

function drawMotion(ctx, m, w, h) {
  const grid = m.grid ?? [];
  const cw = w / 3;
  const ch = h / 3;
  for (let i = 0; i < 9; i++) {
    const v = Math.min(1, (grid[i] ?? 0) * 3);
    if (v <= 0.02) continue;
    ctx.fillStyle = `${COLORS.motion}${(v * 0.28).toFixed(3)})`;
    const gx = (i % 3) * cw;
    const gy = Math.floor(i / 3) * ch;
    ctx.fillRect(gx, gy, cw, ch);
  }
  // Motion centroid.
  if (m.level > 0.01) {
    const cx = m.centroid.x * w;
    const cy = m.centroid.y * h;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(251, 191, 36, 0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

/**
 * Landmarks come out of the same (already mirrored) frame the preview shows, so
 * they map straight onto the overlay canvas with no flip. The flip lives in one
 * place only — the camera's render — and everything downstream shares it.
 */
function toScreen(lm, w, h) {
  return { x: lm.x * w, y: lm.y * h };
}

function drawHand(ctx, hand, w, h) {
  const lm = hand.landmarks;
  if (!lm) return;
  ctx.lineWidth = Math.max(1.5, w / 320);
  ctx.strokeStyle = COLORS.hand;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    if (!lm[a] || !lm[b]) continue;
    const pa = toScreen(lm[a], w, h);
    const pb = toScreen(lm[b], w, h);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();

  ctx.fillStyle = COLORS.handFinger;
  // Highlight the fingertips that are counted as extended.
  const tipIndex = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
  for (let i = 0; i < lm.length; i++) {
    if (!lm[i]) continue;
    const { x, y } = toScreen(lm[i], w, h);
    const isUp = Object.entries(tipIndex).some(([name, idx]) => idx === i && hand.fingersUp.includes(name));
    ctx.beginPath();
    ctx.arc(x, y, isUp ? Math.max(3, w / 150) : Math.max(1.4, w / 420), 0, Math.PI * 2);
    ctx.fillStyle = isUp ? "#fde68a" : COLORS.handFinger;
    ctx.fill();
  }
}

function drawPose(ctx, pose, w, h) {
  const lm = pose.landmarks;
  if (!lm) return;
  ctx.lineWidth = Math.max(1.5, w / 340);
  ctx.strokeStyle = COLORS.pose;
  ctx.beginPath();
  for (const [a, b] of POSE_CONNECTIONS) {
    if (!lm[a] || !lm[b]) continue;
    if ((lm[a].visibility ?? 1) < 0.4 || (lm[b].visibility ?? 1) < 0.4) continue;
    const pa = toScreen(lm[a], w, h);
    const pb = toScreen(lm[b], w, h);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();

  const jr = Math.max(1.6, w / 380);
  ctx.fillStyle = COLORS.poseJoint;
  ctx.beginPath();
  for (const p of lm) {
    if (!p || (p.visibility ?? 1) < 0.4) continue;
    const { x, y } = toScreen(p, w, h);
    ctx.moveTo(x + jr, y);
    ctx.arc(x, y, jr, 0, Math.PI * 2);
  }
  ctx.fill();
}

function drawFace(ctx, face, w, h) {
  const lm = face.landmarks;
  if (!lm) return;
  const r = Math.max(0.9, w / 700);
  ctx.fillStyle = COLORS.face;
  // Every third point reads as a face; one batched path keeps it to a single
  // fill instead of ~150 of them, which matters on the slow machines this is
  // explicitly meant to survive.
  ctx.beginPath();
  for (let i = 0; i < lm.length; i += 3) {
    const p = lm[i];
    if (!p) continue;
    const { x, y } = toScreen(p, w, h);
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
}
