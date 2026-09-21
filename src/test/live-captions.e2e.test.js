/**
 * Live integration against production FinalCut (grepawk.com).
 *
 * Offline by default. Run:
 *   FINALCUT_LIVE_E2E=1 npm run test:live-captions
 *
 * Optional:
 *   FINALCUT_LIVE_BASE_URL=https://grepawk.com
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { srtHasSpeech } from '../server/captionHelpers.js';

const LIVE = process.env.FINALCUT_LIVE_E2E === '1';
const BASE = (process.env.FINALCUT_LIVE_BASE_URL || 'https://grepawk.com').replace(/\/+$/, '');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures');

const describeLive = LIVE ? describe : describe.skip;

async function getSampleToken() {
  const res = await fetch(`${BASE}/api/sample-access-token`);
  expect(res.ok, `sample-access-token HTTP ${res.status}`).toBe(true);
  const data = await res.json();
  expect(data.token).toBeTruthy();
  expect(String(data.token).length).toBeGreaterThanOrEqual(32);
  return data.token;
}

function sampleHeaders(token, extra = {}) {
  return { 'sample-access-token': token, ...extra };
}

describeLive('live captions E2E @ grepawk.com', () => {
  let token;
  const speechMp4 = readFileSync(path.join(fixtures, 'speech-hello.mp4'));
  const silentMp4 = readFileSync(path.join(fixtures, 'silent-2s.mp4'));

  beforeAll(async () => {
    token = await getSampleToken();
  }, 60_000);

  it('silent audio yields no usable speech (422 or trivial hallucination)', async () => {
    const res = await fetch(`${BASE}/api/generate-captions`, {
      method: 'POST',
      headers: sampleHeaders(token, {
        'Content-Type': 'video/mp4',
        'x-args': JSON.stringify({ language: 'en' }),
      }),
      body: silentMp4,
    });
    const body = await res.json();
    if (res.status === 422) {
      expect(String(body.error || '')).toMatch(/speech|audio/i);
      return;
    }
    // Pre-deploy: Whisper may return 200 with a trivial hallucination like "you".
    expect(res.status).toBe(200);
    expect(srtHasSpeech(body.srt)).toBe(false);
  }, 180_000);

  it('generate → translate → sync burn_subtitles', async () => {
    // 1) Generate
    const genRes = await fetch(`${BASE}/api/generate-captions`, {
      method: 'POST',
      headers: sampleHeaders(token, {
        'Content-Type': 'video/mp4',
        'x-args': JSON.stringify({ language: 'en' }),
      }),
      body: speechMp4,
    });
    expect(genRes.status, await genRes.clone().text()).toBe(200);
    const gen = await genRes.json();
    expect(gen.srt).toBeTruthy();
    expect(gen.vtt).toMatch(/^WEBVTT/);
    expect(gen.srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/);

    const originalTiming = [...gen.srt.matchAll(/(\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3})/g)].map(m => m[1]);

    // 2) Translate
    const trRes = await fetch(`${BASE}/api/translate-captions`, {
      method: 'POST',
      headers: sampleHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ srtContent: gen.srt, targetLanguage: 'es' }),
    });
    expect(trRes.status, await trRes.clone().text()).toBe(200);
    const tr = await trRes.json();
    expect(tr.srt).toBeTruthy();
    expect(tr.targetLanguage).toBe('es');
    for (const t of originalTiming) {
      expect(tr.srt).toContain(t);
    }

    // 3) Sync burn-in (multipart) — NOT async jobs
    const form = new FormData();
    form.append('video', new Blob([speechMp4], { type: 'video/mp4' }), 'speech-hello.mp4');
    form.append('operation', 'burn_subtitles');
    form.append(
      'args',
      JSON.stringify({
        srtContent: gen.srt,
        translatedSrtContent: tr.srt,
        style: 'default',
        position: 'bottom',
      })
    );

    const burnRes = await fetch(`${BASE}/api/process-video`, {
      method: 'POST',
      headers: sampleHeaders(token),
      body: form,
    });
    expect(burnRes.status, await burnRes.clone().text().catch(() => '')).toBe(200);
    const ctype = burnRes.headers.get('content-type') || '';
    expect(ctype).toMatch(/video\/mp4|octet-stream/i);
    const burned = Buffer.from(await burnRes.arrayBuffer());
    expect(burned.byteLength).toBeGreaterThan(1000);
  }, 300_000);
});
