#!/usr/bin/env node
// Contract test for the server endpoints the FinalCap iOS app (and the current web editor) use.
// Safe against production: only GETs, plus POSTs that are rejected before any side effect
// (no credentials -> 401, or invalid input -> 400). No media is sent, no user/session/job/token
// is created. Run it before and after a deploy:
//
//   node tests/contract/ios-endpoints.mjs --base https://grepawk.com --record /tmp/before.json
//   ...deploy...
//   node tests/contract/ios-endpoints.mjs --base https://grepawk.com --compare /tmp/before.json
//
// Exit code 0 = all contracts hold (and, with --compare, nothing drifted).
// Rate-limit note: the auth-gate checks hit videoProcessLimiter routes (20 req / 15 min / IP)
// about 6 times per run. --skip-gates skips them.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const BASE = (opt('--base', process.env.CONTRACT_BASE_URL || 'http://localhost:3001')).replace(/\/$/, '');
const RECORD = opt('--record');
const COMPARE = opt('--compare');
const SKIP_GATES = argv.includes('--skip-gates');
const IOS_BUILD = opt('--ios-build', '42');
const IOS_UA = `FinalCap-iOS/${IOS_BUILD}`;
const WEB_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 finalcut-contract';
const SNAPSHOT_HEADERS = ['content-type', 'cache-control', 'vary', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy'];

const results = [];
const snapshot = { base: BASE, checks: {} };

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
/** Recursive shape: keys + types (arrays described by their first element). */
function shape(v, depth = 0) {
  if (depth > 6) return typeOf(v);
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k], depth + 1)]));
  return typeOf(v);
}

