// Optional benchmark (E2E_BENCH=1): larger generated clip, stream-copy trim vs precise
// (libx264 re-encode) trim, mt vs st. Needs system ffmpeg to generate the clip.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-results', 'e2e-v2');
const SIZE = process.env.E2E_BENCH_SIZE || '1920x1080';
const SECONDS = Number(process.env.E2E_BENCH_SECONDS || 30);
const CLIP = path.join(os.tmpdir(), `finalcut-bench-${SIZE}-${SECONDS}s.mp4`);

test.skip(!process.env.E2E_BENCH, 'set E2E_BENCH=1 to run the benchmark');

test.beforeAll(() => {
  if (existsSync(CLIP)) return;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=30:duration=${SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '8M', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', CLIP]);
});

async function trim(page, start, end, precise) {
  await page.evaluate(() => { window.__v2.trim = null; });
  await page.locator('#start').fill(String(start));
  await page.locator('#end').fill(String(end));
  await page.locator('#precise').setChecked(precise);
  await page.getByTestId('trim').click();
  await page.waitForFunction(() => window.__v2?.trim, null, { timeout: 600_000 });
  const r = await page.evaluate(() => window.__v2);
  expect(r.trim.error).toBeUndefined();
  return r;
}

test('benchmark trim copy vs precise', async ({ page }, testInfo) => {
  test.setTimeout(900_000);
  const mode = testInfo.project.metadata.expectedMode;
  await page.goto('/v2/');
  await page.getByTestId('file-input').setInputFiles(CLIP);
  const copy = await trim(page, 2, 12, false);
  // 5 s of 1080p re-encoded with libx264 -preset veryfast.
  const precise = await trim(page, 2, 7, true);
  const out = {
    mode, clip: { size: SIZE, seconds: SECONDS, bytes: statSync(CLIP).size }, cores: await page.evaluate(() => navigator.hardwareConcurrency),
    loadMs: copy.loadMs, copyTrim10sExecMs: copy.trim.execMs, preciseTrim5sExecMs: precise.trim.execMs,
    preciseOutDuration: precise.trim.duration,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(path.join(RESULTS_DIR, `bench-${mode}.json`), JSON.stringify(out, null, 2));
  console.log(`[bench ${mode}]`, JSON.stringify(out));
});
