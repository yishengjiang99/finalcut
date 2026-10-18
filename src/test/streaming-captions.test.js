// @vitest-environment node
// Server side of streaming captions: single-use token mint (key never leaves the server), text-only
// translate batches (speech: no web search), and the consented server-burn fallback.
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import express from 'express';
import { promises as fs } from 'fs';
import { _setLyricCaptionsHooks } from '../server/lyricCaptions.js';
import {
  streamingCaptionsRouter, _setStreamingCaptionsHooks, _clearStreamingSessionsForTests, _limitersForTests,
  scribeWsUrl, SCRIBE_TOKEN_TTL_SEC, _mintScribeTokenForTests,
} from '../server/streamingCaptions.js';
import { issueSampleAccessToken, videoProcessLimiter, apiLimiter } from '../server/middleware.js';

const SECRET = 'xi-secret-key-that-must-never-leak';
let server; let base; let sampleToken; let corrected; let charges; let minted;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(streamingCaptionsRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  _setLyricCaptionsHooks(); _setStreamingCaptionsHooks();
  await new Promise((r) => server.close(r));
});
beforeEach(async () => {
  for (const limiter of [videoProcessLimiter, apiLimiter, _limitersForTests.tokenLimiter, _limitersForTests.translateLimiter]) {
    for (const key of ['127.0.0.1', '::ffff:127.0.0.1']) await limiter.resetKey(key);
  }
  sampleToken = issueSampleAccessToken();
  corrected = [];
  charges = 0;
  minted = 0;
  _clearStreamingSessionsForTests();
  _setStreamingCaptionsHooks({
    isConfigured: () => true,
    mintToken: async () => { minted += 1; return `sutkn_test_${minted}`; },
    charge: (req, res, next) => { charges += 1; next(); },
  });
  _setLyricCaptionsHooks({
    hasTranslateKey: () => true,
    probeHostTools: async () => ({ ffmpeg: true, ffprobe: true, assFilter: true, fontFamilies: new Set(['Noto Sans CJK SC']) }),
    probeMedia: async () => ({ format: { duration: 5 }, streams: [{ codec_type: 'video', width: 720, height: 1280 }, { codec_type: 'audio', codec_name: 'aac' }] }),
    burnAss: async ({ assPath, outputPath }) => { burnedAss = await fs.readFile(assPath, 'utf8'); await fs.writeFile(outputPath, 'BURNED'); },
    correct: async (args) => {
      corrected.push(args);
      return {
        parsed: { language: 'en', lines: args.lines.map((l, i) => ({ i, text: l.text, translation: `译:${l.text}` })) },
        usedWebSearch: false,
        model: 'test-model',
      };
    },
  });
});
let burnedAss = '';

const headers = (extra = {}) => ({ 'sample-access-token': sampleToken, 'Content-Type': 'application/json', ...extra });
const post = (p, body, h = headers()) => fetch(`${base}${p}`, { method: 'POST', headers: h, body: JSON.stringify(body ?? {}) });

