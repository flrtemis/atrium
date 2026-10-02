/**
 * Orbit local bridge
 *
 * The browser only speaks to this same-origin server. The server, in turn,
 * talks to an Ollama daemon on the same machine so an installed Orbit build
 * never needs a cloud API key or a public endpoint.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 1_500_000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request exceeds the local bridge limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function ollama(pathname, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    return await fetch(`${OLLAMA_HOST}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health' && req.method === 'GET') {
    try {
      const response = await ollama('/api/tags');
      if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
      const tags = await response.json();
      const models = (tags.models || []).map((item) => item.name);
      return sendJson(res, 200, { online: true, host: 'local', models, requestedModel: 'gemma4:31b' });
    } catch (error) {
      return sendJson(res, 200, {
        online: false,
        host: 'local',
        models: [],
        requestedModel: 'gemma4:31b',
        reason: 'Ollama is not reachable on this device.'
      });
    }
  }

  if (url.pathname === '/api/models' && req.method === 'GET') {
    try {
      const response = await ollama('/api/tags');
      const data = await response.json();
      return sendJson(res, response.status, data);
    } catch (error) {
      return sendJson(res, 503, { error: 'Local Ollama is unavailable.' });
    }
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || '{}');
      const messages = Array.isArray(payload.messages) ? payload.messages.slice(-20) : [];
      const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : 'gemma4:31b';

      if (!messages.length) {
        return sendJson(res, 400, { error: 'A message is required.' });
      }

      const response = await ollama('/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature: 0.55,
            num_ctx: 8192
          }
        })
      });
      const text = await response.text();
      const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
      return send(res, response.status, text, { 'Content-Type': contentType });
    } catch (error) {
      const detail = error.name === 'AbortError'
        ? 'The local model took too long to respond.'
        : 'Could not reach the local Ollama daemon.';
      return sendJson(res, 503, { error: detail });
    }
  }

  return sendJson(res, 404, { error: 'Unknown local API route.' });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const normalized = path.normalize(requested).replace(/^([/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': /\.(png|jpg|jpeg|svg|ico)$/.test(filePath) ? 'public, max-age=604800, immutable' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Orbit is available at http://${HOST}:${PORT}`);
  console.log(`Using a local Ollama bridge at ${OLLAMA_HOST}`);
});
