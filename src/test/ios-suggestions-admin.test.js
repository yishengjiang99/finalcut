// @vitest-environment node
// Admin API for the iOS suggestion pills: auth, validation, atomic write, preview, live reflection.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs, { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import {
  adminFailureLimiter,
  adminLimiter,
  createIosSuggestionsAdminRouter,
  etagOf,
  overrideWriteProblem,
  validateSuggestionsBody,
  writeOverrideAtomically,
  MAX_BODY_BYTES,
} from '../server/iosSuggestionsAdmin.js';
import { createIosSuggestionsRouter, createSuggestionsStore, DEFAULT_SUGGESTIONS_PATH } from '../server/iosSuggestions.js';

const TOKEN = 'test-admin-token-0123456789abcdef-not-real';
const BASE = '/api/admin/ios-suggestions';
const noLimit = (req, res, next) => next();

const entry = (over = {}) => ({ id: 'v-a', label: 'Trim', prompt: 'Trim the video.', icon: 'scissors', tools: ['trim_video'], ...over });
const body = (over = {}) => ({ ttl: 600, video: [entry(), entry({ id: 'v-b', label: 'Slow', tools: ['adjust_speed'] })], photo: [entry({ id: 'p-a', label: 'B&W', tools: ['apply_color_filter'] })], ...over });

let dir;
let overrideFile;
let server;
let base;
let clock;
let store;
const logs = [];
const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

