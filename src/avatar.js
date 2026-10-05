// @ts-nocheck
/**
 * The avatar stage: a TalkingHead 3D avatar with real-time audio-driven
 * lip-sync (HeadAudio), plus the choreography that makes it feel present.
 *
 * How the mouth moves: the speech-to-speech backend sends raw PCM only — no
 * word timings, no visemes — so lip-sync is derived from the audio itself.
 * The s2s client's playback worklet is routed into TalkingHead's audio graph
 * (`audioAnalyzerNode → audioSpeechGainNode → reverb → speakers`), and the
 * HeadAudio worklet taps `audioSpeechGainNode`, classifying MFCC frames into
 * Oculus visemes (~50 ms behind the audio). Its `onvalue` callback writes the
 * viseme blendshapes straight into TalkingHead's morph-target state.
 *
 * Everything else — blinking, breathing, idle head sway, moods, gestures,
 * emojis — is TalkingHead's built-in animation system, steered from here.
 */

import { TalkingHead } from "@met4citizen/talkinghead";
import { HeadAudio } from "./vendor/headaudio.min.mjs";

const HEADAUDIO_WORKLET_URL = "/vendor/headworklet.min.mjs";
const HEADAUDIO_MODEL_URL = "/vendor/model-en-mixed.bin";

export const AVATAR_MOODS = [
  "neutral",
  "happy",
  "angry",
  "sad",
  "fear",
  "disgust",
  "love",
  "sleep",
];

export const AVATAR_GESTURES = [
  "handup",
  "index",
  "ok",
  "thumbup",
  "thumbdown",
  "side",
  "shrug",
];

export class AvatarStage {
  /** @param {HTMLElement} container */
  constructor(container) {
    this._container = container;
    /** @type {TalkingHead | null} */
    this.head = null;
    /** @type {any | null} */
    this._headaudio = null;
    this._lastSpeechEnded = 0;
  }

  /**
   * Create the TalkingHead scene and load the avatar + lip-sync model.
   * @param {{ avatarUrl?: string, body?: "F" | "M", onprogress?: (ev: ProgressEvent) => void }} [opt]
   */
  async init(opt = {}) {
    // Lighting all zeroed: the scene is lit by TalkingHead's built-in
    // RoomEnvironment IBL, which reads better on skin than the default lights
    // (same setup as met4citizen's own realtime speech-to-speech demo).
    this.head = new TalkingHead(this._container, {
      ttsEndpoint: "N/A", // never used: speech comes from the s2s backend
      lipsyncModules: [], // never used: HeadAudio drives the visemes
      // Framing tuned by hand: close-up head-and-shoulders with ~7% headroom,
      // face centered (cameraX compensates the idle pose's slight lean). The
      // vertical FOV makes this framing hold across aspect ratios, so the same
      // values work for desktop and phones.
      cameraView: "upper", // options are: upper, full, but I haven't tested other options yet.
      cameraDistance: -1.4, // default -1.4 (highervalue=zoom in(eg: -2.4), lowervalue=zoom out (eg: -0.4))
      cameraY: 0, // default -0.15
      cameraX: 0, // default -0.18
      cameraRotateEnable: true, // default=false (setting it to default=true, enables orbit controls. click and hold down the left mouse button, then moving the mouse in a specific direction.)
      lightAmbientIntensity: 0,
      lightDirectIntensity: 0,
      lightSpotIntensity: 0,
      // modelPixelRatio is multiplied by devicePixelRatio internally — leave
      // it at 1 or retina displays get a 4x drawing buffer.
      avatarIdleEyeContact: 1, // default 0.3
      avatarSpeakingEyeContact: 1, // default 0.7
    });

    await this.head.showAvatar(
      {
        url: opt.avatarUrl ?? "/avatars/brunette.glb",
        body: opt.body ?? "F",
        avatarMood: "neutral",
      },
      opt.onprogress ?? null,
    );

    await this._initLipsync();
  }

  async _initLipsync() {
    const head = /** @type {TalkingHead} */ (this.head);
    await head.audioCtx.audioWorklet.addModule(HEADAUDIO_WORKLET_URL);
    const headaudio = new HeadAudio(head.audioCtx);
    await headaudio.loadModel(HEADAUDIO_MODEL_URL);

    // Tap the speech path for viseme detection. The audible path continues
    // through TalkingHead's own graph untouched.
    head.audioSpeechGainNode.connect(headaudio);

    // Detected visemes → morph targets, applied inside the render loop.
    headaudio.onvalue = (key, value) => {
      const mt = head.mtAvatar?.[key];
      if (mt) Object.assign(mt, { newvalue: value, needsUpdate: true });
    };
    head.opt.update = headaudio.update.bind(headaudio);

    // Utterance boundaries: after a real pause, re-engage the user — eye
    // contact plus conversational hand movement (same trick as the demo).
    headaudio.onended = () => {
      this._lastSpeechEnded = Date.now();
    };
    headaudio.onstarted = () => {
      if (Date.now() - this._lastSpeechEnded > 150) {
        head.lookAtCamera(500);
        head.speakWithHands();
      }
    };

    this._headaudio = headaudio;
  }

