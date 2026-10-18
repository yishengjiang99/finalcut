// E2E: the export that burns captions into the frames in the browser (src/captionBurn.js: WebCodecs
// decode, canvas caption, hardware/software H.264 encode, mediabunny MP4 mux). No ffmpeg.wasm, no upload.
// Needs a browser with H.264 WebCodecs (Google Chrome: E2E_CHROME_PATH=/usr/bin/google-chrome); skipped
// when the browser cannot encode avc (Playwright's bundled Chromium has no H.264).
// Checks the output with the system ffprobe/ffmpeg: size, codecs, duration, audio copied, caption pixels.
import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'testclip-6s.mp4');
const OUT_DIR = path.join(HERE, '..', '..', 'test-results', 'e2e-main');

const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration', '-show_entries', 'format=duration', '-of', 'json', file]).toString());
/** Count near-white pixels in the lower third of the frame at `t` seconds. */
function whiteInLowerThird(file, t, png) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=iw:ih/3:0:ih*2/3,format=gray', '-f', 'rawvideo', '-']);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', png]);
  let n = 0;
  for (const v of raw) if (v > 235) n++;
  return n;
}

test('burns the caption track into the frames with WebCodecs, copies the audio, uploads nothing', async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT_DIR, { recursive: true });
  const requests = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'HEAD') requests.push(`${r.method()} ${r.url()}`); });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto('/legal/terms.html');

  const avc = await page.evaluate(async () => {
    if (typeof VideoEncoder !== 'function') return false;
    const c = await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 640, height: 360 }).catch(() => ({ supported: false }));
    return Boolean(c.supported);
  });
  test.skip(!avc, 'this browser has no H.264 WebCodecs encoder (use Google Chrome)');

  const result = await page.evaluate(async ({ fixture }) => {
    const { burnCaptionsWebCodecs } = await import('/src/captionBurn.js');
    const bytes = new Uint8Array(await (await fetch(fixture)).arrayBuffer());
    const track = {
      lines: [{ start: 0.5, end: 2.5, text: '你好，世界 Hello', translation: 'Hello, world' }],
      language: 'zh', targetLanguage: 'en',
      style: { positionFromBottomPct: 20, sizeScale: 1, font: 'Noto Sans CJK SC', alignment: 2 },
    };
    const progress = [];
    const events = [];
    const out = await burnCaptionsWebCodecs({ bytes, mime: 'video/mp4', track, onProgress: (p) => progress.push(p), clog: { log: (ev, data) => events.push({ ev, ...data }) } });
    return { data: Array.from(out.bytes), width: out.width, height: out.height, codec: out.codec, audio: out.audio, progress: progress.length, last: progress.at(-1), events };
  }, { fixture: '/@fs' + FIXTURE });

  const outFile = path.join(OUT_DIR, 'captions-burn.mp4');
  writeFileSync(outFile, Buffer.from(result.data));
  const src = probe(FIXTURE);
  const out = probe(outFile);
  const sv = src.streams.find(s => s.codec_type === 'video');
  const ov = out.streams.find(s => s.codec_type === 'video');
  const sa = src.streams.find(s => s.codec_type === 'audio');
  const oa = out.streams.find(s => s.codec_type === 'audio');
  expect(ov.codec_name).toBe('h264');
  expect([ov.width, ov.height]).toEqual([sv.width, sv.height]);
  expect(oa?.codec_name).toBe(sa?.codec_name); // audio copied through
  expect(Math.abs(Number(out.format.duration) - Number(src.format.duration))).toBeLessThan(0.5);
  expect(result.last).toBe(1);
  expect(result.events.map(e => e.ev)).toEqual(expect.arrayContaining(['burn_start', 'burn_progress', 'burn_end']));
  expect(JSON.stringify(result.events)).not.toMatch(/Hello|你好/); // no caption text in the log

  const withCaption = whiteInLowerThird(outFile, 1.5, path.join(OUT_DIR, 'captions-burn-t1.5.png'));
  const without = whiteInLowerThird(outFile, 4.5, path.join(OUT_DIR, 'captions-burn-t4.5.png'));
  console.log('[captions burn]', JSON.stringify({ codec: result.codec, size: `${ov.width}x${ov.height}`, audio: result.audio, bytes: result.data.length, withCaption, without }));
  expect(withCaption).toBeGreaterThan(without + 200);
  expect(requests).toEqual([]); // nothing was sent anywhere
  expect(consoleErrors).toEqual([]);
});
