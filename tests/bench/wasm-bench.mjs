#!/usr/bin/env node
// Phase 0 bench for the in-browser FFmpeg cores (docs/wasm-bench-baseline.md).
//
//   node tests/bench/make-fixtures.mjs            # lavfi fixtures -> tests/fixtures/bench (gitignored)
//   node tests/bench/wasm-bench.mjs [--browsers chromium,webkit,firefox] [--modes st,mt]
//        [--ops trim_copy,x264_veryfast,...,soak60] [--soak-runs 60] [--out test-results/wasm-bench.json]
//        [--core-root <dir containing core/ and core-mt/>]   # bench another build (Phase 1+)
//
// Serves the repo's node_modules/@ffmpeg packages and the fixtures from a local server with
// COOP/COEP (so mt is possible), then runs every op per browser x mode and records load time,
// exec time, peak measureUserAgentSpecificMemory (Chromium only) and ok/fail/hang/crash.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'bench');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ALL_OPS = ['trim_copy', 'x264_veryfast', 'xfade_join3', 'burn_ass', 'loudnorm', 'thumbnail', 'ffprobe', 'soak60'];
const browsers = arg('browsers', 'chromium,webkit,firefox').split(',');
const modes = arg('modes', 'st,mt').split(',');
const ops = arg('ops', ALL_OPS.join(',')).split(',');
const soakRuns = Number(arg('soak-runs', 60));
const outFile = path.resolve(ROOT, arg('out', 'test-results/wasm-bench.json'));
const coreRoot = arg('core-root', null); // optional: <dir>/core/dist/esm and <dir>/core-mt/dist/esm
// A fork checkout also carries its own @ffmpeg/ffmpeg build (<dir>/ffmpeg/dist/esm); its cores
// need it (the fork's mt exec is async), so it is used whenever it is there.
const forkWrapper = !!coreRoot && existsSync(path.join(coreRoot, 'ffmpeg', 'dist', 'esm', 'index.js'));

if (!existsSync(path.join(FIX, 'src-1080p-60s.mp4'))) { console.error('fixtures missing: run node tests/bench/make-fixtures.mjs'); process.exit(1); }

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json', '.mp4': 'video/mp4' };
function resolve(url) {
  const p = decodeURIComponent(new URL(url, 'http://x').pathname);
  if (p === '/' || p === '/index.html') return path.join(HERE, 'bench.html');
  if (p === '/bench-page.js') return path.join(HERE, 'bench-page.js');
  if (p.startsWith('/fixtures/')) return path.join(FIX, path.basename(p));
  if (coreRoot && /^\/node_modules\/@ffmpeg\/core(-mt)?\//.test(p)) return path.join(path.resolve(coreRoot), p.replace(/^\/node_modules\/@ffmpeg\//, ''));
  if (forkWrapper && p.startsWith('/node_modules/@ffmpeg/ffmpeg/')) return path.join(path.resolve(coreRoot), p.replace(/^\/node_modules\/@ffmpeg\//, ''));
  if (p.startsWith('/node_modules/@ffmpeg/')) return path.join(ROOT, p);
  return null;
}
const server = createServer((req, res) => {
  const file = resolve(req.url);
  const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' };
  if (!file || !file.startsWith(ROOT.slice(0, 1)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, headers); return res.end('not found'); }
  res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': statSync(file).size });
  createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const engines = { chromium, webkit, firefox };
// Full Chromium (not headless-shell): headless-shell refuses measureUserAgentSpecificMemory.
const launchArgs = { chromium: { channel: 'chromium', args: ['--enable-blink-features=ForceEagerMeasureMemory'] } };
const results = { startedAt: new Date().toISOString(), host: { platform: process.platform, cpus: (await import('node:os')).cpus().length }, soakRuns, coreRoot: coreRoot || 'node_modules', wrapper: forkWrapper ? 'core-root/ffmpeg' : 'node_modules/@ffmpeg/ffmpeg', runs: [] };
const save = () => { mkdirSync(path.dirname(outFile), { recursive: true }); writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n'); };

for (const b of browsers) {
  let browser;
  try { browser = await engines[b].launch(launchArgs[b] || {}); }
  catch (e) { console.error(`${b}: launch failed: ${e.message.split('\n')[0]}`); results.runs.push({ browser: b, error: 'launch failed' }); continue; }
  const version = browser.version();
  for (const mode of modes) {
    // Fresh page per op: a hung or crashed op (terminated worker) must not slow down the next
    // one (measured: after the mt xfade hang, leftover pthread workers made later ops ~8x slower).
    const open = async () => {
      const page = await browser.newPage();
      page.on('pageerror', e => console.error(`[${b}/${mode}] pageerror: ${e.message}`));
      await page.goto(base);
      await page.waitForFunction(() => window.benchReady === true);
      return page;
    };
    let page = await open();
    const env = await page.evaluate(() => window.bench.env());
    console.log(`\n== ${b} ${version} / ${mode} (isolated=${env.crossOriginIsolated}, cores=${env.cores})`);
    for (const op of ops) {
      const [row] = await page.evaluate((o) => window.bench.run(o), { mode, ops: [op], soakRuns }).catch(e => [{ op, status: 'crash', error: 'page: ' + e.message.split('\n')[0] }]);
      const MB = (n) => (n ? `${Math.round(n / 2 ** 20)} MB` : '-');
      const mem = `${MB(row.peakCtxBytes)} (total ${MB(row.peakMemBytes)})`;
      console.log(`${op.padEnd(14)} ${String(row.status).padEnd(5)} load ${row.loadMs ?? '-'} ms  exec ${row.execMs ?? '-'} ms  peak ${mem}${row.runsOk != null ? `  soak ${row.runsOk}/${row.runs}` : ''}${row.error ? '  ' + row.error : ''}`);
      results.runs.push({ browser: b, browserVersion: version, mode, env, ...row });
      save();
      await page.close().catch(() => {});
      page = await open();
    }
    await page.close();
  }
  await browser.close();
}
results.finishedAt = new Date().toISOString();
save();
server.close();
console.log(`\nwrote ${path.relative(ROOT, outFile)}`);
