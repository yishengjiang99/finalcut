// YouTube audio fetch: extracts a YouTube video's audio track on the server so the
// FinalCap app can use it as a video soundtrack (the app downloads the AAC file and
// mixes it on device — see docs/api/YOUTUBE_SOUNDTRACK.md).
//
// Extraction shells out to yt-dlp (pinned, installed on the server — see the doc) and
// converts with the same FFmpeg binary as the ffmpeg-cli fallback. Extracted files are
// cached per video id under TMP_DIR for YOUTUBE_AUDIO_CACHE_TTL_MS so repeat fetches
// of the same video do not re-download.
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { TMP_DIR } from '../../src/server/config.js';
import { videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess } from '../../src/server/middleware.js';
import { runProcess, FFMPEG_BIN } from '../ffmpeg/ffmpeg-executor.js';

/** yt-dlp binary: YT_DLP_PATH wins when set (mirrors FFMPEG_PATH), else `yt-dlp` on PATH. */
export const YT_DLP_BIN = process.env.YT_DLP_PATH || 'yt-dlp';

/** Pinned yt-dlp release the server runs (docs/api/YOUTUBE_SOUNDTRACK.md has install/update steps). */
export const YT_DLP_PINNED_VERSION = '2026.10.21';

/** Longest YouTube source accepted: 10 minutes of audio is plenty for a soundtrack. */
export const YOUTUBE_AUDIO_MAX_SECONDS = 10 * 60;

/** How long an extracted file is served from the on-disk cache before re-extracting. */
export const YOUTUBE_AUDIO_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.YOUTUBE_AUDIO_CACHE_TTL_MS || 24 * 60 * 60 * 1000)
);

export const YOUTUBE_AUDIO_CACHE_DIR = path.join(TMP_DIR, 'youtube-audio-cache');

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export class YouTubeAudioError extends Error {
  constructor(code, status, message, extra = undefined) {
    super(message);
    this.name = 'YouTubeAudioError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const unavailable = () => new YouTubeAudioError(
  'youtube_audio_unavailable', 503, 'YouTube audio is not available on the server right now'
);
const fetchFailed = (message = 'Could not fetch that YouTube audio') =>
  new YouTubeAudioError('youtube_fetch_failed', 502, message);

/**
 * Extract the 11-char video id from a pasted YouTube link (watch / youtu.be / shorts /
 * live / embed / music.youtube.com) or a bare id. Returns null for anything else —
 * including other hosts and playlist-only links.
 */
export function parseYouTubeVideoId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (VIDEO_ID_RE.test(s)) return s;
  let u;
  try { u = new URL(s); } catch {
    try { u = new URL(`https://${s}`); } catch { return null; }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const asId = (v) => (typeof v === 'string' && VIDEO_ID_RE.test(v) ? v : null);
  if (host === 'youtu.be') return asId(u.pathname.slice(1).split('/')[0]);
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return asId(u.searchParams.get('v'));
    const m = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
    if (m) return m[1];
  }
  return null;
}

/** Validate the JSON body of POST /api/youtube-audio/fetch. Throws YouTubeAudioError. */
export function parseFetchRequest(body) {
  const url = body?.url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new YouTubeAudioError('invalid_youtube_url', 400, 'A YouTube link is required');
  }
  const videoId = parseYouTubeVideoId(url);
  if (!videoId) {
    throw new YouTubeAudioError('invalid_youtube_url', 400, 'That does not look like a YouTube video link');
  }
  return { url: url.trim(), videoId };
}

/** `Duration: 00:03:25.12` in ffmpeg's stderr → seconds (first match). */
export function parseFfmpegDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(stderr || ''));
  if (!m) return null;
  const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function classifyYtDlpFailure(res) {
  if (res.spawnError) return unavailable();
  if (res.timedOut) return fetchFailed('Reading that YouTube video timed out');
  const text = `${res.stderr || ''}\n${res.stdout || ''}`;
  if (/video unavailable|private video|has been removed|no longer available|account associated with this video has been terminated/i.test(text)) {
    return new YouTubeAudioError('youtube_video_unavailable', 404, 'That YouTube video is unavailable');
  }
  return fetchFailed();
}

