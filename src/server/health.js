// GET /api/health — unauthenticated, not rate limited, not cached.
// ffmpeg capabilities and the git commit are probed once at startup; the DB check is
// a cheap SELECT 1 with a short timeout (result cached for a few seconds).
import express from 'express';
import { execFile, execFileSync } from 'child_process';
import { readFileSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const DB_TIMEOUT_MS = 1000;
const DB_CACHE_MS = 5000;

// 128x96 HEIC produced by libheif — decoded at startup to test real HEIC support.
const HEIC_SAMPLE_BASE64 = 'AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAVZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABegABAAAAAAAAACcAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA1mlwcnAAAAC3aXBjbwAAAHhodmNDAQNwAAAAAAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQArQgEBA3AAAAMAkAAAAwAAAwAeoBAgYWW6kkprm4CGgwIAAAMAMgAAAwACEGIAAQAHRAHBcrAiQAAAABNjb2xybmNseAABAA0ABoAAAAAUaXNwZQAAAAAAAACAAAAAYAAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgQIDBAAAAC9tZGF0AAAAIygBrwT4QTJpy/5h////R1d2X7mTST0cYM7GDOTinQk6VOcc';

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

export function resolveCommit() {
  if (process.env.GIT_COMMIT) return String(process.env.GIT_COMMIT).trim().slice(0, 40) || null;
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch {
    return null;
  }
}

function run(bin, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * Probe ffmpeg once: version string and whether HEIC photos can be processed
 * (natively by ffmpeg's HEIF demuxer, or via libheif's heif-convert fallback).
 */
export async function probeFfmpeg({ bin = FFMPEG_BIN } = {}) {
  const versionResult = await run(bin, ['-hide_banner', '-version'], 5000);
  if (versionResult.error) {
    return { available: false, version: null, heic: false, heicVia: null };
  }
  const match = /ffmpeg version (\S+)/.exec(versionResult.stdout);
  const version = match ? match[1] : 'unknown';

  let heicVia = null;
  const samplePath = path.join(os.tmpdir(), `health-heic-${process.pid}-${Date.now()}.heic`);
  try {
    await fs.writeFile(samplePath, Buffer.from(HEIC_SAMPLE_BASE64, 'base64'));
    const decode = await run(bin, ['-v', 'error', '-i', samplePath, '-frames:v', '1', '-f', 'null', '-'], 10_000);
    if (!decode.error) heicVia = 'ffmpeg';
  } finally {
    fs.unlink(samplePath).catch(() => {});
  }
  if (!heicVia) {
    const heifConvert = await run('heif-convert', ['--version'], 3000);
    if (!(heifConvert.error && heifConvert.error.code === 'ENOENT')) heicVia = 'heif-convert';
  }
  return { available: true, version, heic: Boolean(heicVia), heicVia };
}

/** Cheap DB liveness check: "ok" | "error" | "disabled". */
export async function checkDatabase({ timeoutMs = DB_TIMEOUT_MS } = {}) {
  if (process.env.MYSQL_DISABLED === 'true') return 'disabled';
  let timer;
  try {
    const { getPool } = await import('../db.js');
    const query = getPool().query('SELECT 1');
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('db health timeout')), timeoutMs);
    });
    await Promise.race([query, timeout]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the health router. Dependencies are injectable for tests.
 * ffmpeg is critical (503 when missing); DB problems are reported but stay 200.
 */
export function createHealthRouter({
  ffmpegProbe = probeFfmpeg(),
  dbCheck = checkDatabase,
  commit = resolveCommit(),
  version = readPackageVersion(),
  startedAt = Date.now(),
  now = () => Date.now(),
} = {}) {
  const router = express.Router();
  const ffmpegPromise = Promise.resolve(ffmpegProbe).catch(() => ({ available: false, version: null, heic: false, heicVia: null }));
  let dbCache = null;

  async function dbStatus() {
    if (dbCache && now() - dbCache.at < DB_CACHE_MS) return dbCache.status;
    const status = await dbCheck();
    dbCache = { status, at: now() };
    return status;
  }

  router.get('/api/health', async (req, res) => {
    const [ff, db] = await Promise.all([ffmpegPromise, dbStatus()]);
    const ok = Boolean(ff.available);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.status(ok ? 200 : 503).json({
      ok,
      version,
      commit,
      uptimeSec: Math.floor((now() - startedAt) / 1000),
      ffmpeg: { version: ff.version, heic: Boolean(ff.heic), heicVia: ff.heicVia ?? null },
      db,
    });
  });

  return router;
}
