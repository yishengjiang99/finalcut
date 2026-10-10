#!/usr/bin/env node
// Corresponding Source for the self-hosted ffmpeg.wasm cores (GPL-2.0-or-later).
//
// Downloads every archive listed in vendor/ffmpeg-source.lock.json, verifies the pinned SHA-256
// (and size, and, where available, the git commit id embedded in GitHub tarballs / the SDL2
// sha512 pinned by Emscripten), and publishes them next to the wasm:
//
//   v2/public/vendor/ffmpeg/source/            -> served as /v2/vendor/ffmpeg/source/
//     <archives>, SHA256SUMS, versions.json, index.html, BUILD.txt, licenses/<id>/<file>
//
// ANY checksum/size/commit mismatch exits non-zero, which fails `npm run build:v2`.
// Downloads are cached in .cache/ffmpeg-source/ (gitignored) and re-verified on every run.
//
//   node scripts/fetch-ffmpeg-source.mjs            # fetch + verify + publish
//   node scripts/fetch-ffmpeg-source.mjs --verify   # verify cache only (no network), no publish
// Needs: tar (with xz support) and unzip on PATH.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Env overrides exist for tests only.
const LOCK_PATH = process.env.FFMPEG_SOURCE_LOCK || path.join(ROOT, 'vendor', 'ffmpeg-source.lock.json');
const CACHE = process.env.FFMPEG_SOURCE_CACHE || path.join(ROOT, '.cache', 'ffmpeg-source');
const OUT = path.join(ROOT, 'v2', 'public', 'vendor', 'ffmpeg', 'source');
const PUBLIC_BASE = '/v2/vendor/ffmpeg/source/';
const VERIFY_ONLY = process.argv.includes('--verify');

const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const errors = [];
const fail = (msg) => { errors.push(msg); console.error(`fetch-ffmpeg-source: ${msg}`); };
const sha = (algo, file) => createHash(algo).update(readFileSync(file)).digest('hex');

