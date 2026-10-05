// @ts-nocheck
/**
 * CameraEye — the physical eye.
 *
 * Owns exactly one `getUserMedia` video stream and hands out JPEG snapshots of
 * it on demand. Nothing here knows about the model, the realtime protocol, or
 * landmarks: it is the one place that talks to the webcam, so the camera light
 * turns on once and only when we actually want it on.
 *
 * Snapshots are taken into a reused offscreen canvas at a capped width — a
 * 4K webcam frame encoded to a data URL can be several megabytes of base64,
 * which is far more than a local model (or this browser) wants to push through
 * a WebSocket. `maxWidth` is the knob that keeps that under control.
 *
 * Emits: `started`, `stopped`, `devices`, `error`.
 */

/** @typedef {any} MediaStream */
/** @typedef {any} HTMLVideoElement */

/**
 * @typedef {Object} Snapshot
 * @property {string} dataUrl `data:image/jpeg;base64,...`
 * @property {number} width
 * @property {number} height
 * @property {number} bytes Approximate payload size (base64 characters).
 * @property {number} takenAt `performance.now()` timestamp.
 */

const DEFAULT_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 60 },
};

export class CameraEye extends EventTarget {
  constructor() {
    super();
    /** @type {MediaStream | null} */
    this.stream = null;
    /** @type {HTMLVideoElement | null} */
    this.video = null;
    /** @type {string} */
    this.deviceId = "";
    this.label = "";
    /** @type {MediaDeviceInfo[]} */
    this.devices = [];
    /** @type {string | null} */
    this.error = null;
    /** Mirror the image so "left" means the same to the user and the model. */
    this.mirror = true;
    this._starting = null;
    this._canvas = null;
    this._ctx = null;
    this._frameCanvas = null;
    this._frameCtx = null;
    this._frameCounter = 0;
    this._lastFrameTime = 0;
    /** Measured frames-per-second of the incoming video, surfaced in the HUD. */
    this.fps = 0;
  }

  get ready() {
    return Boolean(this.stream && this.video && this.video.readyState >= 2 && this.video.videoWidth > 0);
  }

  get width() {
    return this.video?.videoWidth ?? 0;
  }

  get height() {
    return this.video?.videoHeight ?? 0;
  }

  /** Populate `this.devices` with the video inputs the browser can see.
   *  Labels are only populated after permission has been granted once. */
  async refreshDevices() {
    try {
      const all = (await navigator.mediaDevices.enumerateDevices()) ?? [];
      this.devices = all.filter((d) => d.kind === "videoinput");
      this.dispatchEvent(new CustomEvent("devices", { detail: { devices: this.devices } }));
    } catch {
      this.devices = [];
    }
    return this.devices;
  }

  /**
   * Open the camera. Safe to call twice — an in-flight start is shared, and a
   * start with a different device tears the old stream down first.
   * @param {{ deviceId?: string, width?: number, height?: number, frameRate?: number }} [opt]
   */
  async start(opt = {}) {
    if (this._starting) {
      await this._starting;
      // A different device was requested while we were busy opening the old
      // one: fall through and reopen.
      if (!opt.deviceId || opt.deviceId === this.deviceId) return this.stream;
    }

    if (this.stream && opt.deviceId && opt.deviceId !== this.deviceId) this.stop();

    this._starting = (async () => {
      const video = /** @type {HTMLVideoElement} */ (document.createElement("video"));
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;

      /** @type {any} */
      const constraints = {
        audio: false,
        video: { ...DEFAULT_CONSTRAINTS },
      };
      if (opt.width) constraints.video.width = { ideal: opt.width };
      if (opt.height) constraints.video.height = { ideal: opt.height };
      if (opt.frameRate) constraints.video.frameRate = { ideal: opt.frameRate, max: 60 };
      if (opt.deviceId) constraints.video.deviceId = { exact: opt.deviceId };

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        // `exact` deviceId fails when the device vanished (unplugged webcam).
        // Retry without it so a missing camera degrades to "any camera".
        if (opt.deviceId) {
          try {
            delete constraints.video.deviceId;
            stream = await navigator.mediaDevices.getUserMedia(constraints);
          } catch (err2) {
            throw err2;
          }
        } else {
          throw err;
        }
      }

      video.srcObject = stream;
      await video.play().catch(() => {});
      // Wait for real dimensions: a snapshot taken before the first frame
      // decodes is a blank (or zero-sized) image.
      await new Promise((resolve) => {
        if (video.readyState >= 2 && video.videoWidth > 0) return resolve(null);
        const done = () => {
          video.removeEventListener("loadedmetadata", done);
          resolve(null);
        };
        video.addEventListener("loadedmetadata", done);
        setTimeout(done, 4000);
      });

      this.stream = stream;
      this.video = video;
      this.deviceId = stream.getVideoTracks()[0]?.getSettings?.().deviceId ?? opt.deviceId ?? "";
      this.label = stream.getVideoTracks()[0]?.label ?? "";
      this.error = null;

      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        this.error = "Camera disconnected.";
        this.dispatchEvent(new CustomEvent("error", { detail: { error: new Error(this.error) } }));
        this.stop();
      });

