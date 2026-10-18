// @vitest-environment node
// Regression: "Error creating lyric captions: Job not found". Jobs live in the memory of ONE node
// process (systemd unit, nginx -> localhost:3001) and every push to main restarts it, so a client
// polling across a deploy got a bare 404. The server now tells "made before a restart" (job_lost,
// retryable) from "dropped after the TTL" (job_expired) from "unknown", the web client retries a lost
// job once, and a restart waits for pending jobs.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { promises as fs } from 'fs';
import { lyricCaptionsRouter, _setLyricCaptionsHooks } from '../server/lyricCaptions.js';
import {
  jobsRouter, _jobsForTests, _simulateRestartForTests, missingJobCode, newJobId, pendingJobCount, waitForJobsToSettle,
} from '../server/jobs.js';
import { issueSampleAccessToken, videoProcessLimiter, apiLimiter } from '../server/middleware.js';
import { pollJob, runLyricCaptionsWeb, friendlyLyricCaptionsError, LYRIC_CAPTIONS_MESSAGES } from '../lyricCaptionsClient.js';

const TRANSCRIPT = { language: 'english', segments: [{ start: 0, end: 1, text: 'Hello my friend' }], words: [{ w: 'Hello', start: 0, end: 0.4 }, { w: 'my', start: 0.4, end: 0.6 }, { w: 'friend', start: 0.6, end: 1 }] };
const MODEL_REPLY = { mode: 'speech', language: 'en', song: null, lines: [{ i: 0, text: 'Hello my friend', translation: '你好，我的朋友' }] };

