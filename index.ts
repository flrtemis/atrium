/**
 * Atrium — realtime voice chat with a 3D talking-head avatar that can see you.
 *
 * Same AI stack as gemma-avatar / the smolagents hf-realtime-voice Space
 * (silero-VAD → parakeet STT → Gemma on Ollama → Qwen3-TTS, spoken over the
 * OpenAI Realtime WebSocket protocol), with the orb replaced by a TalkingHead
 * 3D avatar with real-time audio-driven lip-sync (HeadAudio) — plus Atrium's
 * addition, a live webcam perception loop whose observations are fed into the
 * very same conversation.
 *
 * The browser never sees the speech-to-speech backend address: it POSTs the
 * same-origin `/api/session`, we forward the handshake server-side, and only
 * the per-session compute `connect_url` the backend hands back reaches the
 * client (which must dial it directly).
 *
 * Backend selection (first match wins):
 *   LOAD_BALANCER_URL   – a speech-to-speech load balancer (`<lb>/session`).
 *   SESSION_PROXY_URL   – another deployment's session API to piggyback on,
 *                         e.g. https://smolagents-hf-realtime-voice.hf.space/api
 *                         (handy for development; it is metered + queued).
 *   (neither)           – direct mode: the user pastes a realtime WS URL in
 *                         Settings and the browser dials it, no proxy.
 */

import index from "./index.html";
import lab from "./index-lab.html";

const LOAD_BALANCER_URL = (Bun.env.LOAD_BALANCER_URL ?? "").trim().replace(/\/$/, "");
const SESSION_PROXY_URL = (Bun.env.SESSION_PROXY_URL ?? "").trim().replace(/\/$/, "");
const UPSTREAM = LOAD_BALANCER_URL || SESSION_PROXY_URL;
const PORT = Number(Bun.env.PORT ?? 3000);

/**
 * The upstream (Space proxy mode) meters anonymous users by cookie. Pass each
 * visitor's cookies through both ways so every browser keeps its own identity
 * and daily budget upstream — a shared server-side jar would fold all visitors
 * into one anonymous user.
 */
function sanitizeSetCookie(sc: string): string {
  // The upstream's cookie must re-bind to OUR host, so drop any Domain attr.
  return sc
    .split(";")
    .map((p) => p.trim())
    .filter((p) => !/^domain=/i.test(p))
    .join("; ");
}

/** Forward a JSON call upstream with the visitor's cookies; relay the JSON
 *  body, status, and (re-bound) cookies back — never other upstream headers. */
