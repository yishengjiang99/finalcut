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

function makeMultipartBurnBody(videoBuffer, srtContent) {
  const boundary = `----finalcap-test-${Date.now().toString(16)}`;
  const crlf = '\r\n';
  const args = JSON.stringify({
    srtContent,
    style: 'default',
    position: 'bottom',
  });
  const parts = [
    Buffer.from(
      `--${boundary}${crlf}`
      + `Content-Disposition: form-data; name="video"; filename="elevenlabs-caption-test.mp4"${crlf}`
      + `Content-Type: video/mp4${crlf}${crlf}`
    ),
    videoBuffer,
    Buffer.from(
      `${crlf}--${boundary}${crlf}`
      + `Content-Disposition: form-data; name="operation"${crlf}${crlf}`
      + `burn_subtitles${crlf}`
      + `--${boundary}${crlf}`
      + `Content-Disposition: form-data; name="args"${crlf}${crlf}`
      + `${args}${crlf}`
      + `--${boundary}--${crlf}`
    ),
  ];

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describeLive('live captions E2E @ grepawk.com', () => {
  let token;
  const speechMp4 = readFileSync(path.join(fixtures, 'elevenlabs-caption-test.mp4'));
  const speechText = readFileSync(path.join(fixtures, 'elevenlabs-caption-test.txt'), 'utf8');
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

  it('generate → sync burn_subtitles using generated ElevenLabs speech artifact', async () => {
    // 1) Generate
    console.log('[live-captions] generating captions');
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
    expect(gen.srt.toLowerCase()).toContain('caption');
    expect(gen.srt.toLowerCase()).toContain('video editing');
    expect(speechText.toLowerCase()).toContain('caption test');

    // 2) Sync burn-in (multipart) — NOT async jobs
    console.log('[live-captions] burning subtitles');
    const multipart = makeMultipartBurnBody(speechMp4, gen.srt);

    const burnRes = await fetch(`${BASE}/api/process-video`, {
      method: 'POST',
      headers: sampleHeaders(token, { 'Content-Type': multipart.contentType }),
      body: multipart.body,
    });
    console.log('[live-captions] burn response', burnRes.status);
    expect(burnRes.status, await burnRes.clone().text().catch(() => '')).toBe(200);
    const ctype = burnRes.headers.get('content-type') || '';
    expect(ctype).toMatch(/video\/mp4|octet-stream/i);
    const burned = Buffer.from(await burnRes.arrayBuffer());
    expect(burned.byteLength).toBeGreaterThan(1000);
  }, 300_000);
});
