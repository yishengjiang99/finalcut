#!/usr/bin/env node
// Generate server/ffmpeg/wasm-capabilities.json: the filters/encoders/decoders/muxers/demuxers
// of the self-hosted ffmpeg.wasm core, enumerated by running the core's own -filters/-encoders/…
// in headless Chrome through FFmpegHost.query().
//
//   node scripts/generate-wasm-capabilities.mjs [--port 5211]
//
// Spawns a vite dev server (the core must be copied first: node scripts/copy-ffmpeg-core.mjs),
// loads the core in the page, and writes the JSON. Both cores (mt/st) are the same FFmpeg 5.1
// build, so one catalog covers both. Uses the Playwright-bundled Chromium, or E2E_CHROME_PATH.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'server', 'ffmpeg', 'wasm-capabilities.json');

const portArg = process.argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 5211;

function startVite() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'pipe' });
    let ready = false;
    const onData = (d) => {
      const s = String(d);
      if (!ready && /Local:.*http/.test(s)) { ready = true; resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    setTimeout(() => { if (!ready) { child.kill(); reject(new Error('vite did not start')); } }, 60000);
  });
}

const waitFor = (url, tries = 60) => (async () => {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`never became ready: ${url}`);
})();

const QUERIES = {
  version: ['-hide_banner', '-version'],
  filters: ['-hide_banner', '-filters'],
  encoders: ['-hide_banner', '-encoders'],
  decoders: ['-hide_banner', '-decoders'],
  muxers: ['-hide_banner', '-muxers'],
  demuxers: ['-hide_banner', '-demuxers'],
};

// "ffmpeg version 5.1 Copyright ..." -> "5.1"
const parseVersion = (lines) => /ffmpeg version (\S+)/.exec(lines[0] || '')?.[1] || null;
// " T.C 3dostr             VV->VV     3D text object renderer" -> { name, description }
const parseFilters = (lines) => lines
  .map(l => /^\s*[.TSC]{3}\s+([A-Za-z0-9_]+)\s+\S+\s+(.*\S)\s*$/.exec(l))
  .filter(Boolean)
  .map(m => ({ name: m[1], description: m[2].trim() }));
// " V....D libx264              libx264 H.264 / AVC ..." -> { name, description }
// Flags are V/A/S + 5 of .FSXBD; legend lines (" V..... = Video") are skipped by the name class.
const parseCodecs = (lines) => lines
  .map(l => /^\s*[VAS][.FSXBD]{5}\s+([A-Za-z0-9_]+)\s+(.*\S)\s*$/.exec(l))
  .filter(Boolean)
  .map(m => ({ name: m[1], description: m[2].trim() }));
// " E mp4                  MP4 (MPEG-4 Part 14)" -> { name, description }
const parseFormats = (lines) => lines
  .map(l => /^\s*[ E][DE ]\s+([A-Za-z0-9_]+)\s+(.*\S)\s*$/.exec(l))
  .filter(Boolean)
  .map(m => ({ name: m[1], description: m[2].trim() }));

const vite = await startVite();
console.error('[gen] vite up');
try {
  await waitFor(`http://127.0.0.1:${PORT}/legal/terms.html`);
  console.error('[gen] vite ready');
  const { chromium } = await import('@playwright/test');
  console.error('[gen] playwright imported');
  const launchOpts = { args: ['--no-sandbox'] };
  if (process.env.E2E_CHROME_PATH) launchOpts.executablePath = process.env.E2E_CHROME_PATH;
  const browser = await chromium.launch(launchOpts);
  console.error('[gen] browser launched');
  try {
    const page = await browser.newPage();
    console.error('[gen] page created');
    await page.goto(`http://127.0.0.1:${PORT}/legal/terms.html`);
    console.error('[gen] page loaded');
    const raw = await page.evaluate(async (QUERIES) => {
      const { FFmpegHost } = await import('/src/wasm/ffmpegHost.js');
      const host = new FFmpegHost({ selfHostedWorker: true });
      await host.load();
      const out = { mode: host.mode };
      for (const [key, argv] of Object.entries(QUERIES)) out[key] = await host.query(argv, { timeoutMs: 120_000 });
      host.terminate();
      return out;
    }, QUERIES);
    console.error('[gen] queries done');
    const catalog = {
      generated: new Date().toISOString(),
      ffmpeg: parseVersion(raw.version),
      core: (await import('../src/wasm/ffmpegHost.js')).CORE_VERSION,
      mode: raw.mode,
      filters: parseFilters(raw.filters),
      encoders: parseCodecs(raw.encoders),
      decoders: parseCodecs(raw.decoders),
      muxers: parseFormats(raw.muxers),
      demuxers: parseFormats(raw.demuxers),
    };
    for (const k of ['filters', 'encoders', 'decoders', 'muxers', 'demuxers']) {
      if (!catalog[k].length) throw new Error(`parsed zero ${k}; the core query must have failed`);
    }
    writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n');
    console.log(`wrote ${path.relative(ROOT, OUT)}: ffmpeg ${catalog.ffmpeg}, ` +
      ['filters', 'encoders', 'decoders', 'muxers', 'demuxers'].map(k => `${catalog[k].length} ${k}`).join(', '));
  } finally {
    await browser.close();
  }
} finally {
  vite.kill();
}