const cacheFileName = (videoId, ext) => `${videoId}.${ext}`;
const CACHE_ENTRY_RE = /^[A-Za-z0-9_-]{11}\.(m4a|json)$/;

/** Best-effort sweep of expired cache entries; never throws. */
async function sweepCache(cacheDir, ttlMs, now) {
  try {
    const entries = await fs.readdir(cacheDir);
    await Promise.all(entries.map(async (name) => {
      if (!CACHE_ENTRY_RE.test(name)) return;
      try {
        const st = await fs.stat(path.join(cacheDir, name));
        if (now() - st.mtimeMs > ttlMs) await fs.unlink(path.join(cacheDir, name));
      } catch { /* entry vanished mid-sweep */ }
    }));
  } catch { /* no cache dir yet */ }
}

async function readCache(cacheDir, videoId, ttlMs, now) {
  const filePath = path.join(cacheDir, cacheFileName(videoId, 'm4a'));
  const metaPath = path.join(cacheDir, cacheFileName(videoId, 'json'));
  try {
    const [fileStat, metaRaw] = await Promise.all([fs.stat(filePath), fs.readFile(metaPath, 'utf8')]);
    if (now() - fileStat.mtimeMs > ttlMs) return null;
    const meta = JSON.parse(metaRaw);
    if (meta.videoId !== videoId || !(meta.durationSeconds > 0)) return null;
    return {
      filePath,
      videoId,
      title: typeof meta.title === 'string' ? meta.title : '',
      durationSeconds: meta.durationSeconds,
      cached: true,
    };
  } catch {
    return null;
  }
}

/**
 * Extract a YouTube video's audio to an AAC (.m4a) file in the cache.
 * Resolves { filePath, videoId, title, durationSeconds, cached }.
 * Throws YouTubeAudioError with a stable `code` for every expected failure.
 * `deps` mirrors the ffmpeg tooling style: { run, bin, ffmpegBin, cacheDir, ttlMs, now }.
 */