async function download(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tmp = `${dest}.part`;
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      renameSync(tmp, dest);
      return;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  retry ${attempt} for ${url}: ${err.message}`);
    }
  }
}

function tarCommitId(file) {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    console.warn('  (git not found: skipping embedded commit-id check)');
    return null;
  }
  try {
    return execFileSync('sh', ['-c', 'gzip -dc "$1" | git get-tar-commit-id', 'sh', file]).toString().trim();
  } catch {
    return null;
  }
}

function archiveRoot(file) {
  const list = file.endsWith('.zip')
    ? execFileSync('unzip', ['-Z1', file], { maxBuffer: 64 << 20 }).toString()
    : execFileSync('tar', ['-tf', file], { maxBuffer: 64 << 20 }).toString();
  return list.split('\n')[0].split('/')[0];
}

function extractMember(file, member) {
  return file.endsWith('.zip')
    ? execFileSync('unzip', ['-p', file, member], { maxBuffer: 64 << 20 })
    : execFileSync('tar', ['-xOf', file, member], { maxBuffer: 64 << 20 });
}

mkdirSync(CACHE, { recursive: true });
for (const c of lock.components) {
  const cached = path.join(CACHE, c.file);
  if (!existsSync(cached) || sha('sha256', cached) !== c.sha256) {
    if (VERIFY_ONLY) { fail(`${c.file}: not in cache or checksum mismatch`); continue; }
    console.log(`  downloading ${c.file} (${(c.bytes / 1e6).toFixed(1)} MB)`);
    try { await download(c.url, cached); } catch (err) { fail(`${c.file}: download failed: ${err.message}`); continue; }
  }
  const got = sha('sha256', cached);
  const size = statSync(cached).size;
  if (got !== c.sha256) { fail(`${c.file}: SHA-256 mismatch (got ${got}, pinned ${c.sha256})`); rmSync(cached, { force: true }); continue; }
  if (size !== c.bytes) { fail(`${c.file}: size mismatch (got ${size}, pinned ${c.bytes})`); continue; }
  if (c.verify?.tarCommitId) {
    const id = tarCommitId(cached);
    if (id !== null && id !== '' && id !== c.verify.tarCommitId) fail(`${c.file}: embedded commit ${id} != ${c.verify.tarCommitId}`);
  }
  if (c.verify?.sha512 && sha('sha512', cached) !== c.verify.sha512) fail(`${c.file}: SHA-512 does not match ${c.verify.sha512Source}`);
  console.log(`  ok  ${c.sha256}  ${c.file}`);
}
if (errors.length) {
  console.error(`fetch-ffmpeg-source: ${errors.length} error(s); refusing to publish. If an upstream archive was regenerated, re-verify it (commit id, signatures) before changing the pinned checksum in vendor/ffmpeg-source.lock.json.`);
  process.exit(1);
}
if (VERIFY_ONLY) { console.log('fetch-ffmpeg-source: cache verified'); process.exit(0); }

// ── Publish ───────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(OUT, 'licenses'), { recursive: true });
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const rows = [];
for (const c of lock.components) {
  const src = path.join(CACHE, c.file);
  const dest = path.join(OUT, c.file);
  try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
  const licenseLinks = [];
  if (c.licenseFiles?.length) {
    const root = archiveRoot(src);
    for (const lf of c.licenseFiles) {
      const flat = lf.replace(/\//g, '_');
      const outRel = `licenses/${c.id}/${/\.txt$/i.test(flat) ? flat : `${flat}.txt`}`;
      let data;
      try { data = extractMember(src, `${root}/${lf}`); } catch { fail(`${c.file}: license file ${lf} not found`); continue; }
      mkdirSync(path.dirname(path.join(OUT, outRel)), { recursive: true });
      writeFileSync(path.join(OUT, outRel), data);
      licenseLinks.push(outRel);
    }
  }
  c.licenseLinks = licenseLinks;
  rows.push(c);
}
if (errors.length) process.exit(1);

writeFileSync(path.join(OUT, 'SHA256SUMS'), lock.components.map((c) => `${c.sha256}  ${c.file}`).join('\n') + '\n');
const versions = {
  packages: lock.packages,
  buildRecipe: lock.buildRecipe,
  components: lock.components.map(({ licenseLinks, ...c }) => ({ ...c, href: `${PUBLIC_BASE}${c.file}`, licenses: licenseLinks.map((l) => `${PUBLIC_BASE}${l}`) })),
};
writeFileSync(path.join(OUT, 'versions.json'), JSON.stringify(versions, null, 2) + '\n');
const r = lock.buildRecipe;
writeFileSync(path.join(OUT, 'BUILD.txt'), [
  'How @ffmpeg/core 0.12.10 and @ffmpeg/core-mt 0.12.10 (served from /v2/ffmpeg-core/) are built',
  '',
  `Build recipe: ${r.repository} at commit ${r.commit}`,
  `  archive here: ffmpeg.wasm-71aa99d3.tar.gz (Dockerfile, Makefile, build/*.sh, src/bind, src/fftools)`,
  `Toolchain image: ${r.toolchainImage}`,
  '',
  r.howToBuild,
  '',
  'Every library source the Dockerfile fetches is in this directory at the exact commit/tag it uses',
  '(see versions.json and SHA256SUMS). To build offline, point each `ADD <git url>#<ref>` line in the',
  'Dockerfile at the matching extracted archive here.',
  '',
  'We serve the npm packages unmodified (sha256 of each served file: /v2/ffmpeg-core/manifest.json).',
  '',
].join('\n'));
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
writeFileSync(path.join(OUT, 'index.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Source code for the FFmpeg WebAssembly core</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:64rem;margin:2rem auto;padding:0 1rem;line-height:1.45;color:#111}
table{border-collapse:collapse;width:100%;font-size:.85rem}th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}code{font-size:.8rem;word-break:break-all}</style></head>
<body>
<h1>Corresponding Source: ffmpeg.wasm core 0.12.10</h1>
<p>Complete source code for <code>@ffmpeg/core@0.12.10</code> and <code>@ffmpeg/core-mt@0.12.10</code>, which this site serves from
<code>/v2/ffmpeg-core/</code>, including the scripts used to build them. Licenses: see <a href="/legal/licenses.html">/legal/licenses.html</a>.</p>
<p><a href="SHA256SUMS">SHA256SUMS</a> · <a href="versions.json">versions.json</a> · <a href="BUILD.txt">BUILD.txt</a> (how to rebuild)</p>
<table><tr><th>Component</th><th>Version / ref</th><th>Commit</th><th>License</th><th>Archive</th><th>Size</th><th>SHA-256</th><th>License texts</th></tr>
${rows.map((c) => `<tr><td>${esc(c.name)}<br><small>${esc(c.role)}</small></td><td>${esc(c.version)}<br><small>${esc(c.ref)}</small></td><td><code>${esc(c.commit || '')}</code></td><td>${esc(c.license)}</td><td><a href="${esc(c.file)}">${esc(c.file)}</a></td><td>${mb(c.bytes)}</td><td><code>${c.sha256}</code></td><td>${c.licenseLinks.map((l) => `<a href="${esc(l)}">${esc(l.split('/').pop())}</a>`).join('<br>')}</td></tr>`).join('\n')}
</table>
</body></html>
`);
const total = lock.components.reduce((n, c) => n + c.bytes, 0);
console.log(`fetch-ffmpeg-source: published ${lock.components.length} archives (${mb(total)}) + licenses to ${path.relative(ROOT, OUT)}`);
