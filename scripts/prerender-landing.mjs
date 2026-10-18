#!/usr/bin/env node
// Pre-render the landing page into dist/index.html (run after `vite build`, part of `npm run build`).
// Crawlers and the first paint then get the real landing content (h1, sections, links) before the
// JS bundle runs; src/main.jsx's createRoot().render() replaces it with the same component.
// Asset URLs come from a Vite SSR build of the same sources, so their content hashes match the
// client build; the script fails if any /assets/ URL in the markup is missing from dist/.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'node_modules', '.cache', 'prerender-landing');
const MARKER = '<div id="root"></div>';

const indexPath = path.join(DIST, 'index.html');
if (!existsSync(indexPath)) throw new Error('dist/index.html is missing; run vite build first');
const indexHtml = readFileSync(indexPath, 'utf8');
if (!indexHtml.includes(MARKER)) throw new Error(`dist/index.html has no ${MARKER} (already pre-rendered?)`);

rmSync(OUT, { recursive: true, force: true });
await build({
  configFile: false,
  root: ROOT,
  base: '/',
  logLevel: 'warn',
  plugins: [react()],
  build: {
    ssr: 'src/prerender/landing-entry.jsx',
    outDir: OUT,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'landing-entry.mjs' } },
  },
});

const { renderLanding } = await import(pathToFileURL(path.join(OUT, 'landing-entry.mjs')).href);
const markup = renderLanding();
if (!markup.includes('<h1>')) throw new Error('pre-rendered landing has no <h1>');

const missing = [...new Set(markup.match(/\/assets\/[^"')\s]+/g) || [])]
  .filter((url) => !existsSync(path.join(DIST, url)));
if (missing.length) throw new Error(`pre-rendered landing references assets missing from dist: ${missing.join(', ')}`);

writeFileSync(indexPath, indexHtml.replace(MARKER, `<div id="root">${markup}</div>`));
rmSync(OUT, { recursive: true, force: true });
console.log(`pre-rendered landing into dist/index.html (${markup.length} chars of HTML)`);
