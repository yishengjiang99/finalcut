// @vitest-environment node
// Global JSON limit is 1 MB; only chat (thumbnails) and caption translation get larger limits.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { jsonBodyParser, LARGE_JSON_ROUTES } from '../server/bodyLimits.js';
import { MAX_THUMBNAILS, MAX_THUMBNAIL_BYTES } from '../server/clientExecution.js';

let base, server;
beforeAll(async () => {
  const app = express();
  app.use(jsonBodyParser());
  app.post('*', (req, res) => res.json({ keys: Object.keys(req.body || {}).length }));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const mb = (n) => 'x'.repeat(Math.round(n * 1024 * 1024));

describe('JSON body limits', () => {
  it('small bodies work everywhere', async () => {
    expect((await post('/api/create-checkout-session', { priceId: 'p' })).status).toBe(200);
  });
  it('rejects > 1 MB on ordinary routes (413)', async () => {
    for (const p of ['/api/create-checkout-session', '/api/verify-checkout-session', '/api/auth/mobile/apple-iap', '/api/push/register', '/api/ffmpeg-cli']) {
      expect((await post(p, { pad: mb(1.5) })).status).toBe(413);
    }
  });
  it('chat accepts the largest thumbnail payload clients send, plus history', async () => {
    const thumb = Buffer.alloc(MAX_THUMBNAIL_BYTES, 7).toString('base64');
    const body = { messages: [{ role: 'user', content: mb(2) }], thumbnails: Array(MAX_THUMBNAILS).fill(thumb) };
    expect((await post('/api/chat', body)).status).toBe(200);
    expect((await post('/api/v2/chat', body)).status).toBe(200);
  });
  it('chat still has a ceiling', async () => {
    expect((await post('/api/chat', { pad: mb(17) })).status).toBe(413);
  });
  it('caption translation accepts multi-MB caption tracks', async () => {
    expect((await post('/api/translate-captions', { srt: mb(5) })).status).toBe(200);
    expect((await post('/api/streaming-captions/translate', { segments: mb(5) })).status).toBe(200);
  });
  it('only those routes are raised', () => {
    expect(Object.keys(LARGE_JSON_ROUTES).sort()).toEqual(['/api/chat', '/api/streaming-captions/translate', '/api/translate-captions', '/api/v2/chat']);
  });
  it('server.js uses it instead of the old 950 MB global parser', () => {
    const src = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
    expect(src).toContain('app.use(jsonBodyParser())');
    expect(src).not.toMatch(/express\.json\(\{\s*limit:\s*'950mb'/);
  });
});