async function proxy(path: string, req: Request, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("Cookie", cookie);
  const resp = await fetch(`${UPSTREAM}${path}`, { ...init, headers });
  const body = await resp.text();
  const out = new Response(body, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
  const setCookies =
    resp.headers.getSetCookie?.() ??
    (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie") as string] : []);
  for (const sc of setCookies) out.headers.append("Set-Cookie", sanitizeSetCookie(sc));
  return out;
}

/**
 * Serve a file out of `public/`. `rel` may contain slashes (the MediaPipe wasm
 * and models live in nested directories), so every segment is normalised and
 * any attempt to climb out of the directory is rejected outright.
 */
function staticFile(rel: string): Response {
  const clean = rel
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
  if (!clean || clean.includes("\0")) return new Response("Not found", { status: 404 });
  const file = Bun.file(`${import.meta.dir}/public/${clean}`);
  // A missing file must be a 404, not the 500 that handing a non-existent
  // BunFile to Response() produces.
  if (!file.size) return new Response("Not found", { status: 404 });
  return new Response(file);
}

/**
 * Path under `public/vendor/` for this request, taken from the URL rather than
 * from route params: the MediaPipe assets are served from nested directories
 * and Bun does not expose a multi-segment wildcard under a stable param name.
 */
function vendorRel(req: Request): string {
  const pathname = new URL(req.url).pathname;
  return `vendor/${pathname.slice("/vendor/".length)}`;
}

/** Correct MIME types for the MediaPipe runtime, which Bun would otherwise
 *  guess from the extension (a `.task` model or a `.wasm` binary served as
 *  text/octet-stream will not load). */
const MIME: Record<string, string> = {
  ".wasm": "application/wasm",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".task": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function staticFileTyped(rel: string): Response {
  const resp = staticFile(rel);
  const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
  if (MIME[ext]) resp.headers.set("Content-Type", MIME[ext]);
  return resp;
}

/**
 * Does the machine have the landmark models installed? The front-end asks this
 * once so it can tell the user, in plain words, whether finger counting will
 * work or whether they should run `download_vision_assets.py`.
 */
async function visionAssets() {
  const base = `${import.meta.dir}/public/vendor/mediapipe`;
  const check = async (p: string) => Bun.file(`${base}/${p}`).exists();
  const [bundle, wasm, hands, pose, face] = await Promise.all([
    check("vision_bundle.mjs"),
    check("wasm/vision_wasm_internal.wasm"),
    check("models/hand_landmarker.task"),
    check("models/pose_landmarker_lite.task"),
    check("models/face_landmarker.task"),
  ]);
  return {
    installed: bundle && wasm && hands,
    bundle,
    wasm,
    models: { hands, pose, face },
    hint: bundle && wasm ? "" : "python3 download_vision_assets.py",
  };
}

const server = Bun.serve({
  port: PORT,
  routes: {
    "/": index,

    // Atrium: the Camera Lab — the whole vision pipeline, no model required.
    "/lab": lab,

    "/api/config": {
      GET: () =>
        Response.json({
          lb: Boolean(UPSTREAM),
          allowDirect: !UPSTREAM,
        }),
    },

    "/api/vision-assets": {
      GET: async () => Response.json(await visionAssets()),
    },

    "/api/session": {
      POST: async (req) => {
        if (!UPSTREAM) return Response.json({ error: "Not configured." }, { status: 404 });
        try {
          return await proxy("/session", req, { method: "POST", body: "{}" });
        } catch (err) {
          console.warn("session handshake failed:", err);
          return Response.json({ error: "Speech service unreachable." }, { status: 502 });
        }
      },
    },

    "/api/queue/:id": {
      GET: async (req) => {
        if (!UPSTREAM) return Response.json({ error: "Not configured." }, { status: 404 });
        try {
          return await proxy(`/queue/${encodeURIComponent(req.params.id)}`, req);
        } catch {
          return Response.json({ error: "Speech service unreachable." }, { status: 502 });
        }
      },
      DELETE: async (req) => {
        if (!UPSTREAM) return Response.json({ error: "Not configured." }, { status: 404 });
        try {
          return await proxy(`/queue/${encodeURIComponent(req.params.id)}`, req, { method: "DELETE" });
        } catch {
          return Response.json({ error: "Speech service unreachable." }, { status: 502 });
        }
      },
    },

    // Runtime-loaded assets that must NOT go through the bundler:
    // AudioWorklet modules, the HeadAudio viseme model, the avatar GLB, and
    // (Atrium) the MediaPipe wasm runtime + landmark models.
    "/worklets/:name": (req) => staticFileTyped(`worklets/${req.params.name}`),
    "/vendor/:name": (req) => staticFileTyped(vendorRel(req)),
    "/vendor/*": (req) => staticFileTyped(vendorRel(req)),
    "/avatars/:name": (req) => staticFileTyped(`avatars/${req.params.name}`),
  },

  development:
    Bun.env.NODE_ENV === "production"
      ? false
      : {
          hmr: true,
          console: true,
        },
});

console.log(`atrium listening on ${server.url}`);
console.log(
  UPSTREAM
    ? `session backend: ${LOAD_BALANCER_URL ? "load balancer" : "session proxy"} (${UPSTREAM})`
    : "session backend: none — direct mode (set LOAD_BALANCER_URL or SESSION_PROXY_URL)",
);
