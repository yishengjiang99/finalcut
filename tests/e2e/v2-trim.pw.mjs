// E2E: /v2 loads the self-hosted ffmpeg.wasm core (mt when isolated, st otherwise), trims a local
// clip in the browser, and NEVER uploads media. Every request (page + workers) is intercepted.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'testclip-6s.mp4');
const RESULTS_DIR = path.join(HERE, '..', '..', 'test-results', 'e2e-v2');

// Endpoints the /v2 editor may write to (text/metadata only). Empty for the spike; the full port
// adds e.g. '/api/v2/chat'. Anything else that is not GET/HEAD fails the test.
const ALLOWED_WRITE_ENDPOINTS = [];
const LEGACY_MEDIA_ROUTES = [
  /^\/api\/process-video/, /^\/api\/jobs\/process-video/, /^\/api\/transition-videos/,
  /^\/api\/ffmpeg-cli\/run/, /^\/api\/generate-captions/, /^\/api\/lyric-captions(\/.*)?$/,
];
const MAX_BODY_BYTES = 64 * 1024;
const MEDIA_CT = /^(video|audio|image)\/|multipart\/form-data|application\/octet-stream/i;

function ffprobeDuration(file) {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
  } catch {
    return null; // no native ffprobe: fall back to the <video> element duration
  }
}

/** Intercept every request in the context and record what would leave the browser. */
async function installNetworkGuard(context, page, baseURL) {
  const log = [];
  const fixture = readFileSync(FIXTURE);
  const fixtureProbe = fixture.subarray(1024, 1024 + 4096); // a chunk of the actual media bytes
  const origin = new URL(baseURL).origin;
  const record = (source, req) => {
    const url = req.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) return; // local, never leaves the device
    const body = req.postDataBuffer();
    log.push({
      source, url, method: req.method(),
      bodyBytes: body ? body.length : 0,
      contentType: req.headers()['content-type'] || '',
      containsFixtureBytes: body ? body.includes(fixtureProbe) : false,
    });
  };
  // route() sees page and dedicated-worker requests in Chromium and can block them.
  await context.route('**/*', async (route) => {
    const req = route.request();
    record('route', req);
    const u = new URL(req.url());
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method());
    if (u.origin !== origin || (isWrite && !ALLOWED_WRITE_ENDPOINTS.includes(u.pathname))) return route.abort('blockedbyclient');
    return route.continue();
  });
  context.on('request', (req) => record('event', req));
  // Belt and braces: raw CDP view of the page target (covers anything route() might miss).
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (request.url.startsWith('blob:') || request.url.startsWith('data:')) return;
    const bodyBytes = request.postData ? Buffer.byteLength(request.postData) : 0;
    log.push({ source: 'cdp', url: request.url, method: request.method, bodyBytes, contentType: request.headers['Content-Type'] || request.headers['content-type'] || '', containsFixtureBytes: false });
  });
  return { log, origin, fixtureSize: fixture.length };
}

function assertNoUpload({ log, origin, fixtureSize }) {
  const problems = [];
  let totalBody = 0;
  for (const r of log) {
    const u = new URL(r.url);
    totalBody += r.bodyBytes;
    if (u.origin !== origin) problems.push(`third-party request: ${r.method} ${r.url}`);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method) && !ALLOWED_WRITE_ENDPOINTS.includes(u.pathname)) problems.push(`non-allowlisted ${r.method} ${u.pathname}`);
    if (LEGACY_MEDIA_ROUTES.some((re) => re.test(u.pathname))) problems.push(`legacy media route: ${r.method} ${u.pathname}`);
    if (r.bodyBytes > MAX_BODY_BYTES) problems.push(`large body (${r.bodyBytes} B): ${r.method} ${u.pathname}`);
    if (r.bodyBytes > 0 && MEDIA_CT.test(r.contentType)) problems.push(`media content-type ${r.contentType}: ${r.method} ${u.pathname}`);
    if (r.containsFixtureBytes) problems.push(`request body contains fixture media bytes: ${r.method} ${u.pathname}`);
  }
  if (totalBody > 0.05 * fixtureSize) problems.push(`total request-body bytes ${totalBody} > 5% of fixture`);
  expect(problems, problems.join('\n')).toEqual([]);
  return { requests: log.length, totalBodyBytes: totalBody, nonGet: log.filter((r) => !['GET', 'HEAD'].includes(r.method)).length };
}

async function trimOnce(page, { start, end, precise = false }) {
  await page.evaluate(() => { window.__v2.trim = null; });
  await page.locator('#start').fill(String(start));
  await page.locator('#end').fill(String(end));
  await page.locator('#precise').setChecked(precise);
  await page.getByTestId('trim').click();
  await page.waitForFunction(() => window.__v2?.trim, null, { timeout: 120_000 });
  const report = await page.evaluate(() => window.__v2);
  expect(report.trim.error, `trim error: ${report.trim.error}`).toBeUndefined();
  return report;
}