      await this.refreshDevices();
      this.dispatchEvent(new CustomEvent("started", { detail: { stream, video } }));
      return stream;
    })();

    try {
      return await this._starting;
    } catch (err) {
      this.error = describeCameraError(err);
      this.dispatchEvent(new CustomEvent("error", { detail: { error: new Error(this.error) } }));
      throw new Error(this.error);
    } finally {
      this._starting = null;
    }
  }

  stop() {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.stream = null;
    this.fps = 0;
    this.dispatchEvent(new CustomEvent("stopped"));
  }

  /**
   * Attach the live stream to a visible element (the self-view).
   * @param {HTMLVideoElement} el
   */
  attach(el) {
    if (!el) return;
    el.srcObject = this.stream;
    el.playsInline = true;
    el.muted = true;
    void el.play().catch(() => {});
  }

  /**
   * Draw the live frame into a canvas at (at most) `maxWidth`, mirrored when
   * the eye is set to mirror. One canvas is reused for every consumer — the
   * landmark tracker, the overlay and the snapshot encoder — so "left" means
   * the same thing everywhere and we never allocate per frame.
   *
   * @param {{ maxWidth?: number, mirror?: boolean }} [opt]
   * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D } | null}
   */
  renderFrame(opt = {}) {
    const video = this.video;
    if (!video || !this.ready) return null;

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const maxWidth = Math.max(96, opt.maxWidth ?? 640);
    const scale = Math.min(1, maxWidth / srcW);
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    if (!this._frameCanvas) {
      this._frameCanvas = document.createElement("canvas");
      this._frameCtx = this._frameCanvas.getContext("2d", { willReadFrequently: true });
    }
    const canvas = /** @type {HTMLCanvasElement} */ (this._frameCanvas);
    const ctx = /** @type {CanvasRenderingContext2D} */ (this._frameCtx);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const mirror = opt.mirror ?? this.mirror;
    ctx.save();
    if (mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    return { canvas, ctx };
  }

  /**
   * Grab the current frame as a JPEG data URL.
   * @param {{ maxWidth?: number, quality?: number, mirror?: boolean }} [opt]
   * @returns {Snapshot | null}
   */
  capture(opt = {}) {
    const rendered = this.renderFrame(opt);
    if (!rendered) return null;
    const { canvas } = rendered;
    const w = canvas.width;
    const h = canvas.height;

    const quality = clamp(opt.quality ?? 0.6, 0.1, 0.95);
    let dataUrl = "";
    try {
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    } catch {
      return null;
    }

    // Cheap FPS meter: count decoded frames between snapshots.
    const now = performance.now();
    if (this._lastFrameTime) {
      const dt = now - this._lastFrameTime;
      if (dt > 0) {
        const inst = 1000 / dt;
        this.fps = this.fps ? this.fps * 0.8 + inst * 0.2 : inst;
      }
    }
    this._lastFrameTime = now;
    this._frameCounter++;

    return { dataUrl, width: w, height: h, bytes: dataUrl.length, takenAt: now };
  }

  /**
   * Raw pixels for the motion tracker — a tiny downscale, mirrored to match
   * everything else so "moved left" matches what the user sees.
   * @param {number} w
   * @param {number} h
   * @param {{ mirror?: boolean }} [opt]
   * @returns {ImageData | null}
   */
  grabPixels(w, h, opt = {}) {
    const video = this.video;
    if (!video || !this.ready) return null;
    if (!this._canvas) {
      this._canvas = document.createElement("canvas");
      this._ctx = this._canvas.getContext("2d", { willReadFrequently: true });
    }
    const canvas = /** @type {HTMLCanvasElement} */ (this._canvas);
    const ctx = /** @type {CanvasRenderingContext2D} */ (this._ctx);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const mirror = opt.mirror ?? this.mirror;
    ctx.save();
    if (mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
    return ctx.getImageData(0, 0, w, h);
  }
}

/**
 * Turn the browser's terse `getUserMedia` failures into something a person can
 * act on — the two common ones are a blocked permission prompt and a laptop
 * whose webcam is already held by another app.
 * @param {unknown} err
 */
export function describeCameraError(err) {
  const name = /** @type {any} */ (err)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera blocked. Allow camera access for this site in your browser, then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera found. Plug one in (or pick a different device) and try again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The camera is busy or unreadable. Close any other app using it and try again.";
  }
  if (name === "NotSupportedError") {
    return "This browser cannot open a camera here. Use https:// or localhost.";
  }
  return `Could not open the camera: ${/** @type {any} */ (err)?.message ?? err}`;
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
