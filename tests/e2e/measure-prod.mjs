// Real-network measurements of /v2 against a deployed site (read-only: GET only).
//   node tests/e2e/measure-prod.mjs https://grepawk.com [runs=2] [browsers=chromium,webkit]
// For each browser x engine (auto, ?wasm=st): cold = fresh context (empty HTTP cache) -> load core +
// copy trim + precise (x264) trim; warm = second page in the same context (cached core).
// WebKit is Playwright's WebKit build on Linux: a Safari engine proxy, NOT iOS Safari.
import { chromium, webkit } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'testclip-6s.mp4');
const BASE = process.argv[2] || 'https://grepawk.com';
const RUNS = Number(process.argv[3] || 2);
const BROWSERS = (process.argv[4] || 'chromium,webkit').split(',');
const engines = { chromium, webkit };

async function trim(page, start, end, precise) {
  await page.evaluate(() => { window.__v2.trim = null; });
  await page.locator('#start').fill(String(start));
  await page.locator('#end').fill(String(end));
  await page.locator('#precise').setChecked(precise);
  const t0 = Date.now();
  await page.getByTestId('trim').click();
  await page.waitForFunction(() => window.__v2?.trim, null, { timeout: 300_000 });
  const r = await page.evaluate(() => window.__v2);
  if (r.trim.error) throw new Error(r.trim.error);
  return { ...r, wallMs: Date.now() - t0 };
}

async function session(page, q) {
  const nonGet = [];
  page.on('request', (req) => { if (!['GET', 'HEAD'].includes(req.method())) nonGet.push(`${req.method()} ${req.url()}`); });
  const t0 = Date.now();
  await page.goto(`${BASE}/v2/${q}`, { waitUntil: 'load' });
  const env = await page.evaluate(() => ({ coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function', cores: navigator.hardwareConcurrency, ua: navigator.userAgent }));
  const pageLoadMs = Date.now() - t0;
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await page.waitForFunction(() => window.__v2?.loadMs != null || window.__v2?.error, null, { timeout: 300_000 });
  const loaded = await page.evaluate(() => ({ mode: window.__v2.mode, loadMs: window.__v2.loadMs, error: window.__v2.error, fallbackReason: window.__v2.fallbackReason }));
  if (loaded.error) throw new Error(`load: ${loaded.error}`);
  const copy = await trim(page, 1, 3, false);
  const precise = await trim(page, 1, 3, true);
  const wasm = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.endsWith('.wasm')).map((e) => ({ name: e.name.split('/v2/')[1], ms: Math.round(e.duration), transfer: e.transferSize, decoded: e.decodedBodySize })));
  return { ...env, pageLoadMs, mode: loaded.mode, fallbackReason: loaded.fallbackReason, coreLoadMs: loaded.loadMs, copyTrimMs: copy.trim.execMs, copyOutS: +copy.trim.duration?.toFixed(2), preciseTrimMs: precise.trim.execMs, preciseOutS: +precise.trim.duration?.toFixed(2), wasm, nonGet };
}

const out = [];
for (const b of BROWSERS) {
  const browser = await engines[b].launch({ headless: true });
  for (const [label, q] of [['auto', ''], ['st', '?wasm=st']]) {
    for (let i = 0; i < RUNS; i++) {
      const ctx = await browser.newContext();
      try {
        const cold = await session(await ctx.newPage(), q);
        const warm = await session(await ctx.newPage(), q);
        const row = { browser: b, version: browser.version(), engine: label, run: i + 1, cold, warm };
        out.push(row);
        console.log(JSON.stringify({ b, label, run: i + 1, coi: cold.coi, mode: cold.mode, coldLoad: cold.coreLoadMs, warmLoad: warm.coreLoadMs, copy: [cold.copyTrimMs, warm.copyTrimMs], precise: [cold.preciseTrimMs, warm.preciseTrimMs], wasm: cold.wasm, warmWasm: warm.wasm, nonGet: [...cold.nonGet, ...warm.nonGet] }));
      } catch (e) {
        out.push({ browser: b, engine: label, run: i + 1, error: String(e.message || e) });
        console.log(`ERROR ${b} ${label} run ${i + 1}: ${e.message || e}`);
      } finally { await ctx.close(); }
    }
  }
  await browser.close();
}
const dir = path.join(HERE, '..', '..', 'test-results', 'e2e-v2');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'prod-measure.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), rows: out }, null, 2));
