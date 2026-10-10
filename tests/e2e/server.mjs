#!/usr/bin/env node
// Static test server for the /v2 editor. Mirrors nginx/finalcut-v2.locations.conf:
//   - /v2/*  -> dist/v2 with COOP/COEP/CORP (unless ISOLATE=0, which forces the st fallback)
//   - .wasm  -> application/wasm
//   - /legal/* -> public/legal (no isolation headers, like production)
// Usage: PORT=4173 ISOLATE=1 node tests/e2e/server.mjs
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V2_DIR = path.join(ROOT, 'dist', 'v2');
const LEGAL_DIR = path.join(ROOT, 'public', 'legal');
const PORT = Number(process.env.PORT || 4173);
const ISOLATE = process.env.ISOLATE !== '0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function serveFile(req, res, file, extraHeaders) {
  const st = statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'X-Content-Type-Options': 'nosniff',
    // Versioned core files are immutable (same as the nginx snippet); everything else revalidates.
    'Cache-Control': file.includes(`${path.sep}ffmpeg-core${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...extraHeaders,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function resolveUnder(dir, rel) {
  const p = path.normalize(path.join(dir, rel));
  return p.startsWith(dir + path.sep) || p === dir ? p : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  if (p === '/v2') return send(res, 301, '', { Location: '/v2/' + url.search });
  if (p.startsWith('/v2/')) {
    const headers = ISOLATE ? ISOLATION : {};
    let file = resolveUnder(V2_DIR, p.slice('/v2/'.length) || 'index.html');
    if (file && existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (file && existsSync(file)) return serveFile(req, res, file, headers);
    if (!path.extname(p)) return serveFile(req, res, path.join(V2_DIR, 'index.html'), headers); // SPA fallback
    return send(res, 404, 'not found', headers);
  }
  if (p.startsWith('/legal/')) {
    const file = resolveUnder(LEGAL_DIR, p.slice('/legal/'.length));
    if (file && existsSync(file) && statSync(file).isFile()) return serveFile(req, res, file, {});
  }
  return send(res, 404, 'not found');
});

if (!existsSync(path.join(V2_DIR, 'index.html'))) {
  console.error('dist/v2 is missing; run `npm run build:v2` first');
  process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => console.log(`v2 test server on http://127.0.0.1:${PORT} isolate=${ISOLATE}`));