async function call(method, path, { headers = {}, body } = {}) {
  const res = await fetch(BASE + path, {
    method, redirect: 'manual',
    headers: { 'User-Agent': IOS_UA, Accept: 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: Object.fromEntries(res.headers), text, json };
}

/**
 * @param {string} id stable check id
 * @param {() => Promise<object>} run returns the response
 * @param {(r) => void} verify throws on contract violation
 * @param {{deterministic?: boolean}} o deterministic bodies are hashed for --compare
 */
async function check(id, run, verify, { deterministic = false } = {}) {
  let r;
  try {
    r = await run();
    verify(r);
    results.push({ id, ok: true, status: r.status });
  } catch (err) {
    results.push({ id, ok: false, status: r?.status, error: err.message });
  }
  if (r) {
    snapshot.checks[id] = {
      status: r.status,
      headers: Object.fromEntries(SNAPSHOT_HEADERS.filter((h) => r.headers[h] !== undefined).map((h) => [h, r.headers[h]])),
      shape: r.json === undefined ? null : shape(r.json),
      ...(deterministic ? { bodySha256: createHash('sha256').update(r.text).digest('hex') } : {}),
    };
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const isJson = (r) => assert(/application\/json/.test(r.headers['content-type'] || ''), `expected JSON, got ${r.headers['content-type']}`);
const authRequired = (r) => { assert(r.status === 401, `expected 401, got ${r.status}`); isJson(r); assert(typeof r.json?.error === 'string', 'expected {error}'); };

// ── Public / pre-login ───────────────────────────────────────────────────────
await check('GET /api/health', () => call('GET', '/api/health'), (r) => {
  assert(r.status === 200 || r.status === 503, `status ${r.status}`);
  isJson(r);
  const j = r.json;
  assert(typeof j.ok === 'boolean', 'ok');
  for (const k of ['version', 'commit', 'uptimeSec', 'ffmpeg', 'db']) assert(k in j, `missing ${k}`);
  assert(j.ffmpeg && 'version' in j.ffmpeg && 'heic' in j.ffmpeg && 'heicVia' in j.ffmpeg, 'ffmpeg shape');
  assert(/no-store/.test(r.headers['cache-control'] || ''), 'Cache-Control: no-store');
});

for (const media of ['video', 'photo']) {
  await check(`GET /api/ios/suggestions media=${media}`, () => call('GET', `/api/ios/suggestions?build=${IOS_BUILD}&media=${media}`), (r) => {
    assert(r.status === 200, `status ${r.status}`);
    isJson(r);
    assert(Array.isArray(r.json.suggestions), 'suggestions[]');
    assert(Number.isFinite(r.json.ttl), 'ttl');
    for (const s of r.json.suggestions) assert(s.id && s.label && s.prompt, 'suggestion {id,label,prompt}');
    assert(/max-age=\d+/.test(r.headers['cache-control'] || ''), 'Cache-Control max-age');
  }, { deterministic: true });
}

let iosToolCount = 0;
await check('GET /api/tools/schema (iOS UA)', () => call('GET', '/api/tools/schema'), (r) => {
  assert(r.status === 200, `status ${r.status}`);
  isJson(r);
  assert(r.json.schemaVersion === '1', `schemaVersion ${r.json.schemaVersion}`);
  assert(Array.isArray(r.json.tools) && r.json.tools.length > 0, 'tools[] non-empty for iOS');
  for (const t of r.json.tools) assert(t.type === 'function' && t.function?.name && t.function?.parameters, 'tool shape');
  assert(r.json.mediaTypes && typeof r.json.mediaTypes === 'object', 'mediaTypes');
  assert(/User-Agent/i.test(r.headers.vary || ''), 'Vary: User-Agent');
  iosToolCount = r.json.tools.length;
}, { deterministic: true });

await check('GET /api/tools/schema (web UA)', () => call('GET', '/api/tools/schema', { headers: { 'User-Agent': WEB_UA } }), (r) => {
  assert(r.status === 200, `status ${r.status}`);
  assert(r.json.schemaVersion === '1', 'schemaVersion');
  assert(r.json.tools.length >= iosToolCount, 'web gets all tools (>= iOS allowlist)');
}, { deterministic: true });

await check('GET /api/auth/status (no auth)', () => call('GET', '/api/auth/status'), (r) => {
  assert(r.status === 200, `status ${r.status}`);
  isJson(r);
  assert(r.json.authenticated === false, 'authenticated:false');
}, { deterministic: true });

await check('GET /api/auth/status (invalid Bearer)', () => call('GET', '/api/auth/status', { headers: { Authorization: 'Bearer contract-test-invalid-token' } }), (r) => {
  assert(r.status === 200, `status ${r.status}`);
  assert(r.json.authenticated === false, 'authenticated:false');
}, { deterministic: true });

// ── Mobile auth: invalid input is rejected before any DB write ──────────────
const jsonBody = (o) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
await check('POST /api/auth/mobile/device (invalid id)', () => call('POST', '/api/auth/mobile/device', jsonBody({ deviceInstallId: 'not-a-uuid' })), (r) => {
  assert(r.status === 400, `status ${r.status}`);
  assert(typeof r.json?.error === 'string', '{error}');
}, { deterministic: true });
await check('POST /api/auth/mobile/google (no idToken)', () => call('POST', '/api/auth/mobile/google', jsonBody({})), (r) => {
  assert(r.status === 400, `status ${r.status}`);
  assert(typeof r.json?.error === 'string', '{error}');
}, { deterministic: true });
await check('POST /api/auth/mobile/apple-iap (no session)', () => call('POST', '/api/auth/mobile/apple-iap', jsonBody({})), (r) => {
  assert(r.status === 401, `status ${r.status}`);
  assert(typeof r.json?.error === 'string', '{error}');
}, { deterministic: true });

// ── Auth gates: protected iOS routes reject anonymous callers (no media sent) ─
const gates = [
  ['POST', '/api/chat', jsonBody({ execution: 'client', messages: [] })],
  ['GET', '/api/jobs/contract-test-nonexistent', {}],
  ['GET', '/api/jobs/contract-test-nonexistent/result', {}],
  ['GET', '/api/supported-formats', {}],
  ['POST', '/api/translate-captions', jsonBody({})],
];
const mediaGates = [ // videoProcessLimiter routes; empty body
  ['POST', '/api/process-video', {}],
  ['POST', '/api/jobs/process-video', {}],
  ['POST', '/api/generate-captions', {}],
  ['POST', '/api/generate-captions-diarized', {}],
  ['POST', '/api/transition-videos', {}],
  ['POST', '/api/ffmpeg-cli', jsonBody({})],
];
for (const [method, path, o] of [...gates, ...(SKIP_GATES ? [] : mediaGates)]) {
  await check(`${method} ${path} (anonymous)`, () => call(method, path, o), authRequired, { deterministic: true });
}

// ── Report ───────────────────────────────────────────────────────────────────
let drift = [];
if (COMPARE) {
  const before = JSON.parse(readFileSync(COMPARE, 'utf8'));
  for (const [id, prev] of Object.entries(before.checks)) {
    const now = snapshot.checks[id];
    if (!now) { drift.push(`${id}: missing now`); continue; }
    if (prev.status !== now.status) drift.push(`${id}: status ${prev.status} -> ${now.status}`);
    for (const h of new Set([...Object.keys(prev.headers), ...Object.keys(now.headers)])) {
      if (prev.headers[h] !== now.headers[h]) drift.push(`${id}: header ${h} ${JSON.stringify(prev.headers[h])} -> ${JSON.stringify(now.headers[h])}`);
    }
    if (JSON.stringify(prev.shape) !== JSON.stringify(now.shape)) drift.push(`${id}: JSON shape changed`);
    if (prev.bodySha256 && prev.bodySha256 !== now.bodySha256) drift.push(`${id}: body changed`);
  }
}
if (RECORD) writeFileSync(RECORD, JSON.stringify(snapshot, null, 2) + '\n');

const failed = results.filter((r) => !r.ok);
console.log(`iOS endpoint contract @ ${BASE}`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${String(r.status ?? '-').padEnd(3)}  ${r.id}${r.ok ? '' : `  -> ${r.error}`}`);
if (COMPARE) console.log(drift.length ? `DRIFT vs ${COMPARE}:\n  ${drift.join('\n  ')}` : `No drift vs ${COMPARE}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || drift.length ? 1 : 0);
