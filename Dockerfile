# Single container: Bun serves the bundled front-end AND the /api/session
# proxy. HF Spaces (sdk: docker) routes traffic to app_port, set to 7860.
FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
ENV PORT=7860
# Point at a speech-to-speech backend by setting ONE of these in the Space
# settings (index.ts prefers LOAD_BALANCER_URL):
#   LOAD_BALANCER_URL  a load balancer's base URL (a secret) — talks to the pool directly
#   SESSION_PROXY_URL  another deployment's /api to piggyback (e.g. a public demo Space)
# With neither set, the app runs in direct mode (paste a ws:// URL in Settings).
#
# Atrium: precise finger/body/face tracking needs the MediaPipe assets, which are
# NOT committed. Bake them in with:
#   RUN python3 download_vision_assets.py || true
# Without them Atrium still runs — the eyes fall back to motion tracking and
# real camera frames, and /lab reports exactly what is available.

EXPOSE 7860

USER bun

CMD ["bun", "index.ts"]
