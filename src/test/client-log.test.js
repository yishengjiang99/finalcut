// @vitest-environment node
// POST /api/client-log: authenticated, rate limited, size capped; writes sanitized technical events as
// `client-log {json}` lines and never audio, transcript text, tokens or keys.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { clientLogRouter, _setClientLogSink, _clientLogLimiterForTests, sanitizeEvent, CLIENT_LOG_MAX_BYTES } from '../server/clientLog.js';
import { issueSampleAccessToken } from '../server/middleware.js';

let server; let base; let token; let lines;
beforeAll(async () => {
  const app = express();
  app.use(clientLogRouter);
  app.use(express.json({ limit: '950mb' }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { _setClientLogSink(); await new Promise((r) => server.close(r)); });
beforeEach(async () => {
  for (const key of ['127.0.0.1', '::ffff:127.0.0.1']) await _clientLogLimiterForTests.resetKey(key);
  token = issueSampleAccessToken();
  lines = [];
  _setClientLogSink((l) => lines.push(l));
});
const post = (body, headers = { 'sample-access-token': token }, raw) => fetch(`${base}/api/client-log`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari', ...headers }, body: raw ?? JSON.stringify(body),
});
const parsed = () => lines.map((l) => { expect(l.startsWith('client-log ')).toBe(true); return JSON.parse(l.slice('client-log '.length)); });

describe('POST /api/client-log', () => {
  it('writes one greppable structured line per event, with the session id, user agent and the technical fields', async () => {
    const res = await post({ sid: 'abc123_XYZ-1', events: [
      { ev: 'ws_close', ms: 1234, code: 1006, reason: '', clean: false },
      { ev: 'decode_end', ms: 2200, dur: 812, samples: 960000, ok: true },
    ] });
    expect(res.status).toBe(204);
    const out = parsed();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ sid: 'abc123_XYZ-1', i: 0, ev: 'ws_close', code: 1006, clean: false, ms: 1234 });
    expect(out[0].ua).toContain('iPhone');
    expect(out[1]).toMatchObject({ ev: 'decode_end', samples: 960000, ok: true });
    expect(out[1].ua).toBeUndefined();
  });

  it('401 without credentials; nothing is logged', async () => {
    const res = await post({ sid: 'abc123_XYZ-1', events: [{ ev: 'x' }] }, {});
    expect(res.status).toBe(401);
    expect(lines).toEqual([]);
  });

  it('400 without a valid session id or events', async () => {
    expect((await post({ events: [{ ev: 'x' }] })).status).toBe(400);
    expect((await post({ sid: 'bad sid!!', events: [{ ev: 'x' }] })).status).toBe(400);
    expect((await post({ sid: 'abc123_XYZ-1', events: [] })).status).toBe(400);
    expect(lines).toEqual([]);
  });

  it('413 over the size cap, and the body never reaches the log', async () => {
    const big = { sid: 'abc123_XYZ-1', events: [{ ev: 'x', note: 'a'.repeat(CLIENT_LOG_MAX_BYTES) }] };
    const res = await post(big);
    expect(res.status).toBe(413);
    expect(lines).toEqual([]);
  });

  it('never logs content or credentials: blocked keys are dropped, credential-looking values are redacted', async () => {
    const secret = 'sutkn_0123456789abcdefghijklmnopqrstuvwxyz';
    await post({ sid: 'abc123_XYZ-1', events: [{
      ev: 'probe', token: secret, text: 'hello my friend', transcript: 'secret words', audio_base_64: 'AAAA', authorization: 'Bearer abc',
      'xi-api-key': 'k', translation: '你好', headers: 'x', err: `Failed to open wss://x?token=${secret}`, note: 'Bearer abcdef', ok: true, nested: { a: 1 },
    }] });
    const [e] = parsed();
    expect(Object.keys(e).sort()).toEqual(['err', 'ev', 'i', 'note', 'ok', 'sid', 'u', 'ua'].filter(k => k in e).sort());
    expect(e.err).toBe('[redacted]');
    expect(e.note).toBe('[redacted]');
    const all = lines.join('\n');
    for (const bad of [secret, 'hello my friend', 'secret words', 'AAAA', '你好']) expect(all).not.toContain(bad);
  });

  it('caps events per request, bad event names are skipped, long strings are cut', async () => {
    const events = [{ ev: 'Bad Name!' }, { ev: 'ok_event', msg: 'ab '.repeat(200) }, ...Array.from({ length: 100 }, () => ({ ev: 'tick' }))];
    await post({ sid: 'abc123_XYZ-1', events });
    const out = parsed();
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.find(e => e.ev === 'ok_event').msg.length).toBe(120);
    expect(out.some(e => e.ev === 'Bad Name!')).toBe(false);
  });

  it('is rate limited', async () => {
    let last;
    for (let i = 0; i < 205; i++) last = await post({ sid: 'abc123_XYZ-1', events: [{ ev: 'tick' }] });
    expect(last.status).toBe(429);
  });

  it('sanitizeEvent keeps only simple values', () => {
    expect(sanitizeEvent({ ev: 'a', n: 1.23456789, s: 'x', b: true, o: {}, a: [] })).toEqual({ ev: 'a', n: 1.235, s: 'x', b: true });
    expect(sanitizeEvent({ nope: 1 })).toBeNull();
  });
});
