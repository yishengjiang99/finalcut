import { describe, it, expect } from 'vitest';
import express from 'express';
import { createFilmcraftVoiceRouter } from '../server/filmcraftVoice.js';
const request = (a) => ({ get: async (path) => {
  const srv = a.listen(0); await new Promise(r => srv.once('listening', r));
  try { const res = await fetch(`http://127.0.0.1:${srv.address().port}${path}`); return { status: res.status, body: await res.json().catch(() => ({})) }; }
  finally { srv.close(); } } });
const app = (env, fetchImpl) => express().use(createFilmcraftVoiceRouter({ env, fetchImpl }));
describe('GET /api/filmcraft/voice/token', () => {
  it('503 when not configured', async () => {
    expect((await request(app({})).get('/api/filmcraft/voice/token')).status).toBe(503);
    expect((await request(app({ ELEVENLABS_API_KEY: 'k', FILMCRAFT_VOICE_AGENT_ID: 'a', FILMCRAFT_VOICE_DISABLED: 'true' })).get('/api/filmcraft/voice/token')).status).toBe(503);
  });
  it('returns the signed url, never the key', async () => {
    let seen;
    const r = await request(app({ ELEVENLABS_API_KEY: 'secret', FILMCRAFT_VOICE_AGENT_ID: 'ag1' }, async (u, o) => { seen = [u, o];
      return { ok: true, json: async () => ({ signed_url: 'wss://x/y?token=t' }) }; })).get('/api/filmcraft/voice/token');
    expect(r.status).toBe(200); expect(r.body.signedUrl).toBe('wss://x/y?token=t');
    expect(seen[0]).toContain('agent_id=ag1'); expect(JSON.stringify(r.body)).not.toContain('secret');
  });
  it('502 on upstream failure', async () => {
    const r = await request(app({ ELEVENLABS_API_KEY: 'k', FILMCRAFT_VOICE_AGENT_ID: 'a' }, async () => ({ ok: false, status: 401 }))).get('/api/filmcraft/voice/token');
    expect(r.status).toBe(502);
  });
});