async function start({ token = TOKEN, overridePath = overrideFile, limiter = noLimit, failureLimiter = noLimit, fsImpl } = {}) {
  process.env.IOS_SUGGESTIONS_PATH = overridePath || '';
  store = createSuggestionsStore({ now: () => clock, logger, overridePath: () => process.env.IOS_SUGGESTIONS_PATH });
  const app = express();
  app.use(createIosSuggestionsRouter({ store, limiter: noLimit }));
  app.use(createIosSuggestionsAdminRouter({ store, getToken: () => token, limiter, failureLimiter, logger, ...(fsImpl ? { fsImpl } : {}) }));
  app.use((req, res) => res.status(404).send('fallthrough'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
}
const call = (method, p, { token = TOKEN, json, raw, headers = {} } = {}) => fetch(`${base}${p}`, {
  method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: raw !== undefined ? raw : json !== undefined ? JSON.stringify(json) : undefined,
});
const put = (json, query = '', opts = {}) => call('PUT', `${BASE}${query}`, { json, ...opts });

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ios-sugg-admin-'));
  overrideFile = path.join(dir, 'ios-suggestions.json');
  clock = 1_000_000;
  logs.length = 0;
});
afterEach(async () => {
  delete process.env.IOS_SUGGESTIONS_PATH;
  if (server) await new Promise((r) => server.close(r));
  server = undefined;
  try { chmodSync(dir, 0o755); } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('disabled by default', () => {
  it('404 on every admin route while ADMIN_API_TOKEN is unset, empty or too short (even with a header)', async () => {
    for (const token of [null, '', '   ', 'short-token']) {
      await start({ token });
      for (const [method, p] of [['GET', BASE], ['PUT', BASE], ['PUT', `${BASE}?dryRun=1`], ['GET', `${BASE}/preview?build=12`]]) {
        const res = await call(method, p, { token: token || TOKEN, ...(method === 'PUT' ? { json: body() } : {}) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
      }
      expect(existsSync(overrideFile)).toBe(false);
      await new Promise((r) => server.close(r));
      server = undefined;
    }
  });
});

describe('auth', () => {
  beforeEach(() => start());

  it('401 without a header, with a wrong token, a different-length token, or a non-Bearer scheme', async () => {
    for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: `Bearer ${TOKEN}x` }, { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }, { Authorization: `Basic ${TOKEN}` }, { Authorization: TOKEN }]) {
      const res = await fetch(`${base}${BASE}`, { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    const res = await fetch(`${base}${BASE}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
    expect(res.status).toBe(401);
    expect(existsSync(overrideFile)).toBe(false);
  });

  it('accepts the right token; responses are no-store and never contain the token', async () => {
    const res = await call('GET', BASE);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
  });

  it('never logs the token or the request body', async () => {
    await put(body({ video: [entry({ prompt: 'SECRET-PROMPT-MARKER' })] }), '?dryRun=1');
    await put(body({ video: [entry({ prompt: 'SECRET-PROMPT-MARKER' })] }));
    await call('GET', BASE, { token: 'wrong-token-marker-xxxxxxxxxxxx' });
    const all = logs.join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('SECRET-PROMPT-MARKER');
    expect(all).not.toContain('wrong-token-marker');
  });

  it('the failure limiter cuts off a guessing client; successful and validation-error requests do not count', async () => {
    await new Promise((r) => server.close(r));
    await start({ failureLimiter: (() => { const l = adminFailureLimiter(); return l; })() });
    for (let i = 0; i < 12; i++) await put({ ttl: -1 }); // 400s with the right token: not counted
    expect((await call('GET', BASE)).status).toBe(200);
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await call('GET', BASE, { token: `wrong-${i}-xxxxxxxxxxxxxxxxxxxxxxxx` })).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('the overall limiter caps requests (30 per window by default)', async () => {
    await new Promise((r) => server.close(r));
    await start({ limiter: adminLimiter() });
    let last;
    for (let i = 0; i < 31; i++) last = (await call('GET', BASE)).status;
    expect(last).toBe(429);
  });
});

describe('validation (PUT body)', () => {
  beforeEach(() => start());
  const bad = async (payload, pathPart, messagePart) => {
    const res = await put(payload);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_suggestions');
    expect(json.errors.some(e => e.path === pathPart && e.message.includes(messagePart))).toBe(true);
    expect(existsSync(overrideFile)).toBe(false);
    return json;
  };

  it('rejects unknown keys, bad ttl, missing arrays and the legacy shape', async () => {
    await bad({ ...body(), extra: 1 }, 'extra', 'unknown key');
    await bad(body({ ttl: 1.5 }), 'ttl', 'integer');
    await bad(body({ ttl: 86401 }), 'ttl', 'integer');
    await bad({ ttl: 60, video: [] }, 'photo', 'must be an array');
    await bad({ suggestions: [] }, 'suggestions', 'unknown key');
    await bad([], '$', 'JSON object');
  });

  it('rejects duplicate ids, missing/oversized label and prompt, unknown entry keys, bad icon', async () => {
    await bad(body({ video: [entry(), entry({ label: 'Other' })] }), 'video[1].id', 'duplicate id');
    await bad(body({ video: [entry({ label: '' })] }), 'video[0].label', 'non-empty');
    await bad(body({ video: [entry({ label: 'x'.repeat(25) })] }), 'video[0].label', 'at most 24');
    await bad(body({ video: [entry({ prompt: '  ' })] }), 'video[0].prompt', 'non-empty');
    await bad(body({ video: [entry({ prompt: 'x'.repeat(501) })] }), 'video[0].prompt', 'at most 500');
    await bad(body({ video: [entry({ minbuild: 11 })] }), 'video[0].minbuild', 'unknown key');
    await bad(body({ video: [entry({ icon: 'not an icon!' })] }), 'video[0].icon', 'SF Symbol');
    await bad(body({ video: [entry({ id: 'bad id' })] }), 'video[0].id', 'letters');
    await bad(body({ video: [entry({ label: 'a\u0000b' })] }), 'video[0].label', 'control');
  });

  it('the same id may exist in video and photo (unique per media)', async () => {
    const res = await put(body({ photo: [entry({ id: 'v-a', tools: ['apply_color_filter'] })] }), '?dryRun=1');
    expect(res.status).toBe(200);
  });

  it('tools: non-empty any-of list of known names; unknown, duplicate and non-string names are rejected', async () => {
    await bad(body({ video: [entry({ tools: [] })] }), 'video[0].tools', 'non-empty');
    await bad(body({ video: [entry({ tools: undefined })] }), 'video[0].tools', 'non-empty');
    await bad(body({ video: [entry({ tools: ['trim_video', 'no_such_tool'] })] }), 'video[0].tools', 'unknown tool names');
    await bad(body({ video: [entry({ tools: [1] })] }), 'video[0].tools', 'unknown tool names');
    await bad(body({ video: [entry({ tools: ['trim_video', 'trim_video'] })] }), 'video[0].tools', 'duplicate');
    // iOS-only grouped tool names are known.
    expect((await put(body({ photo: [entry({ id: 'p-x', tools: ['adjust_brightness', 'color_adjust'] })] }), '?dryRun=1')).status).toBe(200);
  });

  it('minBuild / maxBuild: integers >= 0; minBuild must not exceed maxBuild', async () => {
    await bad(body({ video: [entry({ minBuild: -1 })] }), 'video[0].minBuild', 'integer');
    await bad(body({ video: [entry({ minBuild: 11.5 })] }), 'video[0].minBuild', 'integer');
    await bad(body({ video: [entry({ minBuild: '11' })] }), 'video[0].minBuild', 'integer');
    await bad(body({ video: [entry({ maxBuild: 1e15 })] }), 'video[0].maxBuild', 'integer');
    await bad(body({ video: [entry({ minBuild: 20, maxBuild: 10 })] }), 'video[0].minBuild', 'greater than maxBuild');
    const ok = await put(body({ video: [entry({ minBuild: 15, maxBuild: 15 })] }), '?dryRun=1');
    expect(ok.status).toBe(200);
  });

  it('limits: at most 40 entries per media', async () => {
    const many = Array.from({ length: 41 }, (_, i) => entry({ id: `v-${i}` }));
    await bad(body({ video: many }), 'video', 'at most 40');
  });

  it('malformed JSON → 400 invalid_json; oversized body → 413; neither echoes the body', async () => {
    const res = await call('PUT', BASE, { raw: '{"ttl": 1, "video": [SECRET' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
    const big = await call('PUT', BASE, { raw: JSON.stringify({ ttl: 1, video: [], photo: [], pad: 'x'.repeat(MAX_BODY_BYTES + 10) }) });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: 'body_too_large' });
    expect(existsSync(overrideFile)).toBe(false);
  });

  it('warns when no iOS build can ever show a pill', () => {
    const { errors, warnings } = validateSuggestionsBody(body({ video: [entry({ tools: ['add_audio_track'] })] }));
    expect(errors).toEqual([]);
    expect(warnings.join(' ')).toMatch(/none of its tools is on the iOS allowlist/);
  });
});

describe('dryRun', () => {
  beforeEach(() => start());

  it('?dryRun=1 validates without writing and reports whether a real PUT would write', async () => {
    const res = await put(body(), '?dryRun=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true, written: false, wouldWrite: true, summary: { ttl: 600, video: 2, photo: 1 } });
    expect(readdirSync(dir)).toEqual([]);
    const invalid = await put(body({ ttl: -5 }), '?dryRun=1');
    expect(invalid.status).toBe(400);
  });

  it('dryRun says wouldWrite:false (not an error) when the override path is unset', async () => {
    await new Promise((r) => server.close(r));
    await start({ overridePath: '' });
    const res = await put(body(), '?dryRun=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, wouldWrite: false, problem: 'override_path_not_set' });
  });
});

describe('PUT writes the override atomically', () => {
  it('writes canonical JSON, keeps the previous file as .bak, leaves no temp files', async () => {
    await start();
    writeFileSync(overrideFile, '{"ttl":1,"video":[],"photo":[]}\n');
    const res = await put(body());
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ ok: true, written: true, backup: true, servedNow: true, summary: { ttl: 600, video: 2, photo: 1 } });
    expect(JSON.parse(readFileSync(overrideFile, 'utf8'))).toEqual(body());
    expect(readFileSync(overrideFile, 'utf8').endsWith('\n')).toBe(true);
    expect(readFileSync(`${overrideFile}.bak`, 'utf8')).toBe('{"ttl":1,"video":[],"photo":[]}\n');
    expect(readdirSync(dir).sort()).toEqual(['ios-suggestions.json', 'ios-suggestions.json.bak']);
    // A second PUT moves the first version into .bak.
    await put(body({ ttl: 700 }));
    expect(JSON.parse(readFileSync(`${overrideFile}.bak`, 'utf8')).ttl).toBe(600);
    expect(JSON.parse(readFileSync(overrideFile, 'utf8')).ttl).toBe(700);
  });

  it('first write (no previous file): backup false', async () => {
    await start();
    const out = await (await put(body())).json();
    expect(out).toMatchObject({ written: true, backup: false });
    expect(existsSync(`${overrideFile}.bak`)).toBe(false);
  });

  it('refuses with 503 override_path_not_set when IOS_SUGGESTIONS_PATH is unset', async () => {
    await start({ overridePath: '' });
    const res = await put(body());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'override_path_not_set' });
  });

  it('refuses with 503 override_path_not_writable when the directory is missing', async () => {
    await start({ overridePath: path.join(dir, 'missing-dir', 'x.json') });
    const res = await put(body());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'override_path_not_writable' });
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('refuses with 503 when the directory is read-only; the file is untouched', async () => {
    await start();
    writeFileSync(overrideFile, '{"ttl":5,"video":[],"photo":[]}\n');
    chmodSync(dir, 0o555);
    const res = await put(body());
    expect(res.status).toBe(503);
    expect(readFileSync(overrideFile, 'utf8')).toBe('{"ttl":5,"video":[],"photo":[]}\n');
  });

  it('a failure mid-write leaves the old file intact and removes the temp file', async () => {
    writeFileSync(overrideFile, '{"ttl":5,"video":[],"photo":[]}\n');
    const failing = { ...fs, renameSync: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } };
    await start({ fsImpl: failing });
    const res = await put(body());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'write_failed' });
    expect(readFileSync(overrideFile, 'utf8')).toBe('{"ttl":5,"video":[],"photo":[]}\n');
    expect(readdirSync(dir).filter(f => f.includes('.tmp-'))).toEqual([]);
    expect(logs.join('\n')).not.toContain('boom'); // error details stay out of logs and responses
  });

  it('writeOverrideAtomically / overrideWriteProblem unit behavior', () => {
    expect(overrideWriteProblem('')).toMatchObject({ code: 'override_path_not_set' });
    expect(overrideWriteProblem(overrideFile)).toBeNull();
    expect(writeOverrideAtomically(overrideFile, 'a')).toEqual({ backedUp: false });
    expect(writeOverrideAtomically(overrideFile, 'b')).toEqual({ backedUp: true });
    expect(readFileSync(`${overrideFile}.bak`, 'utf8')).toBe('a');
    expect(readFileSync(overrideFile, 'utf8')).toBe('b');
  });

  it('If-Match: 412 when the served config changed since the client read it; matching ETag writes', async () => {
    await start();
    const current = await (await call('GET', BASE)).json();
    const stale = await put(body(), '', { headers: { 'If-Match': '"stale"' } });
    expect(stale.status).toBe(412);
    expect(existsSync(overrideFile)).toBe(false);
    const ok = await put(body(), '', { headers: { 'If-Match': current.etag } });
    expect(ok.status).toBe(200);
  });

  it('concurrent PUTs are serialized: the file is always one complete valid document', async () => {
    await start();
    const results = await Promise.all([1, 2, 3, 4, 5].map(i => put(body({ ttl: 100 * i }))));
    expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
    const final = JSON.parse(readFileSync(overrideFile, 'utf8'));
    expect([100, 200, 300, 400, 500]).toContain(final.ttl);
    expect(readdirSync(dir).filter(f => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('GET (effective config) and the public endpoint', () => {
  it('GET shows the repo default until an override exists, then the override', async () => {
    await start();
    let json = await (await call('GET', BASE)).json();
    expect(json).toMatchObject({ source: 'default', overrideConfigured: true, writable: true });
    expect(json.config.video.map(e => e.id)).toContain('v-captions');
    expect(json.etag).toBe(etagOf(json.config));
    await put(body());
    json = await (await call('GET', BASE)).json();
    expect(json).toMatchObject({ source: 'override', config: body() });
  });

  it('reports overrideConfigured:false / writable:false when IOS_SUGGESTIONS_PATH is unset', async () => {
    await start({ overridePath: '' });
    expect(await (await call('GET', BASE)).json()).toMatchObject({ source: 'default', overrideConfigured: false, writable: false });
  });

  it('the public endpoint reflects a PUT: at once in-process, and within the 5 s reload window for another process', async () => {
    await start();
    const pub = async (build = 12, media = 'video') => (await (await fetch(`${base}/api/ios/suggestions?build=${build}&media=${media}`)).json());
    expect((await pub()).suggestions.map(s => s.id)).toContain('v-captions'); // repo default
    clock += 10_000;
    await put(body());
    const now = await pub();
    expect(now.suggestions.map(s => s.id)).toEqual(['v-a', 'v-b']);
    expect(now.ttl).toBe(600);

    // A second server process: its own store, started before the PUT, only re-reads after the check interval.
    const otherStore = createSuggestionsStore({ now: () => clock, logger, overridePath: () => overrideFile });
    expect(otherStore.get().video.map(e => e.id)).toEqual(['v-a', 'v-b']);
    await put(body({ video: [entry({ id: 'v-new', tools: ['trim_video'] })] }));
    expect(otherStore.get().video.map(e => e.id)).toEqual(['v-a', 'v-b']); // inside the window: cached
    clock += 5_000;
    expect(otherStore.get().video.map(e => e.id)).toEqual(['v-new']); // after ~5 s: picked up
    expect((await pub()).suggestions.map(s => s.id)).toEqual(['v-new']);
  });

  it('the shipped repo default passes the strict validator (so GET → PUT round-trips)', () => {
    const raw = JSON.parse(readFileSync(DEFAULT_SUGGESTIONS_PATH, 'utf8'));
    const { errors } = validateSuggestionsBody(raw);
    expect(errors).toEqual([]);
  });
});

describe('minBuild per pill (public endpoint and preview)', () => {
  const withMin = () => body({
    video: [
      entry({ id: 'v-old', tools: ['trim_video'] }),
      entry({ id: 'v-min15', label: 'New', tools: ['trim_video'], minBuild: 15 }),
      entry({ id: 'v-max11', label: 'Old only', tools: ['trim_video'], maxBuild: 11 }),
      entry({ id: 'v-grouped', label: 'Grouped', tools: ['lut'] }),
    ],
  });

  it('a pill with minBuild is hidden below it and shown from it; maxBuild hides above', async () => {
    await start();
    expect((await put(withMin())).status).toBe(200);
    const pub = async (build) => (await (await fetch(`${base}/api/ios/suggestions?build=${build}&media=video`)).json()).suggestions.map(s => s.id);
    expect(await pub(10)).toEqual(['v-old', 'v-max11']);
    expect(await pub(14)).toEqual(['v-old']);
    expect(await pub(15)).toEqual(['v-old', 'v-min15']);
    expect(await pub(99)).toEqual(['v-old', 'v-min15']);
  });

  it('preview shows exactly the public response, plus why each other pill is hidden', async () => {
    await start();
    await put(withMin());
    const prev = await (await call('GET', `${BASE}/preview?build=14&media=video`)).json();
    const pub = await (await fetch(`${base}/api/ios/suggestions?build=14&media=video`)).json();
    expect(prev).toMatchObject({ build: 14, media: 'video', source: 'override', ttl: 600 });
    expect(prev.response).toEqual(pub);
    expect(prev.hidden).toEqual(expect.arrayContaining([
      { id: 'v-min15', reason: 'build 14 is below minBuild 15' },
      { id: 'v-max11', reason: 'build 14 is above maxBuild 11' },
      { id: 'v-grouped', reason: 'none of its tools is offered to this build for this media' },
    ]));
    expect(prev.toolsOffered).toContain('trim_video');
    const p15 = await (await call('GET', `${BASE}/preview?build=15&media=video`)).json();
    expect(p15.response.suggestions.map(s => s.id)).toContain('v-min15');
  });

  it('preview defaults like the public endpoint: missing/invalid build is 10, media defaults to video; photos use the photo list', async () => {
    await start();
    await put(body());
    const d = await (await call('GET', `${BASE}/preview?build=abc`)).json();
    expect(d).toMatchObject({ build: 10, media: 'video' });
    const photo = await (await call('GET', `${BASE}/preview?build=12&media=photo`)).json();
    expect(photo.response.suggestions.map(s => s.id)).toEqual(['p-a']);
  });
});

describe('strict body validation vs the file loader', () => {
  it('canonicalizes: the written file only has known fields, in a stable shape', async () => {
    await start();
    await put({ video: [{ ...entry(), icon: undefined }], photo: [] });
    expect(JSON.parse(readFileSync(overrideFile, 'utf8'))).toEqual({ ttl: 3600, video: [{ id: 'v-a', label: 'Trim', prompt: 'Trim the video.', tools: ['trim_video'] }], photo: [] });
  });
});
