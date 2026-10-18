// @vitest-environment node
// lyric_captions from the iOS app: mobile Bearer auth, quota (FREE_EDITS_IOS, turn tokens), and
// no charge for a request the server refuses before doing any work. STT/Grok/ffprobe are mocked.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const db = vi.hoisted(() => ({
  findUserByApiToken: vi.fn(),
  consumeDailyInference: vi.fn(),
  recordDailyInference: vi.fn(),
  getDailyInferenceUsage: vi.fn(),
  enqueueChatInteraction: vi.fn(),
  saveLesson: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../db.js', () => db);

import express from 'express';
import { promises as fs, readdirSync } from 'fs';
import { lyricCaptionsRouter, _setLyricCaptionsHooks } from '../server/lyricCaptions.js';
import { jobsRouter, JOBS_DIR } from '../server/jobs.js';
import { videoProcessLimiter, apiLimiter } from '../server/middleware.js';
import { issueTurnToken } from '../server/turnToken.js';

const IOS_UA = 'FinalCap-iOS/12';
// Fixture tokens only (not real credentials).
const DEVICE_USER = { id: 7, has_subscription: 0, device_install_id: '550e8400-e29b-41d4-a716-446655440000', name: 'iOS device' };
const GOOGLE_MOBILE_USER = { id: 8, has_subscription: 0, device_install_id: null, email: 'm@example.com' };
const OTHER_DEVICE_USER = { id: 12, has_subscription: 0, device_install_id: '650e8400-e29b-41d4-a716-446655440000', name: 'iOS device' };

const TRANSCRIPT = {
  language: 'german',
  segments: [{ start: 1, end: 3, text: 'und tanz mit mir' }],
  words: [{ w: 'und', start: 1, end: 1.5 }, { w: 'tanz', start: 1.5, end: 2 }, { w: 'mit', start: 2, end: 2.5 }, { w: 'mir', start: 2.5, end: 3 }],
};
const MODEL_REPLY = {
  mode: 'lyrics',
  language: 'de',
  song: { title: 'Test Song', artist: 'Test Artist', confidence: 'high' },
  lines: [{ i: 0, text: 'und tanz mit mir', translation: '和我跳舞' }],
};

let server;
let base;

const hooks = {
  hasApiKeys: () => true,
  probeHostTools: async () => ({ ffmpeg: true, ffprobe: true, assFilter: true, fontFamilies: new Set(['Noto Sans CJK SC']) }),
  probeMedia: async (p) => {
    const head = (await fs.readFile(p, 'utf8')).slice(0, 12);
    if (head.startsWith('VIDEO')) return { format: { duration: 8 }, streams: [{ codec_type: 'video', width: 720, height: 1280 }, { codec_type: 'audio', codec_name: 'aac' }] };
    if (head.startsWith('LONG')) return { format: { duration: 601 }, streams: [{ codec_type: 'audio' }] };
    if (head.startsWith('SILENT')) return { format: { duration: 5 }, streams: [] };
    if (head.startsWith('GARBAGE')) throw new Error('invalid data');
    return { format: { duration: 8 }, streams: [{ codec_type: 'audio', codec_name: 'aac' }] };
  },
  extractAudioToWav: async (_in, out) => fs.writeFile(out, 'wav'),
  transcribe: async () => TRANSCRIPT,
  correct: async () => ({ parsed: MODEL_REPLY, usedWebSearch: true, model: 'grok-test' }),
};