test('trim runs in the browser with no media upload', async ({ page, context, baseURL }, testInfo) => {
  const { expectedMode, isolated, query = '' } = testInfo.project.metadata;
  const guard = await installNetworkGuard(context, page, baseURL);
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  // Headers on the /v2 document and the wasm MIME type.
  const docResp = await page.goto(`/v2/${query}`);
  const h = docResp.headers();
  if (isolated) {
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-embedder-policy']).toBe('require-corp');
  } else {
    expect(h['cross-origin-embedder-policy']).toBeUndefined();
  }
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(isolated);
  const wasmHead = await page.request.head(`/v2/ffmpeg-core/${expectedMode}/0.12.10/ffmpeg-core.wasm`);
  expect(wasmHead.headers()['content-type']).toBe('application/wasm');
  await expect(page.getByTestId('licenses-link')).toHaveAttribute('href', '/legal/licenses.html');

  // Cold: load core + trim 1..3 s.
  const fixtureBytes = statSync(FIXTURE).size;
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  const t0 = Date.now();
  const cold = await trimOnce(page, { start: 1, end: 3 });
  const coldWallMs = Date.now() - t0;
  expect(cold.mode).toBe(expectedMode);
  expect(cold.trim.duration).toBeGreaterThan(1.85);
  expect(cold.trim.duration).toBeLessThan(2.15);

  // Download the result and verify with native ffprobe when available.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `trimmed-${expectedMode}.mp4`);
  await download.saveAs(outFile);
  const probed = ffprobeDuration(outFile);
  if (probed !== null) {
    expect(probed).toBeGreaterThan(1.85);
    expect(probed).toBeLessThan(2.15);
  }

  // Second trim on the same engine (exec only, core already loaded).
  const second = await trimOnce(page, { start: 0.5, end: 4.5 });
  expect(second.trim.duration).toBeGreaterThan(3.85);
  expect(second.trim.duration).toBeLessThan(4.6);

  // Precise trim = libx264 re-encode. Guards the mt x264 thread-cap deadlock (see ffmpegHost.threads).
  const precise = await trimOnce(page, { start: 1, end: 3, precise: true });
  expect(precise.trim.duration).toBeGreaterThan(1.9);
  expect(precise.trim.duration).toBeLessThan(2.1);
  expect(precise.trim.argv.join(' ')).toContain('libx264');
  if (expectedMode === 'mt') expect(precise.trim.argv.join(' ')).toMatch(/-threads [1-4] /);

  // Warm load: new page in the same context (HTTP cache holds the immutable core files).
  const page2 = await context.newPage();
  await page2.goto(`/v2/${query}`);
  await page2.getByTestId('file-input').setInputFiles(FIXTURE);
  const warm = await trimOnce(page2, { start: 1, end: 3 });
  expect(warm.mode).toBe(expectedMode);

  const net = assertNoUpload(guard);
  expect(consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);

  const timings = {
    mode: expectedMode, crossOriginIsolated: isolated, fixtureBytes,
    coldLoadMs: cold.loadMs, coldTrimExecMs: cold.trim.execMs, coldWallMs,
    secondTrimExecMs: second.trim.execMs, preciseTrimExecMs: precise.trim.execMs,
    warmLoadMs: warm.loadMs, warmTrimExecMs: warm.trim.execMs,
    outputDurationVideoEl: cold.trim.duration, outputDurationFfprobe: probed, outputBytes: cold.trim.bytes,
    network: net,
  };
  writeFileSync(path.join(RESULTS_DIR, `timings-${expectedMode}.json`), JSON.stringify(timings, null, 2));
  console.log(`[timings ${expectedMode}]`, JSON.stringify(timings));
  await testInfo.attach(`timings-${expectedMode}`, { body: JSON.stringify(timings, null, 2), contentType: 'application/json' });
});

test('guard self-test: a media POST is detected and blocked', async ({ page, context, baseURL }) => {
  const guard = await installNetworkGuard(context, page, baseURL);
  await page.goto('/v2/');
  const bytes = readFileSync(FIXTURE).toString('base64');
  await page.evaluate(async (b64) => {
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await fetch('/api/process-video', { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: buf }).catch(() => {});
  }, bytes);
  expect(() => assertNoUpload(guard)).toThrow();
  const hit = guard.log.find((r) => r.source === 'route' && r.url.endsWith('/api/process-video'));
  expect(guard.log.some((r) => r.source === 'cdp' && r.url.endsWith('/api/process-video'))).toBe(true);
  expect(hit.bodyBytes).toBeGreaterThan(MAX_BODY_BYTES);
  expect(hit.containsFixtureBytes).toBe(true);
});