let server; let base; let token; let release; let gate;
const hooks = () => ({
  hasApiKeys: () => true,
  probeHostTools: async () => ({ ffmpeg: true, ffprobe: true, assFilter: true, fontFamilies: new Set(['Noto Sans CJK SC']) }),
  probeMedia: async () => ({ format: { duration: 51 }, streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le' }] }),
  extractAudioToWav: async (_in, out) => fs.writeFile(out, 'wav'),
  transcribe: async () => TRANSCRIPT,
  correct: async () => { if (gate) await gate; return { parsed: MODEL_REPLY, usedWebSearch: false, model: 'test' }; },
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(jobsRouter);
  app.use(lyricCaptionsRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { _setLyricCaptionsHooks(); await new Promise((r) => server.close(r)); });
beforeEach(async () => {
  for (const limiter of [videoProcessLimiter, apiLimiter]) for (const key of ['127.0.0.1', '::ffff:127.0.0.1']) await limiter.resetKey(key);
  token = issueSampleAccessToken();
  gate = null; release = null;
  _simulateRestartForTests();
  _setLyricCaptionsHooks(hooks());
});

const headers = () => ({ 'sample-access-token': token });
const start = () => {
  const form = new FormData();
  form.append('audio', new Blob(['RIFFaudio']), 'audio.wav');
  form.append('target_language', 'zh-Hans');
  form.append('mode', 'speech');
  return fetch(`${base}/api/lyric-captions`, { method: 'POST', headers: headers(), body: form });
};
const get = (p) => fetch(`${base}${p}`, { headers: headers() });
async function waitStatus(jobId, want = ['succeeded', 'failed']) {
  for (let i = 0; i < 200; i++) {
    const b = await (await get(`/api/jobs/${jobId}`)).json();
    if (want.includes(b.status)) return b;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

describe('server: a restart is told apart from an unknown id', () => {
  it('create → poll works; after a restart poll, and result answer 404 job_lost (retryable)', async () => {
    const { jobId, pollUrl } = await (await start()).json();
    expect(jobId).toMatch(/^j[0-9a-f]{8}_[0-9a-f-]{36}$/);
    expect(pollUrl).toContain(jobId);
    const done = await waitStatus(jobId);
    expect(done.status).toBe('succeeded');
    expect((await get(`/api/jobs/${jobId}/result`)).status).toBe(200);

    _simulateRestartForTests(); // the deploy: memory is gone, new boot id
    const poll = await get(`/api/jobs/${jobId}`);
    expect(poll.status).toBe(404); // same status as before, so existing clients still see a 404
    expect(await poll.json()).toEqual({ error: 'Job not found', code: 'job_lost', retryable: true });
    const result = await get(`/api/jobs/${jobId}/result`);
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({ error: 'Result not available', code: 'job_lost', retryable: true });
  });

  it('a job dropped by this process (TTL) is job_expired; an arbitrary id stays a plain 404', async () => {
    const { jobId } = await (await start()).json();
    await waitStatus(jobId);
    _jobsForTests.delete(jobId); // what the 30-minute timer does
    expect(await (await get(`/api/jobs/${jobId}`)).json()).toEqual({ error: 'Job not found', code: 'job_expired', retryable: true });
    expect(await (await get('/api/jobs/not-a-job')).json()).toEqual({ error: 'Job not found' });
    expect(await (await get(`/api/jobs/${newJobId().replace(/^j[0-9a-f]{8}/, 'jdeadbeef')}`)).json()).toMatchObject({ code: 'job_lost' });
  });

  it('missingJobCode', () => {
    expect(missingJobCode(newJobId())).toBe('job_expired');
    expect(missingJobCode('0b9b1c1e-6f0f-4a46-8d0e-3f1f2f3a4b5c')).toBeUndefined(); // old-format ids
    expect(missingJobCode(undefined)).toBeUndefined();
  });
});

describe('server: a restart waits for pending jobs', () => {
  it('counts running jobs and finished jobs whose result was not fetched; settles once fetched', async () => {
    gate = new Promise((r) => { release = r; });
    const { jobId } = await (await start()).json();
    await waitStatus(jobId, ['running']);
    expect(pendingJobCount()).toBe(1);
    expect(await waitForJobsToSettle({ maxMs: 60, pollMs: 10 })).toBe(1); // still running: gives up at the deadline
    release();
    await waitStatus(jobId, ['succeeded']);
    expect(pendingJobCount()).toBe(1); // finished, result not picked up yet
    expect((await get(`/api/jobs/${jobId}/result`)).status).toBe(200);
    expect(pendingJobCount()).toBe(0);
    expect(await waitForJobsToSettle({ maxMs: 1000, pollMs: 10 })).toBe(0);
  });
});

describe('web client', () => {
  const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  const errResponse = (status, body = {}) => ({ ok: false, status, json: async () => body });

  it('pollJob: 404 becomes code job_lost (also when the body has no code); 5xx/network blips are retried', async () => {
    const sleep = vi.fn(async () => {});
    const realFetch = globalThis.fetch;
    try {
      let n = 0;
      globalThis.fetch = vi.fn(async () => {
        n += 1;
        if (n === 1) throw new TypeError('Load failed'); // server restarting
        if (n === 2) return errResponse(502);
        if (n === 3) return okResponse({ status: 'running' });
        return okResponse({ status: 'succeeded', summary: { lineCount: 1 } });
      });
      expect(await pollJob('/api/jobs/x', { sleep })).toMatchObject({ status: 'succeeded' });
      expect(n).toBe(4);
      globalThis.fetch = vi.fn(async () => errResponse(404, { error: 'Job not found' }));
      await expect(pollJob('/api/jobs/x', { sleep })).rejects.toMatchObject({ code: 'job_lost', status: 404 });
      globalThis.fetch = vi.fn(async () => errResponse(404, { error: 'Job not found', code: 'job_expired' }));
      await expect(pollJob('/api/jobs/x', { sleep })).rejects.toMatchObject({ code: 'job_expired' });
      globalThis.fetch = vi.fn(async () => { throw new TypeError('offline'); });
      await expect(pollJob('/api/jobs/x', { sleep, transientRetries: 3 })).rejects.toMatchObject({ code: 'network' });
    } finally { globalThis.fetch = realFetch; }
  });

  it('runLyricCaptionsWeb sends the audio again once when the job was lost; a second loss is reported', async () => {
    const realFetch = globalThis.fetch;
    const posts = [];
    try {
      globalThis.fetch = vi.fn(async (url, init = {}) => {
        if (url === '/api/lyric-captions') { posts.push(url); return { ok: true, status: 202, json: async () => ({ jobId: `j${posts.length}`, pollUrl: `/api/jobs/j${posts.length}`, resultUrl: `/api/jobs/j${posts.length}/result` }) }; }
        if (url === '/api/jobs/j2/result') return okResponse({ lines: [{ text: 'a' }], song: null, targetLanguage: 'zh-Hans' });
        throw new Error(`unexpected ${url}`);
      });
      const extract = vi.fn(async () => new Uint8Array(44));
      const poll = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('Job not found'), { code: 'job_lost', status: 404 }))
        .mockResolvedValueOnce({ status: 'succeeded', summary: {} });
      const out = await runLyricCaptionsWeb({ target_language: 'zh-Hans', mode: 'speech' }, new Uint8Array(10), { extract, poll });
      expect(posts).toHaveLength(2);
      expect(extract).toHaveBeenCalledTimes(1); // audio extracted once, uploaded twice
      expect(out.result.lines).toHaveLength(1);

      posts.length = 0;
      const alwaysLost = vi.fn().mockRejectedValue(Object.assign(new Error('Job not found'), { code: 'job_lost', status: 404 }));
      await expect(runLyricCaptionsWeb({ target_language: 'zh-Hans' }, new Uint8Array(10), { extract, poll: alwaysLost })).rejects.toMatchObject({ code: 'job_lost' });
      expect(posts).toHaveLength(2); // one retry, then stop
    } finally { globalThis.fetch = realFetch; }
  });

  it('does not retry other failures (no_speech, too long)', async () => {
    const realFetch = globalThis.fetch;
    let posts = 0;
    try {
      globalThis.fetch = vi.fn(async () => { posts += 1; return { ok: true, status: 202, json: async () => ({ jobId: 'j', pollUrl: '/p' }) }; });
      const poll = vi.fn().mockRejectedValue(Object.assign(new Error('No singing or speech detected in the audio'), { code: 'no_speech' }));
      await expect(runLyricCaptionsWeb({ target_language: 'es' }, new Uint8Array(1), { extract: async () => new Uint8Array(44), poll })).rejects.toMatchObject({ code: 'no_speech' });
      expect(posts).toBe(1);
    } finally { globalThis.fetch = realFetch; }
  });

  it('friendlyLyricCaptionsError uses the Design wording', () => {
    expect(LYRIC_CAPTIONS_MESSAGES).toEqual({
      couldntFinish: "Captions couldn't finish. Nothing was changed. Try again.",
      tooLong: "This video's audio is too long for translated captions. Try a clip under 10 minutes.",
      unavailable: "Translated captions aren't available right now. Try again later.",
    });
    expect(friendlyLyricCaptionsError(Object.assign(new Error('Job not found'), { code: 'job_lost' }))).toBe(LYRIC_CAPTIONS_MESSAGES.couldntFinish);
    expect(friendlyLyricCaptionsError(new Error('boom'))).toBe(LYRIC_CAPTIONS_MESSAGES.couldntFinish);
    expect(friendlyLyricCaptionsError(Object.assign(new Error('x'), { code: 'audio_too_long' }))).toBe(LYRIC_CAPTIONS_MESSAGES.tooLong);
    expect(friendlyLyricCaptionsError(Object.assign(new Error('x'), { code: 'lyric_captions_unavailable' }))).toBe(LYRIC_CAPTIONS_MESSAGES.unavailable);
  });
});
