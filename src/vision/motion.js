// @ts-nocheck
/**
 * MotionTracker — the eye that always works.
 *
 * This is the fallback perception layer and it has no dependencies at all:
 * no wasm, no model download, no GPU. It downscales each frame to a tiny
 * grid, diffs it against the previous one, and reports *where* and *how much*
 * things moved.
 *
 * That is enough to answer the questions the avatar most often needs in real
 * time — "are you there?", "did you just move?", "which way did you go?" — and
 * it keeps working on the slowest machine, with the lights off, or when the
 * MediaPipe assets were never downloaded.
 *
 * Output is deliberately coarse: a `level` in 0..1, a motion centroid in
 * normalized coordinates, a 3x3 activity grid, and a smoothed direction. Small
 * numbers that are cheap to send to a language model.
 */

/**
 * @typedef {Object} MotionSample
 * @property {number} level    Fraction of sampled pixels that changed (0..1).
 * @property {number} changed  Raw changed-cell count.
 * @property {number} cells    Total sampled cells.
 * @property {{x: number, y: number}} centroid  Normalized 0..1 centre of motion.
 * @property {number[]} grid   3x3 (row-major) change levels, each 0..1.
 * @property {{dx: number, dy: number}} flow   Smoothed motion direction, -1..1 per axis.
 * @property {number} brightness  Mean luma 0..1 (detects a covered camera / dark room).
 * @property {number} presence    0..1 rolling "someone is moving around" score.
 * @property {string} direction   Human label: "still" | "left" | "right" | "up" | "down" + combos.
 */

const GRID_W = 32;
const GRID_H = 24;

export class MotionTracker {
  /**
   * @param {{ threshold?: number, smoothing?: number }} [opt]
   *   `threshold` is the per-pixel luma delta (0..255) that counts as changed.
   */
  constructor(opt = {}) {
    this.threshold = opt.threshold ?? 18;
    this.smoothing = opt.smoothing ?? 0.7;
    /** @type {Float32Array | null} */
    this._prev = null;
    /** @type {{x: number, y: number} | null} */
    this._prevCentroid = null;
    this._flow = { dx: 0, dy: 0 };
    this._presence = 0;
    /** @type {MotionSample | null} */
    this.last = null;
  }

  reset() {
    this._prev = null;
    this._prevCentroid = null;
    this._flow = { dx: 0, dy: 0 };
    this._presence = 0;
    this.last = null;
  }

  /**
   * Consume one frame.
   * @param {ImageData | null} imageData
   * @returns {MotionSample | null}
   */
  update(imageData) {
    if (!imageData || !imageData.data) return null;
    const { data, width, height } = imageData;

    // Downsample to a GRID_W x GRID_H luma grid (box average of each cell).
    const cells = GRID_W * GRID_H;
    if (!this._prev || this._prev.length !== cells) this._prev = new Float32Array(cells);
    const cur = new Float32Array(cells);
    let brightnessSum = 0;

    for (let gy = 0; gy < GRID_H; gy++) {
      const y0 = Math.floor((gy * height) / GRID_H);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GRID_H));
      for (let gx = 0; gx < GRID_W; gx++) {
        const x0 = Math.floor((gx * width) / GRID_W);
        const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / GRID_W));
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1; y += 2) {
          let idx = (y * width + x0) * 4;
          for (let x = x0; x < x1; x += 2, idx += 8) {
            // Rec.601 luma from RGB; alpha is always 255 for a video frame.
            sum += data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
            n++;
          }
        }
        const luma = n ? sum / n : 0;
        brightnessSum += luma;
        cur[gy * GRID_W + gx] = luma;
      }
    }

    const prev = /** @type {Float32Array} */ (this._prev);
    let changed = 0;
    let cx = 0;
    let cy = 0;
    const grid = new Array(9).fill(0);
    const gridCounts = new Array(9).fill(0);

    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        const i = gy * GRID_W + gx;
        const delta = Math.abs(cur[i] - prev[i]);
        if (delta < this.threshold) continue;
        changed++;
        cx += (gx + 0.5) / GRID_W;
        cy += (gy + 0.5) / GRID_H;
        // Which of the 3x3 regions does this cell belong to?
        const r = Math.min(2, Math.floor((gy * 3) / GRID_H));
        const c = Math.min(2, Math.floor((gx * 3) / GRID_W));
        const g = r * 3 + c;
        grid[g] += 1;
        gridCounts[g] += 1;
      }
    }

    for (let i = 0; i < 9; i++) {
      const perRegion = (GRID_W / 3) * (GRID_H / 3);
      grid[i] = gridCounts[i] ? grid[i] / perRegion : 0;
    }

    const level = changed / cells;
    const centroid = changed ? { x: cx / changed, y: cy / changed } : (this._prevCentroid ?? { x: 0.5, y: 0.5 });

    // Direction: how far the motion centroid travelled since the last sample.
    if (changed > 0 && this._prevCentroid) {
      const dx = centroid.x - this._prevCentroid.x;
      const dy = centroid.y - this._prevCentroid.y;
      // Only trust a shift when there was meaningful motion to track.
      const gain = Math.min(1, level * 12);
      // The *8 turns a per-frame centroid shift into a readable signal, but it
      // must stay bounded or a fast sweep would report a direction of "9".
      this._flow.dx = clampUnit(this._flow.dx * this.smoothing + dx * gain * (1 - this.smoothing) * 8);
      this._flow.dy = clampUnit(this._flow.dy * this.smoothing + dy * gain * (1 - this.smoothing) * 8);
    } else {
      this._flow.dx *= this.smoothing;
      this._flow.dy *= this.smoothing;
    }
    if (changed > 0) this._prevCentroid = centroid;

    // Presence: rises fast when motion appears, decays slowly when it stops, so
    // a person sitting still still counts as "there".
    const target = Math.min(1, level * 6);
    this._presence = Math.max(target, this._presence * 0.94);

    // This frame becomes the reference for the next one.
    this._prev.set(cur);

    const sample = /** @type {MotionSample} */ ({
      level,
      changed,
      cells,
      centroid,
      grid,
      flow: { dx: this._flow.dx, dy: this._flow.dy },
      brightness: brightnessSum / (cells * 255),
      presence: this._presence,
      direction: labelDirection(this._flow, level),
    });
    this.last = sample;
    return sample;
  }
}

/**
 * @param {{dx: number, dy: number}} flow
 * @param {number} level
 * @returns {string}
 */
function labelDirection(flow, level) {
  if (level < 0.01) return "still";
  const dead = 0.12; // ignore jitter
  const parts = [];
  if (flow.dy < -dead) parts.push("up");
  else if (flow.dy > dead) parts.push("down");
  if (flow.dx < -dead) parts.push("left");
  else if (flow.dx > dead) parts.push("right");
  if (!parts.length) return "moving in place";
  return parts.join("-");
}

/** @param {number} v */
function clampUnit(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Which third of the frame a normalized coordinate falls in. */
export function zoneX(x) {
  return x < 0.33 ? "left" : x > 0.67 ? "right" : "centre";
}

/** @param {number} y */
export function zoneY(y) {
  return y < 0.33 ? "top" : y > 0.67 ? "bottom" : "middle";
}