  /** The shared AudioContext everything (mic, playback, lip-sync) runs on. */
  get audioCtx() {
    return this.head?.audioCtx ?? null;
  }

  /** Where the s2s client should route the TTS playback signal. */
  get voiceSink() {
    return this.head?.audioAnalyzerNode ?? null;
  }

  /** Resume audio + animation from within a user gesture (iOS requirement). */
  resume() {
    this.head?.start();
    if (this.head && this.head.audioCtx.state === "suspended") {
      this.head.audioCtx.resume().catch(() => {});
    }
  }

  /**
   * Conversation-state choreography. Statuses come from the s2s client.
   * @param {string} status
   */
  setConversationState(status) {
    const head = this.head;
    if (!head) return;
    switch (status) {
      case "user-speaking":
        // The user started talking (this is also the barge-in moment — the
        // playback buffer was just cleared, so HeadAudio hears silence and
        // the mouth settles on its own). Give them the avatar's attention.
        head.isSpeaking = false;
        head.lookAtCamera(800);
        break;
      case "ai-speaking":
        head.isSpeaking = true;
        break;
      case "processing":
        head.isSpeaking = false;
        break;
      case "closed":
      case "error":
      case "idle":
        head.isSpeaking = false;
        head.stopGesture(300);
        break;
      default:
        head.isSpeaking = false;
    }
  }

  /**
   * Execute an avatar-control tool called by the model.
   * @param {string} name @param {Record<string, unknown>} args
   * @returns {string | null} Result text for the model, or null if `name`
   *   isn't an avatar tool.
   */
  runTool(name, args) {
    const head = this.head;
    if (!head) return null;
    if (name === "set_mood") {
      const mood = typeof args.mood === "string" ? args.mood : "";
      if (!AVATAR_MOODS.includes(mood)) return `Unknown mood: ${mood}`;
      head.setMood(mood);
      return `Mood set to ${mood}.`;
    }
    if (name === "make_hand_gesture") {
      const gesture = typeof args.gesture === "string" ? args.gesture : "";
      if (!AVATAR_GESTURES.includes(gesture)) return `Unknown gesture: ${gesture}`;
      head.playGesture(gesture, 3);
      return `Playing gesture ${gesture}.`;
    }
    if (name === "make_facial_expression") {
      const emoji = typeof args.emoji === "string" ? args.emoji.trim() : "";
      if (!emoji) return "No emoji given.";
      head.speakEmoji(emoji);
      return `Expressing ${emoji}.`;
    }
    return null;
  }

  /**
   * What the loaded avatar is actually made of, for the "Avatar parts" panel.
   * Read straight off the TalkingHead instance and wrapped defensively: the
   * internals are version-dependent and a missing field must never break boot.
   * @returns {{ groups: { title: string, items: { name: string, kind: string }[] }[] }}
   */
  listParts() {
    const head = this.head;
    if (!head) return { groups: [] };

    /** @type {{name: string, kind: string}[]} */
    const bones = [];
    /** @type {{name: string, kind: string}[]} */
    const meshes = [];
    try {
      const root = head.avatar ?? head.avatarRoot ?? null;
      root?.traverse?.((/** @type {any} */ o) => {
        if (!o?.name) return;
        if (o.isBone) bones.push({ name: o.name, kind: "bone" });
        else if (o.isSkinnedMesh || o.isMesh) meshes.push({ name: o.name, kind: "mesh" });
      });
    } catch {
      // The avatar hierarchy is a nicety; never let it throw into boot.
    }

    /** @type {{name: string, kind: string}[]} */
    const morphs = [];
    try {
      for (const key of Object.keys(head.mtAvatar ?? {})) {
        morphs.push({ name: key, kind: "morph" });
      }
    } catch {
      // ignored
    }

    const groups = /** @type {{title: string, items: {name: string, kind: string}[]}[]} */ ([]);
    if (morphs.length) groups.push({ title: "Morph targets", items: morphs });
    if (bones.length) groups.push({ title: "Bones", items: bones });
    if (meshes.length) groups.push({ title: "Meshes", items: meshes });
    return { groups };
  }
}
