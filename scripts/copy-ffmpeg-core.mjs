#!/usr/bin/env node
// Copy the self-hosted ffmpeg.wasm cores into the /v2 editor's public dir.
//
//   node_modules/@ffmpeg/core-mt/dist/esm/*  -> v2/public/ffmpeg-core/mt/<ver>/
//   node_modules/@ffmpeg/core/dist/esm/*     -> v2/public/ffmpeg-core/st/<ver>/
//
// Fails loudly if a pinned package or one of its files is missing (the 2025-12 attempt shipped a
// URL for "@ffmpeg/core-st@0.12.x", which never existed). Writes manifest.json with sha256s.
// Only the /v2 build uses this; the existing editor build (`npm run build`) does not.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'v2', 'public', 'ffmpeg-core');

// Single source of truth for the pinned versions (also checked against package.json).
export const PINNED = {
  '@ffmpeg/ffmpeg': '0.12.15',
  '@ffmpeg/util': '0.12.2',
  '@ffmpeg/core': '0.12.10',
  '@ffmpeg/core-mt': '0.12.10',
  '@huggingface/transformers': '4.3.1',
};

// Installed by @huggingface/transformers (pinned in package.json).
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';

const CORES = [
  { mode: 'mt', pkg: '@ffmpeg/core-mt', files: ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'] },
  { mode: 'st', pkg: '@ffmpeg/core', files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'] },
];

function fail(msg) {
  console.error(`copy-ffmpeg-core: ${msg}`);
  process.exit(1);
}

const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
for (const [name, version] of Object.entries(PINNED)) {
  if (declared[name] !== version) fail(`package.json must pin ${name} to exactly ${version} (found ${declared[name]})`);
  const pj = path.join(ROOT, 'node_modules', name, 'package.json');
  if (!existsSync(pj)) fail(`${name} is not installed (run npm ci)`);
  const installed = JSON.parse(readFileSync(pj, 'utf8')).version;
  if (installed !== version) fail(`${name}: installed ${installed}, pinned ${version}`);
}

rmSync(OUT, { recursive: true, force: true });
const manifest = { generatedBy: 'scripts/copy-ffmpeg-core.mjs', packages: PINNED, cores: {} };
for (const { mode, pkg, files } of CORES) {
  const version = PINNED[pkg];
  const src = path.join(ROOT, 'node_modules', pkg, 'dist', 'esm');
  const dest = path.join(OUT, mode, version);
  mkdirSync(dest, { recursive: true });
  manifest.cores[mode] = { package: `${pkg}@${version}`, base: `/v2/ffmpeg-core/${mode}/${version}/`, files: {} };
  for (const f of files) {
    const from = path.join(src, f);
    if (!existsSync(from)) fail(`missing ${pkg}@${version}/dist/esm/${f}`);
    copyFileSync(from, path.join(dest, f));
    const buf = readFileSync(from);
    manifest.cores[mode].files[f] = { bytes: statSync(from).size, sha256: createHash('sha256').update(buf).digest('hex') };
  }
}
// The @ffmpeg/ffmpeg class worker, served from the same isolated path as the cores. Loading it
// from here (classWorkerURL) instead of the app bundle means the worker script always carries
// the COOP/COEP/CORP headers, whatever the page's own asset location sends.
{
  const version = PINNED['@ffmpeg/ffmpeg'];
  const src = path.join(ROOT, 'node_modules', '@ffmpeg/ffmpeg', 'dist', 'esm');
  const dest = path.join(OUT, 'ffmpeg', version);
  mkdirSync(dest, { recursive: true });
  manifest.classWorker = { package: `@ffmpeg/ffmpeg@${version}`, base: `/v2/ffmpeg-core/ffmpeg/${version}/`, files: {} };
  for (const f of ['worker.js', 'const.js', 'errors.js']) {
    const from = path.join(src, f);
    if (!existsSync(from)) fail(`missing @ffmpeg/ffmpeg@${version}/dist/esm/${f}`);
    copyFileSync(from, path.join(dest, f));
    manifest.classWorker.files[f] = { bytes: statSync(from).size, sha256: createHash('sha256').update(readFileSync(from)).digest('hex') };
  }
}
// The ONNX runtime that on-device captions (transformers.js Whisper) run on. Self-hosted here for
// the same reason as the class worker. The factory is copied as .js so it is served as JavaScript.
{
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json'), 'utf8'));
  if (pkg.version !== ORT_VERSION) fail(`onnxruntime-web: installed ${pkg.version}, expected ${ORT_VERSION} (update ORT_VERSION here and in src/whisper.js)`);
  const src = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
  const dest = path.join(OUT, 'ort', ORT_VERSION);
  mkdirSync(dest, { recursive: true });
  manifest.ort = { package: `onnxruntime-web@${ORT_VERSION}`, base: `/v2/ffmpeg-core/ort/${ORT_VERSION}/`, files: {} };
  for (const [from, to] of [['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.js'], ['ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.asyncify.wasm']]) {
    if (!existsSync(path.join(src, from))) fail(`missing onnxruntime-web@${ORT_VERSION}/dist/${from}`);
    copyFileSync(path.join(src, from), path.join(dest, to));
    manifest.ort.files[to] = { bytes: statSync(path.join(src, from)).size, sha256: createHash('sha256').update(readFileSync(path.join(src, from))).digest('hex') };
  }
}
writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`copy-ffmpeg-core: wrote ${path.relative(ROOT, OUT)} (mt + st ${PINNED['@ffmpeg/core']})`);