export async function fetchYouTubeAudio({ url } = {}, deps = {}) {
  const run = deps.run ?? runProcess;
  const bin = deps.bin ?? YT_DLP_BIN;
  const ffmpegBin = deps.ffmpegBin ?? FFMPEG_BIN;
  const cacheDir = deps.cacheDir ?? YOUTUBE_AUDIO_CACHE_DIR;
  const ttlMs = deps.ttlMs ?? YOUTUBE_AUDIO_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;

  const { videoId } = parseFetchRequest({ url });
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  await sweepCache(cacheDir, ttlMs, now);
  const hit = await readCache(cacheDir, videoId, ttlMs, now);
  if (hit) return hit;

  // yt-dlp must exist before doing any real work: a missing binary is a server
  // configuration problem (503), not a bad link.
  const probe = await run(bin, ['--version'], { timeoutMs: 10_000 });
  if (probe.spawnError || probe.code !== 0) throw unavailable();

  const metaRes = await run(bin, [
    '--no-playlist', '--skip-download', '--dump-single-json', '--no-warnings', canonicalUrl,
  ], { timeoutMs: 60_000 });
  if (metaRes.code !== 0) throw classifyYtDlpFailure(metaRes);
  let meta;
  try { meta = JSON.parse(metaRes.stdout); } catch { throw fetchFailed(); }
  if (meta?.is_live) {
    throw new YouTubeAudioError('youtube_live_not_supported', 422, 'Live streams cannot be used as a soundtrack');
  }
  const metaDuration = Number(meta?.duration);
  let durationSeconds = Number.isFinite(metaDuration) && metaDuration > 0 ? metaDuration : null;
  if (durationSeconds !== null && durationSeconds > YOUTUBE_AUDIO_MAX_SECONDS) {
    throw new YouTubeAudioError('youtube_audio_too_long', 422,
      `That video is longer than ${YOUTUBE_AUDIO_MAX_SECONDS / 60} minutes`,
      { durationSeconds, maxDurationSeconds: YOUTUBE_AUDIO_MAX_SECONDS });
  }
  const title = typeof meta?.title === 'string' ? meta.title.trim().slice(0, 300) : '';

  const workDir = path.join(TMP_DIR, `yta-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });
  try {
    const dl = await run(bin, [
      '--no-playlist', '--no-warnings', '-f', 'bestaudio/best',
      '-o', path.join(workDir, 'source.%(ext)s'), canonicalUrl,
    ], { timeoutMs: 180_000 });
    if (dl.code !== 0) throw classifyYtDlpFailure(dl);
    const sourceName = (await fs.readdir(workDir)).find((n) => n.startsWith('source.'));
    if (!sourceName) throw fetchFailed();
    const sourcePath = path.join(workDir, sourceName);

    const outPath = path.join(workDir, 'audio.m4a');
    const conv = await run(ffmpegBin, [
      '-hide_banner', '-y', '-nostdin', '-i', sourcePath,
      '-vn', '-c:a', 'aac', '-b:a', '192k', outPath,
    ], { timeoutMs: 120_000 });
    if (conv.spawnError) throw unavailable();
    if (conv.timedOut) throw fetchFailed('Converting that audio timed out');
    if (conv.code !== 0) throw fetchFailed('Converting that audio failed');

    if (durationSeconds === null) {
      durationSeconds = parseFfmpegDuration(conv.stderr);
      if (durationSeconds === null) {
        const probeOut = await run(ffmpegBin, ['-hide_banner', '-i', outPath], { timeoutMs: 30_000 });
        durationSeconds = parseFfmpegDuration(probeOut.stderr);
      }
      if (durationSeconds === null) throw fetchFailed('Could not read that audio');
      if (durationSeconds > YOUTUBE_AUDIO_MAX_SECONDS) {
        throw new YouTubeAudioError('youtube_audio_too_long', 422,
          `That video is longer than ${YOUTUBE_AUDIO_MAX_SECONDS / 60} minutes`,
          { durationSeconds, maxDurationSeconds: YOUTUBE_AUDIO_MAX_SECONDS });
      }
    }

    await fs.mkdir(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, cacheFileName(videoId, 'm4a'));
    await fs.copyFile(outPath, filePath);
    await fs.writeFile(
      path.join(cacheDir, cacheFileName(videoId, 'json')),
      JSON.stringify({ videoId, title, durationSeconds, fetchedAt: now() })
    );
    return { filePath, videoId, title, durationSeconds, cached: false };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Error body for a failed fetch: the codebase shape { error, code, ...extra }. */
export function youtubeAudioErrorBody(err) {
  if (err instanceof YouTubeAudioError) {
    return { status: err.status, body: { error: err.message, code: err.code, ...(err.extra || {}) } };
  }
  return { status: 500, body: { error: 'YouTube audio fetch failed', code: 'youtube_fetch_failed' } };
}

export const youtubeAudioRouter = express.Router();

// JSON in, AAC audio out. Same access chain as the ffmpeg-cli endpoints: rate limit,
// authenticated user, then inference access (a fetch counts as one inference for
// free-tier installs, like any other server edit step).
youtubeAudioRouter.post('/api/youtube-audio/fetch', express.json({ limit: '10kb' }), videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess, async (req, res) => {
  try {
    const { url } = parseFetchRequest(req.body || {});
    const result = await fetchYouTubeAudio({ url });
    const buf = await fs.readFile(result.filePath);
    res.set('Content-Type', 'audio/mp4');
    res.set('X-Audio-Duration', String(result.durationSeconds));
    res.set('X-Video-Id', result.videoId);
    res.set('X-Audio-Title', encodeURIComponent(result.title || ''));
    res.set('X-Audio-Cached', result.cached ? 'true' : 'false');
    return res.send(buf);
  } catch (e) {
    const { status, body } = youtubeAudioErrorBody(e);
    if (status >= 500 && !(e instanceof YouTubeAudioError)) console.error('youtube-audio fetch error:', e);
    return res.status(status).json(body);
  }
});
