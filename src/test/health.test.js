// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createHealthRouter, probeFfmpeg, resolveCommit } from '../server/health.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const pkgVersion = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

async function serve(router) {
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(r => server.close(r)) };
}

const healthyFfmpeg = { available: true, version: '4.4.2-0ubuntu0.22.04.1', heic: false, heicVia: null };

describe('GET /api/health', () => {
  let srv;
  afterEach(async () => { if (srv) await srv.close(); srv = null; delete process.env.GIT_COMMIT; });

  it('returns 200 with version, commit, uptime, ffmpeg and db, uncached, without auth', async () => {
    let t = 1_000_000;
    srv = await serve(createHealthRouter({
      ffmpegProbe: healthyFfmpeg,
      dbCheck: async () => 'ok',
      commit: 'abc1234',
      startedAt: t - 42_500,
      now: () => t,
    }));
    const res = await fetch(`${srv.base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({
      ok: true,
      version: pkgVersion,
      commit: 'abc1234',
      uptimeSec: 42,
      ffmpeg: { version: '4.4.2-0ubuntu0.22.04.1', heic: false, heicVia: null },
      db: 'ok',
    });
  });

  it('returns 503 when ffmpeg is missing (critical)', async () => {
    srv = await serve(createHealthRouter({
      ffmpegProbe: { available: false, version: null, heic: false, heicVia: null },
      dbCheck: async () => 'ok',
      commit: null,
    }));
    const res = await fetch(`${srv.base}/api/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, commit: null, ffmpeg: { version: null, heic: false } });
  });

  it('reports db errors without failing the check, and caches the db probe briefly', async () => {
    const dbCheck = vi.fn(async () => 'error');
    srv = await serve(createHealthRouter({ ffmpegProbe: healthyFfmpeg, dbCheck, commit: 'x' }));
    const first = await fetch(`${srv.base}/api/health`);
    expect(first.status).toBe(200);
    expect((await first.json()).db).toBe('error');
    await fetch(`${srv.base}/api/health`);
    expect(dbCheck).toHaveBeenCalledTimes(1);
  });

  it('is not rate limited (many rapid requests all succeed)', async () => {
    srv = await serve(createHealthRouter({ ffmpegProbe: healthyFfmpeg, dbCheck: async () => 'disabled', commit: 'x' }));
    const statuses = await Promise.all(Array.from({ length: 30 }, () => fetch(`${srv.base}/api/health`).then(r => r.status)));
    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  it('GIT_COMMIT env wins over git rev-parse', () => {
    process.env.GIT_COMMIT = 'deadbee';
    expect(resolveCommit()).toBe('deadbee');
  });

  it('probeFfmpeg reports a missing binary as unavailable', async () => {
    expect(await probeFfmpeg({ bin: '/nonexistent/ffmpeg' })).toEqual({ available: false, version: null, heic: false, heicVia: null });
  });

  it.skipIf(!hasFfmpeg)('probeFfmpeg detects the installed ffmpeg version and HEIC capability', async () => {
    const result = await probeFfmpeg();
    expect(result.available).toBe(true);
    expect(result.version).toMatch(/\S/);
    expect(typeof result.heic).toBe('boolean');
  });
});

describe('resolveCommit order', () => {
  const enoent = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  const git = vi.fn(() => 'stale99\n');

  afterEach(() => git.mockClear());

  it('1. GIT_COMMIT env beats REVISION and git', () => {
    expect(resolveCommit({ env: { GIT_COMMIT: ' abc1234 ' }, readFile: () => 'rev5678\n', git })).toBe('abc1234');
    expect(git).not.toHaveBeenCalled();
  });

  it('2. REVISION file beats a (stale) .git and keeps -dirty', () => {
    expect(resolveCommit({ env: {}, readFile: () => '2461df0-dirty\n', git })).toBe('2461df0-dirty');
    expect(git).not.toHaveBeenCalled();
  });

  it('2b. an empty REVISION file yields null without falling back to git', () => {
    expect(resolveCommit({ env: {}, readFile: () => '\n', git })).toBeNull();
    expect(git).not.toHaveBeenCalled();
  });

  it('3. git rev-parse only when no REVISION file exists', () => {
    expect(resolveCommit({ env: {}, readFile: enoent, git })).toBe('stale99');
    expect(git).toHaveBeenCalledTimes(1);
  });

  it('4. null when nothing is available', () => {
    expect(resolveCommit({ env: {}, readFile: enoent, git: () => { throw new Error('no git'); } })).toBeNull();
  });

  it('reads REVISION from the given root on disk', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rev-'));
    writeFileSync(path.join(dir, 'REVISION'), 'feedbee\n');
    expect(resolveCommit({ env: {}, root: dir, git })).toBe('feedbee');
    expect(git).not.toHaveBeenCalled();
  });
});

