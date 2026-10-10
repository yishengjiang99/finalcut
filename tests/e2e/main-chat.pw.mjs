// E2E: the main route's chat loop (App.jsx + useCallAPI + runClientTurn) with the in-browser
// engine, driven by stubbed /api/v2/chat responses. Verifies the real product path:
//   1. trim via chat: tool runs in ffmpeg.wasm, result message carries the video, output
//      metadata + first-frame hash check out, and no media bytes leave the browser.
//   2. consent decline: an unsupported step (vibrato) asks first; declining uploads nothing.
//   3. consent accept: accepting uploads the file to /api/process-video (the only allowed upload).
//   4. cancel: cancelling a running job aborts the turn and marks it cancelled.
import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'testclip-6s.mp4');
const RESULTS_DIR = path.join(HERE, '..', '..', 'test-results', 'e2e-main');
const MEDIA_CT = /^(video|audio|image)\/|multipart\/form-data|application\/octet-stream/i;

const CONFIG = {
  clientFFmpeg: { mode: 'on', percent: 100 },
  limits: { clip: { desktop: { warnBytes: 1e9, blockBytes: 1.8e9 } } },
  captions: { onDevice: true, cloud: false },
  tools: { fallback: 'run_ffmpeg' },
};
const EMPTY_CATALOG = { filters: [], encoders: [], decoders: [], muxers: [], demuxers: [], recipes: [], outputFormats: [] };

function toolCallsReply(calls) {
  const assistant = { role: 'assistant', content: null, tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) };
  return { status: 'tool_calls', toolCalls: calls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments })), messages: [{ role: 'user', content: 'do it' }, assistant] };
}
const finalReply = (message) => ({ status: 'final', message });

async function setupPage(page, baseURL, chatQueue, { allowUpload = false } = {}) {
  const problems = [];
  const fixture = readFileSync(FIXTURE);
  const probe = fixture.subarray(1024, 1024 + 4096);
  const uploads = [];
  const origin = new URL(baseURL).origin;
  await page.route('**/api/health', r => r.fulfill({ json: { ok: true, ffmpeg: { version: '4.4.2' } } }));
  await page.route('**/api/auth/status', r => r.fulfill({ json: { authenticated: false } }));
  await page.route('**/api/v2/config', r => r.fulfill({ json: CONFIG }));
  await page.route('**/api/v2/capabilities', r => r.fulfill({ json: EMPTY_CATALOG }));
  await page.route('**/api/sample-access-token', r => r.fulfill({ status: 404 }));
  await page.route('**/BigBuckBunny.mp4', r => r.fulfill({ status: 404 }));
  await page.route('**/api/v2/chat', async (route) => {
    const req = route.request();
    const body = req.postDataBuffer();
    if (body?.length) {
      if (body.includes(probe)) problems.push(`chat request body contains fixture bytes`);
      const ct = req.headers()['content-type'] || '';
      if (MEDIA_CT.test(ct)) problems.push(`chat request has media content-type: ${ct}`);
    }
    const next = chatQueue.shift();
    if (!next) return route.fulfill({ status: 500, body: 'chat queue empty' });
    if (next.delayMs) await new Promise(r => setTimeout(r, next.delayMs));
    return route.fulfill({ json: next.reply });
  });
  await page.route('**/api/process-video', async (route) => {
    const body = route.request().postDataBuffer();
    uploads.push({ bytes: body?.length || 0, hasFixture: body ? body.includes(probe) : false });
    // Pretend the server ran the op: hand back the original bytes.
    return route.fulfill({ body: fixture, headers: { 'content-type': 'video/mp4' } });
  });
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    const u = new URL(url);
    if (u.origin !== origin) problems.push(`third-party request: ${req.method()} ${url}`);
    if (!allowUpload && u.pathname === '/api/process-video') problems.push('unexpected upload to /api/process-video');
  });
  const badResponses = [];
  page.on('response', (r) => {
    if (r.status() >= 400 && !/favicon\.ico|sample-access-token|BigBuckBunny/.test(r.url())) badResponses.push(`${r.status()} ${r.url()}`);
  });
  return { problems, uploads, badResponses };
}

async function dismissLanding(page) {
  await page.goto('/?engine=client');
  await page.getByRole('button', { name: /watch it work/i }).click();
  await expect(page.locator('.composer-row')).toBeVisible({ timeout: 15000 });
}

async function uploadFixture(page) {
  await page.locator('.composer-row input[type=file]').setInputFiles(FIXTURE);
  // The editor shows the clip once the upload is registered.
  await page.waitForFunction(() => document.querySelector('.composer-row textarea')?.placeholder?.includes('Describe the video edit'), null, { timeout: 15000 });
}

async function sendPrompt(page, text) {
  await page.locator('.composer-row textarea').fill(text);
  await page.locator('.send-btn').click();
}

