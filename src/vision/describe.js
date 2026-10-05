// @ts-nocheck
/**
 * describe.js — perception → words.
 *
 * The model cannot see a landmark array; it can read a sentence. This module
 * is the only place that turns numbers into language, and it has three jobs:
 *
 *   1. `summarize()`  – the full observation, for tool calls ("look at me").
 *   2. `headline()`   – one short line, for the HUD and for live context.
 *   3. `changes()`    – decide whether a new observation is worth telling the
 *                       model about at all.
 *
 * (3) is what makes continuous vision affordable. A webcam produces a slightly
 * different set of numbers sixty times a second; sending all of that would
 * drown the conversation. So observations are quantised into a coarse
 * signature — how many fingers, which third of the frame, which way you are
 * leaning — and only a *change* in that signature is news.
 */

/**
 * @typedef {Object} HandReading
 * @property {string} hand     "left" | "right" | "a" (from the user's own perspective)
 * @property {string} side     "left" | "centre" | "right" — where it is on their screen
 * @property {string} height   "upper" | "middle" | "lower"
 * @property {number} fingers  Count of extended fingers (thumb included)
 * @property {string[]} fingersUp
 * @property {boolean} thumbUp
 * @property {boolean} raised
 * @property {number} x
 * @property {number} y
 *
 * @typedef {Object} Perception
 * @property {number} t
 * @property {boolean} ok
 * @property {"landmarks" | "motion" | "none"} source
 * @property {boolean} person
 * @property {HandReading[]} hands
 * @property {any} pose
 * @property {any} face
 * @property {any} motion
 * @property {boolean} mirror
 * @property {number} fps
 * @property {{width: number, height: number}} frame
 */

const FINGER_WORDS = ["a closed fist", "one finger", "two fingers", "three fingers", "four fingers", "an open hand"];

/** @param {number} n */
export function fingerWord(n) {
  return FINGER_WORDS[Math.max(0, Math.min(5, n))] ?? `${n} fingers`;
}

/**
 * The full observation. Used when the model explicitly asks to look.
 * @param {Perception} p
 */
export function summarize(p) {
  if (!p || !p.ok) return "Camera observation unavailable: the camera is off or cannot be read.";

  const lines = [];
  lines.push(`Camera observation, taken live from your webcam at ${clock(p.t)}.`);

  // Presence
  if (!p.person) {
    lines.push("- Nobody is clearly in frame right now.");
    if (p.motion) {
      lines.push(`- There is ${motionWord(p.motion.level)} movement in the ${describeGrid(p.motion)} of the frame.`);
      if (p.motion.brightness < 0.08) lines.push("- The image is very dark — the room may be unlit or the camera covered.");
    }
    lines.push(`- Tracking: ${sourceWord(p)}.`);
    return lines.join("\n");
  }

  // Face
  if (p.face?.visible) {
    lines.push(`- Face: ${p.face.side} of frame, ${p.face.height} height, ${p.face.distance}, head ${p.face.tiltLabel}.`);
  }

  // Body
  if (p.pose?.visible) {
    const arms = p.pose.armsRaised?.length
      ? `${listWords(p.pose.armsRaised)} arm${p.pose.armsRaised.length > 1 ? "s" : ""} raised`
      : "both arms down";
    lines.push(`- Body: ${p.pose.side} of frame, ${p.pose.distance}, ${p.pose.leanLabel}, ${arms}.`);
  }

  // Hands — the part people actually ask about.
  if (p.hands.length) {
    for (const h of p.hands) {
      const where = `${h.height} ${h.side}`.replace("middle centre", "centre");
      const fingers = `${fingerWord(h.fingers)} up${h.fingersUp.length ? ` (${h.fingersUp.join(", ")})` : ""}`;
      lines.push(`- ${cap(h.hand)} hand: ${h.raised ? "raised" : "lowered"}, at the ${where} of the frame, ${fingers}.`);
    }
  } else if (p.source === "landmarks") {
    lines.push("- Hands: no hands currently detected.");
  }

  // Motion
  if (p.motion) {
    lines.push(`- Motion: ${motionWord(p.motion.level)}, ${p.motion.direction}.`);
  }

  lines.push(`- Tracking: ${sourceWord(p)}.`);
  return lines.join("\n");
}

/**
 * One compact line. This is what gets pushed into the conversation during
 * continuous vision, so it is kept deliberately short.
 * @param {Perception} p
 */
export function headline(p) {
  if (!p || !p.ok) return "camera off";
  if (!p.person) return "no one in frame";

  const bits = [];
  if (p.face?.visible) bits.push(`face ${p.face.side}`);
  if (p.pose?.visible && p.pose.leanLabel !== "upright") bits.push(p.pose.leanLabel);
  if (p.pose?.armsRaised?.length) bits.push(`${listWords(p.pose.armsRaised)} arm up`);

  for (const h of p.hands) {
    bits.push(`${h.hand} hand ${h.raised ? "raised" : "lowered"}, ${fingerWord(h.fingers)}`);
  }
  if (!p.hands.length && p.source === "landmarks") bits.push("no hands");

  if (p.motion && p.motion.direction !== "still" && p.motion.direction !== "moving in place") {
    bits.push(`moving ${p.motion.direction}`);
  }
  return bits.join(" · ") || "person in frame";
}