describe('POST /api/streaming-captions/token', () => {
  it('mints a single-use token and returns the connection parameters, never the API key', async () => {
    const res = await post('/api/streaming-captions/token', { source_language: 'en' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      token: 'sutkn_test_1',
      expiresInSec: SCRIBE_TOKEN_TTL_SEC,
      wsUrl: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
      sampleRate: 16000,
      maxAudioSeconds: 600,
      query: { model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', include_timestamps: 'true', commit_strategy: 'manual', language_code: 'en' },
    });
    expect(typeof body.sessionId).toBe('string');
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(charges).toBe(0); // the edit is charged at the first translated batch, not at the token
  });

  it('503 streaming_captions_unavailable when ELEVENLABS_API_KEY is not set: nothing minted, nothing charged', async () => {
    _setStreamingCaptionsHooks({ isConfigured: () => false, mintToken: async () => { minted += 1; return 'x'; }, charge: (q, s, n) => { charges += 1; n(); } });
    const res = await post('/api/streaming-captions/token', {});
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'streaming_captions_unavailable', operation: 'streaming_captions' });
    expect(minted).toBe(0);
    expect(charges).toBe(0);
  });

  it('401 without credentials', async () => {
    const res = await post('/api/streaming-captions/token', {}, { 'Content-Type': 'application/json' });
    expect([401, 403]).toContain(res.status);
    expect(minted).toBe(0);
  });

  it('an unexpected mint failure is not charged', async () => {
    _setStreamingCaptionsHooks({
      isConfigured: () => true,
      mintToken: async () => { throw Object.assign(new Error('x'), { status: 503 }); },
      charge: (q, s, n) => { charges += 1; n(); },
    });
    const res = await post('/api/streaming-captions/token', {});
    expect(res.status).toBe(500); // a non-LyricCaptionsError from the mint
    expect(charges).toBe(0);
  });

  it('a resumed session (same user, previous sessionId) keeps its id and its charged flag: a new token, no new charge', async () => {
    const first = await (await post('/api/streaming-captions/token', {})).json();
    await post('/api/streaming-captions/translate', { target_language: 'es', sessionId: first.sessionId, segments: [{ i: 0, start: 0, end: 1, text: 'Hello' }] });
    expect(charges).toBe(1);
    const second = await (await post('/api/streaming-captions/token', { resumeSessionId: first.sessionId })).json();
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.token).not.toBe(first.token);
    await post('/api/streaming-captions/translate', { target_language: 'es', sessionId: second.sessionId, segments: [{ i: 0, start: 1, end: 2, text: 'again' }] });
    expect(charges).toBe(1);
    const other = await (await post('/api/streaming-captions/token', { resumeSessionId: 'unknown-session' })).json();
    expect(other.sessionId).not.toBe('unknown-session');
  });

  it('rate limits the token route', async () => {
    let last;
    for (let i = 0; i < 21; i++) last = await post('/api/streaming-captions/token', {});
    expect(last.status).toBe(429);
    expect(minted).toBe(20);
  });

  it('status says whether the flow is configured', async () => {
    const ok = await fetch(`${base}/api/streaming-captions/status`, { headers: headers() });
    expect(await ok.json()).toMatchObject({ available: true, provider: 'elevenlabs', model: 'scribe_v2_realtime' });
    _setStreamingCaptionsHooks({ isConfigured: () => false });
    expect((await (await fetch(`${base}/api/streaming-captions/status`, { headers: headers() })).json()).available).toBe(false);
    _setStreamingCaptionsHooks({ isConfigured: () => true });
    _setLyricCaptionsHooks({ hasTranslateKey: () => false });
    expect((await (await fetch(`${base}/api/streaming-captions/status`, { headers: headers() })).json()).available).toBe(false);
  });

  it('scribeWsUrl follows the configured https base only', () => {
    expect(scribeWsUrl({})).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
    expect(scribeWsUrl({ ELEVENLABS_API_BASE: 'https://api.us.elevenlabs.io/' })).toBe('wss://api.us.elevenlabs.io/v1/speech-to-text/realtime');
    expect(scribeWsUrl({ ELEVENLABS_API_BASE: 'http://evil.example' })).toBe('wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  });
});

describe('POST /api/streaming-captions/translate', () => {
  const segments = [
    { i: 0, start: 0.2, end: 2.0, text: 'Hello my friend' },
    { i: 1, start: 2.1, end: 4.0, text: 'How are you today' },
  ];

  it('translates a batch with speech mode (no song lookup, no web search) and returns i/text/translation', async () => {
    const res = await post('/api/streaming-captions/translate', { target_language: 'zh-Hans', segments, context: ['Earlier line'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toEqual([
      { i: 0, text: 'Hello my friend', translation: '译:Hello my friend' },
      { i: 1, text: 'How are you today', translation: '译:How are you today' },
    ]);
    expect(body).toMatchObject({ targetLanguage: 'zh-Hans', model: 'test-model' });
    expect(corrected).toHaveLength(1);
    expect(corrected[0].mode).toBe('speech'); // "speech" never searches the web
    expect(corrected[0].context).toEqual(['Earlier line']);
    expect(charges).toBe(1); // no session: this request is its own job, charged after it produced a translation
  });

  describe('charging: once per captions job, at the first batch that produced a translated line', () => {
    const seg = (i, text) => ({ i, start: i, end: i + 1, text });
    it('the first translated batch charges; later batches and resumes of the same job do not', async () => {
      const { sessionId } = await (await post('/api/streaming-captions/token', {})).json();
      expect(charges).toBe(0);
      for (const text of ['one', 'two', 'three']) {
        const r = await post('/api/streaming-captions/translate', { target_language: 'es', sessionId, segments: [seg(0, text)] });
        expect(r.status).toBe(200);
      }
      expect(charges).toBe(1);
    });

    it('a job whose batches never produce a translated line is not counted (failed model call, or a translation that repeats the original)', async () => {
      const { sessionId } = await (await post('/api/streaming-captions/token', {})).json();
      _setLyricCaptionsHooks({ hasTranslateKey: () => true, correct: async () => { throw new Error('model down'); } });
      expect((await post('/api/streaming-captions/translate', { target_language: 'es', sessionId, segments: [seg(0, 'x')] })).status).toBe(502);
      _setLyricCaptionsHooks({ hasTranslateKey: () => true, correct: async (a) => ({ parsed: { language: 'en', lines: a.lines.map((l, i) => ({ i, text: l.text, translation: l.text })) }, usedWebSearch: false, model: 'm' }) });
      expect((await post('/api/streaming-captions/translate', { target_language: 'en', sessionId, segments: [seg(0, 'same')] })).status).toBe(200);
      expect(charges).toBe(0);
    });

    it('concurrent first batches of one job charge once', async () => {
      const { sessionId } = await (await post('/api/streaming-captions/token', {})).json();
      const rs = await Promise.all([1, 2, 3].map(n => post('/api/streaming-captions/translate', { target_language: 'es', sessionId, segments: [seg(0, `t${n}`)] })));
      expect(rs.map(r => r.status)).toEqual([200, 200, 200]);
      expect(charges).toBe(1);
    });

    it("another user's or an unknown sessionId is not a free pass: that request is its own job", async () => {
      await post('/api/streaming-captions/translate', { target_language: 'es', sessionId: 'nope', segments: [seg(0, 'a')] });
      await post('/api/streaming-captions/translate', { target_language: 'es', sessionId: 'nope', segments: [seg(0, 'b')] });
      expect(charges).toBe(2);
    });

    it('a refused charge (daily limit) answers with the refusal and no translated lines; the job can try again', async () => {
      const { sessionId } = await (await post('/api/streaming-captions/token', {})).json();
      let deny = true;
      _setStreamingCaptionsHooks({
        isConfigured: () => true, mintToken: async () => 't',
        charge: (q, s, n) => { if (deny) { s.set('X-Inference-Daily-Remaining', '0'); return s.status(429).json({ code: 'daily_limit_reached' }); } charges += 1; return n(); },
      });
      const denied = await post('/api/streaming-captions/translate', { target_language: 'es', sessionId, segments: [seg(0, 'a')] });
      expect(denied.status).toBe(429);
      expect(denied.headers.get('x-inference-daily-remaining')).toBe('0');
      expect(await denied.json()).toEqual({ code: 'daily_limit_reached' });
      deny = false;
      expect((await post('/api/streaming-captions/translate', { target_language: 'es', sessionId, segments: [seg(0, 'a')] })).status).toBe(200);
      expect(charges).toBe(1);
    });
  });

  it('ignores a client-sent mode: it cannot ask for lyrics/web search', async () => {
    await post('/api/streaming-captions/translate', { target_language: 'es', mode: 'lyrics', segments });
    expect(corrected[0].mode).toBe('speech');
  });

  it('validates input and limits the batch size', async () => {
    expect((await post('/api/streaming-captions/translate', { segments })).status).toBe(400);
    expect((await post('/api/streaming-captions/translate', { target_language: 'es', segments: [] })).status).toBe(400);
    expect((await post('/api/streaming-captions/translate', { target_language: 'es', segments: [{ start: 0, end: 1, text: '' }] })).status).toBe(400);
    expect((await post('/api/streaming-captions/translate', { target_language: 'es', segments: [{ start: 3, end: 1, text: 'x' }] })).status).toBe(400);
    const many = Array.from({ length: 41 }, (_, i) => ({ i, start: i, end: i + 1, text: 'x' }));
    const tooMany = await post('/api/streaming-captions/translate', { target_language: 'es', segments: many });
    expect(tooMany.status).toBe(413);
    expect((await tooMany.json()).code).toBe('batch_too_large');
    const long = await post('/api/streaming-captions/translate', { target_language: 'es', segments: [{ start: 0, end: 1, text: 'x'.repeat(401) }] });
    expect(long.status).toBe(413);
    expect(corrected).toHaveLength(0);
  });

  it('503 when the translation key is missing; 502 retryable when the model fails', async () => {
    _setLyricCaptionsHooks({ hasTranslateKey: () => false });
    expect((await post('/api/streaming-captions/translate', { target_language: 'es', segments })).status).toBe(503);
    _setLyricCaptionsHooks({ hasTranslateKey: () => true, correct: async () => { throw new Error('boom'); } });
    const res = await post('/api/streaming-captions/translate', { target_language: 'es', segments });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: 'translation_failed', retryable: true });
  });

  it('a translation that repeats the original is dropped (never shown twice)', async () => {
    _setLyricCaptionsHooks({
      hasTranslateKey: () => true,
      correct: async ({ lines }) => ({ parsed: { lines: lines.map((l, i) => ({ i, text: l.text, translation: l.text })) }, usedWebSearch: false, model: 'm' }),
    });
    const body = await (await post('/api/streaming-captions/translate', { target_language: 'en', segments })).json();
    expect(body.lines.map(l => l.translation)).toEqual(['', '']);
  });
});

describe('the video never reaches the captions server', () => {
  it('there is no burn route: POST /api/streaming-captions/burn is gone', async () => {
    const form = new FormData();
    form.append('video', new Blob(['VIDEO']), 'v.mp4');
    const res = await fetch(`${base}/api/streaming-captions/burn`, { method: 'POST', headers: { 'sample-access-token': sampleToken }, body: form });
    expect(res.status).toBe(404);
  });
});

describe('the real mint call (ElevenLabs mocked)', () => {
  afterEach(() => vi.restoreAllMocks());
  const okJson = (status, body) => ({ ok: status < 400, status, json: async () => body });

  it('POSTs the realtime_scribe token endpoint with the key in xi-api-key and returns only the token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(200, { token: 'sutkn_abc' }));
    expect(await _mintScribeTokenForTests()).toBe('sutkn_abc');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
    expect(init.method).toBe('POST');
    expect(Object.keys(init.headers)).toEqual(['xi-api-key']);
  });

  it('maps ElevenLabs failures to 503 codes and never logs a body', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(401, { detail: SECRET }));
    await expect(_mintScribeTokenForTests()).rejects.toMatchObject({ status: 503, code: 'streaming_captions_unavailable' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(429, {}));
    await expect(_mintScribeTokenForTests()).rejects.toMatchObject({ status: 503, code: 'streaming_captions_busy' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error(SECRET));
    await expect(_mintScribeTokenForTests()).rejects.toMatchObject({ status: 503 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson(200, {}));
    await expect(_mintScribeTokenForTests()).rejects.toMatchObject({ status: 502 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });
});