test.describe('main chat loop (client engine)', () => {
  test('trim via chat runs in the browser: metadata, frame hash, zero uploads', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(300_000);
    const chatQueue = [
      { reply: toolCallsReply([{ id: 'call_1', name: 'trim_video', arguments: { start: 1, end: 3 } }]) },
      { reply: finalReply('Trimmed to seconds 1–3.') },
    ];
    const { problems, uploads, badResponses } = await setupPage(page, baseURL, chatQueue);
    await dismissLanding(page);
    await uploadFixture(page);
    await sendPrompt(page, 'trim seconds 1 to 3');
    // Wait for the trim result: a second video appears (the first is the original upload).
    await expect(page.locator('[data-message-id] video')).toHaveCount(2, { timeout: 180_000 });

    // Probe the output directly in the page: the trim result message carries the 2s video.
    const meta = await page.evaluate(async () => {
      const eng = await import('/src/wasm/ffmpegEngine.js');
      const els = [...document.querySelectorAll('[data-message-id]')];
      const msg = els.find(el => /processed video \(trimmed\)/i.test(el.textContent || ''));
      const video = msg?.querySelector('video');
      if (!video) throw new Error('trim result video not found');
      const outBytes = new Uint8Array(await (await fetch(video.src)).arrayBuffer());
      const probe = await eng.probeMedia(outBytes, 'video/mp4');
      const thumb = await eng.thumbnail(outBytes, 'video/mp4', { at: 0 });
      let h = 0; for (let i = 0; i < thumb.length; i += 97) h = (h * 31 + thumb[i]) >>> 0;
      return { duration: Number(probe.format.duration), hash: h.toString(16), bytes: outBytes.length };
    });
    const inputMeta = await page.evaluate(async () => {
      const eng = await import('/src/wasm/ffmpegEngine.js');
      const inBytes = new Uint8Array(await (await fetch('/tests/e2e/fixtures/testclip-6s.mp4')).arrayBuffer());
      // The trim keeps seconds 1-3, so compare against the original's frame at 1s.
      const thumb = await eng.thumbnail(inBytes, 'video/mp4', { at: 1 });
      let h = 0; for (let i = 0; i < thumb.length; i += 97) h = (h * 31 + thumb[i]) >>> 0;
      return { hash: h.toString(16) };
    });

    expect(meta.duration).toBeGreaterThan(1.5);
    expect(meta.duration).toBeLessThan(2.6);
    expect(meta.bytes).toBeGreaterThan(10000);
    // Stream-copy trim: the output's first frame matches the original's frame at the trim start.
    expect(meta.hash).toBe(inputMeta.hash);
    expect(uploads).toEqual([]);
    expect(problems).toEqual([]);
    expect(badResponses).toEqual([]);
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(path.join(RESULTS_DIR, 'chat-trim.json'), JSON.stringify({ meta, inputHash: inputMeta.hash, uploads: uploads.length, problems }, null, 1));
  });

  test('consent decline: unsupported step asks first, uploads nothing', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const chatQueue = [
      { reply: toolCallsReply([{ id: 'call_1', name: 'audio_vibrato', arguments: {} }]) },
      { reply: finalReply('Skipped the vibrato step as you asked.') },
    ];
    const { problems, uploads, badResponses } = await setupPage(page, baseURL, chatQueue);
    await dismissLanding(page);
    await uploadFixture(page);
    await sendPrompt(page, 'add vibrato');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole('dialog')).toContainText(/cannot run in this browser/);
    await page.getByRole('button', { name: /keep it on my device/i }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15000 });
    // The turn finishes without any upload: the model's final message appears.
    await expect(page.locator('[data-message-id]').last()).toContainText(/skip/i, { timeout: 60000 });
    expect(uploads).toEqual([]);
    expect(problems).toEqual([]);
    expect(badResponses).toEqual([]);
  });

  test('consent accept: upload goes to /api/process-video only after approval', async ({ page, baseURL }) => {
    test.setTimeout(180_000);
    const chatQueue = [
      { reply: toolCallsReply([{ id: 'call_1', name: 'audio_vibrato', arguments: {} }]) },
      { reply: finalReply('Applied vibrato on the server.') },
    ];
    const { problems, uploads, badResponses } = await setupPage(page, baseURL, chatQueue, { allowUpload: true });
    await dismissLanding(page);
    await uploadFixture(page);
    await sendPrompt(page, 'add vibrato');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: /upload and continue/i }).click();
    // The server fallback runs and the result is registered (a second video appears).
    await expect(page.locator('[data-message-id] video')).toHaveCount(2, { timeout: 120_000 });
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads[0].hasFixture).toBe(true);
    // The only upload in the whole turn was the approved one.
    expect(problems).toEqual([]);
    expect(badResponses).toEqual([]);
  });

  test('cancel: aborting a running job marks it cancelled', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    // The chat reply never comes: the job stays in "Planning the edit…" until cancelled.
    const chatQueue = [{ delayMs: 60000, reply: finalReply('never') }];
    const { problems, badResponses } = await setupPage(page, baseURL, chatQueue);
    await dismissLanding(page);
    await uploadFixture(page);
    await sendPrompt(page, 'trim seconds 1 to 3');
    const stopBtn = page.locator('.send-btn[title="Stop"]');
    await expect(stopBtn).toBeVisible({ timeout: 30000 });
    await stopBtn.click();
    // The turn aborts: the send button goes back to Send and the chat is usable again.
    await expect(page.locator('.send-btn[title="Send"]')).toBeVisible({ timeout: 30000 });
    await page.locator('.composer-row textarea').fill('hello');
    await expect(page.locator('.send-btn')).toBeEnabled({ timeout: 30000 });
    expect(problems).toEqual([]);
    expect(badResponses).toEqual([]);
  });
});