/**
 * A coarse, quantised fingerprint of the observation. Two frames with the same
 * signature look meaningfully the same to a person.
 * @param {Perception} p
 */
export function signature(p) {
  if (!p || !p.ok) return "off";
  if (!p.person) return "empty";
  const parts = [];
  if (p.face?.visible) parts.push(`f:${p.face.side}/${p.face.distance}/${p.face.tiltLabel}`);
  if (p.pose?.visible) parts.push(`b:${p.pose.side}/${p.pose.leanLabel}/${(p.pose.armsRaised ?? []).join("+") || "none"}`);
  for (const h of p.hands) parts.push(`h:${h.hand}:${h.fingers}:${h.raised ? "up" : "dn"}:${h.side}:${h.height}`);
  if (p.motion) parts.push(`m:${quantizeDirection(p.motion.direction)}`);
  return parts.join("|");
}

/**
 * Compare two observations and report what actually changed.
 * @param {Perception | null} prev
 * @param {Perception} cur
 * @returns {{ significant: boolean, reasons: string[], text: string }}
 */
export function changes(prev, cur) {
  const reasons = /** @type {string[]} */ ([]);
  if (!cur || !cur.ok) return { significant: false, reasons, text: "" };
  if (!prev || !prev.ok) {
    if (cur.person) reasons.push("you came into view");
    return { significant: reasons.length > 0, reasons, text: headline(cur) };
  }

  const wasThere = prev.person;
  const isThere = cur.person;
  if (isThere && !wasThere) reasons.push("you came into view");
  if (!isThere && wasThere) reasons.push("you left the frame");

  if (isThere && wasThere) {
    // Finger count is the headline feature: any change is always news.
    const prevFingers = prev.hands.map((h) => `${h.hand}:${h.fingers}`).sort().join(",");
    const curFingers = cur.hands.map((h) => `${h.hand}:${h.fingers}`).sort().join(",");
    if (prevFingers !== curFingers) {
      if (cur.hands.length) {
        const total = cur.hands.reduce((n, h) => n + h.fingers, 0);
        reasons.push(`you are now holding up ${fingerWord(cur.hands.length > 1 ? total : cur.hands[0].fingers)}`);
      } else {
        reasons.push("you lowered your hands");
      }
    }

    const prevRaised = prev.hands.map((h) => `${h.hand}:${h.raised}`).sort().join(",");
    const curRaised = cur.hands.map((h) => `${h.hand}:${h.raised}`).sort().join(",");
    if (prevRaised !== curRaised && !reasons.length) reasons.push("you moved your hands up or down");

    if (prev.pose?.visible && cur.pose?.visible) {
      if (prev.pose.side !== cur.pose.side) reasons.push(`you moved to the ${cur.pose.side}`);
      if (prev.pose.leanLabel !== cur.pose.leanLabel) reasons.push(`you are ${cur.pose.leanLabel}`);
      const a = (prev.pose.armsRaised ?? []).join("+");
      const b = (cur.pose.armsRaised ?? []).join("+");
      if (a !== b) reasons.push(b === "none" ? "you put your arms down" : `you raised your ${listWords(cur.pose.armsRaised)} arm`);
    }

    if (cur.motion) {
      const prevDir = quantizeDirection(prev.motion?.direction);
      const curDir = quantizeDirection(cur.motion.direction);
      if (prevDir !== curDir && curDir !== "still" && cur.level > 0.03) {
        reasons.push(`you moved ${cur.motion.direction}`);
      }
    }
  }

  return { significant: reasons.length > 0, reasons, text: headline(cur) };
}

/** @param {string} dir */
function quantizeDirection(dir) {
  if (!dir || dir === "still") return "still";
  // Collapse "up-left" style labels to their strongest axis so tiny diagonal
  // jitter doesn't read as a direction change.
  if (dir.includes("left")) return "left";
  if (dir.includes("right")) return "right";
  if (dir === "up") return "up";
  if (dir === "down") return "down";
  return "inplace";
}

/** @param {Perception} p */
function sourceWord(p) {
  if (p.source === "landmarks") return "MediaPipe landmark tracking (hands, body, face)";
  if (p.source === "motion") return "frame-difference motion tracking only (no landmark models installed)";
  return "camera frame only";
}

/** @param {number} level */
function motionWord(level) {
  if (level < 0.005) return "no";
  if (level < 0.03) return "slight";
  if (level < 0.1) return "moderate";
  if (level < 0.25) return "a lot of";
  return "constant large";
}

/** Which of the 3x3 regions saw the most movement. @param {any} m */
function describeGrid(m) {
  const names = ["top-left", "top", "top-right", "left", "centre", "right", "bottom-left", "bottom", "bottom-right"];
  let best = 0;
  for (let i = 1; i < 9; i++) if ((m.grid?.[i] ?? 0) > (m.grid?.[best] ?? 0)) best = i;
  return names[best];
}

/** @param {number} t */
function clock(t) {
  try {
    return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

/** @param {string} s */
function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** @param {string[]} words */
function listWords(words) {
  if (!words?.length) return "";
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(" and ")} and ${words[words.length - 1]}`.replace("and and", "and");
}