beforeAll(async () => {
  await fs.mkdir(JOBS_DIR, { recursive: true });
  baseline = new Set(readdirSync(JOBS_DIR));
  _setLyricCaptionsHooks(hooks);
  const app = express();
  app.use(express.json());
  app.use(jobsRouter);
  app.use(lyricCaptionsRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  _setLyricCaptionsHooks();
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  for (const limiter of [videoProcessLimiter, apiLimiter]) {
    for (const key of ['127.0.0.1', '::ffff:127.0.0.1']) await limiter.resetKey(key);
  }
  for (const fn of Object.values(db)) fn.mockReset?.();
  db.findUserByApiToken.mockImplementation(async (t) => ({ 'device-token': { ...DEVICE_USER }, 'google-token': { ...GOOGLE_MOBILE_USER }, 'other-device-token': { ...OTHER_DEVICE_USER } }[t] || null));
  db.consumeDailyInference.mockResolvedValue({ allowed: true, limit: 3, used: 1, remaining: 2, resetsAt: '2026-10-08' });
  db.recordDailyInference.mockResolvedValue({ used: 5 });
});

afterEach(() => { delete process.env.FREE_EDITS_IOS; });

export const iosHeaders = (bearer = 'device-token', extra = {}) => ({ Authorization: `Bearer ${bearer}`, 'User-Agent': IOS_UA, ...extra });

function postAudio(fields, { file = 'RIFFaudio', headers = iosHeaders() } = {}) {
  const form = new FormData();
  if (file != null) form.append('audio', new Blob([file], { type: 'audio/mp4' }), 'audio.m4a');
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return fetch(`${base}/api/lyric-captions`, { method: 'POST', headers, body: form });
}

async function waitJob(jobId, headers = iosHeaders()) {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/jobs/${jobId}`, { headers });
    const body = await res.json();
    if (res.status !== 200) return { httpStatus: res.status, ...body };
    if (body.status === 'succeeded' || body.status === 'failed') return body;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

let baseline = new Set();
const leftoverAudio = () => readdirSync(JOBS_DIR).filter(f => /^lyric-.*\.(audio|wav)$/.test(f) && !baseline.has(f));
const settle = () => new Promise(r => setTimeout(r, 50));

describe('iOS Bearer auth', () => {
  it('device Bearer: 202 → poll → result JSON with lines; charged once (limit on)', async () => {
    const res = await postAudio({ target_language: 'zh-Hans', mode: 'lyrics' });
    expect(res.status).toBe(202);
    expect(res.headers.get('x-inference-daily-remaining')).toBe('2');
    const started = await res.json();
    const job = await waitJob(started.jobId);
    expect(job).toMatchObject({ status: 'succeeded', operation: 'lyric_captions', summary: { lineCount: 1, song: { title: 'Test Song' } } });
    const result = await (await fetch(`${base}/api/jobs/${started.jobId}/result`, { headers: iosHeaders() })).json();
    expect(result.lines[0]).toMatchObject({ text: 'und tanz mit mir', translation: '和我跳舞' });
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(1);
    expect(db.consumeDailyInference).toHaveBeenCalledWith(7, 3);
  });

  it('missing or unknown Bearer: 401; another user cannot read the job', async () => {
    expect((await postAudio({ target_language: 'es' }, { headers: { 'User-Agent': IOS_UA } })).status).toBe(401);
    expect((await postAudio({ target_language: 'es' }, { headers: iosHeaders('nope') })).status).toBe(401);
    const started = await (await postAudio({ target_language: 'es' })).json();
    await waitJob(started.jobId);
    const other = await fetch(`${base}/api/jobs/${started.jobId}`, { headers: iosHeaders('other-device-token') });
    expect(other.status).toBe(404);
  });

  it('limit reached: 429 daily_limit_reached, nothing queued, audio deleted', async () => {
    db.consumeDailyInference.mockResolvedValue({ allowed: false, limit: 3, used: 3, remaining: 0, resetsAt: '2026-10-08' });
    const res = await postAudio({ target_language: 'es' });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('daily_limit_reached');
    await settle();
    expect(leftoverAudio()).toEqual([]);
  });
});

describe('no charge for refused uploads', () => {
  it('bad options, no audio, video file, too long, no audio track, unreadable: never charged, temp audio deleted', async () => {
    const cases = [
      [{}, 'RIFFaudio', 400, undefined],
      [{ target_language: 'es' }, null, 400, undefined],
      [{ target_language: 'es', mode: 'karaoke' }, 'RIFFaudio', 400, undefined],
      [{ target_language: 'es' }, 'VIDEO data', 400, 'audio_only'],
      [{ target_language: 'es' }, 'LONG audio', 413, 'audio_too_long'],
      [{ target_language: 'es' }, 'SILENT', 400, 'no_audio'],
      [{ target_language: 'es' }, 'GARBAGE', 400, 'unsupported_audio_format'],
    ];
    for (const [fields, file, status, code] of cases) {
      const res = await postAudio(fields, { file });
      expect(res.status, JSON.stringify(fields) + file).toBe(status);
      if (code) expect((await res.json()).code).toBe(code);
    }
    expect(db.consumeDailyInference).not.toHaveBeenCalled();
    expect(db.recordDailyInference).not.toHaveBeenCalled();
    await settle();
    expect(leftoverAudio()).toEqual([]);
  });
});

describe('FREE_EDITS_IOS=unlimited', () => {
  beforeEach(() => { process.env.FREE_EDITS_IOS = 'unlimited'; });

  it('never blocked even past the limit; usage counted once; X-Inference-Unlimited set', async () => {
    db.consumeDailyInference.mockResolvedValue({ allowed: false, limit: 3, used: 3, remaining: 0 });
    const res = await postAudio({ target_language: 'de' });
    expect(res.status).toBe(202);
    expect(res.headers.get('x-inference-unlimited')).toBe('true');
    expect(res.headers.get('x-inference-daily-used')).toBe('5');
    expect(db.recordDailyInference).toHaveBeenCalledTimes(1);
    expect(db.consumeDailyInference).not.toHaveBeenCalled();
    const started = await res.json();
    expect((await waitJob(started.jobId)).status).toBe('succeeded');
    expect(db.recordDailyInference).toHaveBeenCalledTimes(1); // polling is not counted
  });

  it('an iOS Google sign-in (no subscription, no device id) can start, poll and fetch the result', async () => {
    const headers = iosHeaders('google-token');
    const res = await postAudio({ target_language: 'de' }, { headers });
    expect(res.status).toBe(202);
    const started = await res.json();
    const job = await waitJob(started.jobId, headers);
    expect(job.status).toBe('succeeded');
    expect((await fetch(`${base}/api/jobs/${started.jobId}/result`, { headers })).status).toBe(200);
  });
});

describe('client-mode tool call: X-Turn-Token + X-Tool-Call-Id', () => {
  it('the run of a tool call from an already-charged chat turn is free, once', async () => {
    const turnToken = issueTurnToken({ userId: 7, turnId: 'turn-1', toolCallIds: ['call_lyrics'] });
    const headers = iosHeaders('device-token', { 'X-Turn-Token': turnToken, 'X-Tool-Call-Id': 'call_lyrics' });
    const first = await postAudio({ target_language: 'zh-Hans' }, { headers });
    expect(first.status).toBe(202);
    expect(first.headers.get('x-inference-charged')).toBe('false');
    expect(db.consumeDailyInference).not.toHaveBeenCalled();
    const again = await postAudio({ target_language: 'zh-Hans' }, { headers });
    expect(again.status).toBe(202);
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(1); // reused id → charged as new work
    for (const r of [first, again]) expect((await waitJob((await r.json()).jobId)).status).toBe('succeeded');
    expect(leftoverAudio()).toEqual([]);
  });
});
