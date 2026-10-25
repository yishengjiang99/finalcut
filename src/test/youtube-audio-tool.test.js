import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  parseYouTubeVideoId,
  parseFetchRequest,
  parseFfmpegDuration,
  fetchYouTubeAudio,
  youtubeAudioErrorBody,
  YouTubeAudioError,
  YOUTUBE_AUDIO_MAX_SECONDS,
} from '../../server/tools/youtube-audio-tool.js';

const ID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

describe('parseYouTubeVideoId', () => {
  it('accepts the link shapes users paste', () => {
    expect(parseYouTubeVideoId(WATCH)).toBe(ID);
    expect(parseYouTubeVideoId(`${WATCH}&t=42s`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://youtu.be/${ID}?si=xyz`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://youtube.com/shorts/${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://www.youtube.com/live/${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(`https://music.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(`youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeVideoId(ID)).toBe(ID);
  });

  it('rejects non-YouTube and id-less links', () => {
    expect(parseYouTubeVideoId('https://vimeo.com/12345678901')).toBeNull();
    expect(parseYouTubeVideoId('https://www.youtube.com/playlist?list=PL123')).toBeNull();
    expect(parseYouTubeVideoId('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(parseYouTubeVideoId('https://evil-youtube.com/watch?v=' + ID)).toBeNull();
    expect(parseYouTubeVideoId('not a link')).toBeNull();
    expect(parseYouTubeVideoId('')).toBeNull();
    expect(parseYouTubeVideoId(undefined)).toBeNull();
    expect(parseYouTubeVideoId(42)).toBeNull();
  });
});

describe('parseFetchRequest', () => {
  it('requires a YouTube link', () => {
    for (const body of [undefined, {}, { url: '' }, { url: '   ' }, { url: 7 }, { url: 'https://example.com/x' }]) {
      try {
        parseFetchRequest(body);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(YouTubeAudioError);
        expect(e.code).toBe('invalid_youtube_url');
        expect(e.status).toBe(400);
      }
    }
  });

  it('returns the trimmed url and parsed id', () => {
    expect(parseFetchRequest({ url: ` ${WATCH} ` })).toEqual({ url: WATCH, videoId: ID });
  });
});

describe('parseFfmpegDuration', () => {
  it('parses the ffmpeg banner duration', () => {
    expect(parseFfmpegDuration('  Duration: 00:03:12.50, start: 0.000000, bitrate: 192 kb/s')).toBeCloseTo(192.5);
    expect(parseFfmpegDuration('Duration: 01:00:00.00')).toBe(3600);
    expect(parseFfmpegDuration('no duration here')).toBeNull();
    expect(parseFfmpegDuration('')).toBeNull();
  });
});

/**
 * Fake process runner for yt-dlp + ffmpeg. Records calls; behavior steered by `opts`:
 * meta (object or function), metaError (stderr text), missingYtDlp, durationInBanner.
 * Writes the files the real tools would produce (download target, converted m4a).
 */
function makeRun(opts = {}) {
  const calls = [];
  const run = async (bin, args) => {
    calls.push({ bin, args });
    const ok = (stdout = '', stderr = '') => ({ stdout, stderr, code: 0, timedOut: false, spawnError: null });
    const fail = (stderr = '', code = 1) => ({ stdout: '', stderr, code, timedOut: false, spawnError: null });
    if (bin === 'yt-dlp-test') {
      if (args.includes('--version')) {
        if (opts.missingYtDlp) return { stdout: '', stderr: '', code: 1, timedOut: false, spawnError: 'ENOENT' };
        return ok('2026.10.21\n');
      }
      if (args.includes('--dump-single-json')) {
        if (opts.metaError) return fail(opts.metaError);
        const meta = typeof opts.meta === 'function' ? opts.meta() : (opts.meta ?? { id: ID, title: 'A Song', duration: 192 });
        return ok(JSON.stringify(meta));
      }
      if (args.includes('-o')) {
        const template = args[args.indexOf('-o') + 1];
        await fs.writeFile(template.replace('%(ext)s', 'webm'), Buffer.from('fake-source-audio'));
        return ok('', '[download] 100%');
      }
    }
    if (bin === 'ffmpeg-test') {
      const out = args[args.length - 1];
      const isConvert = args.includes('-c:a');
      if (isConvert) {
        await fs.writeFile(out, Buffer.from('fake-aac-audio'));
        const banner = opts.durationInBanner === undefined ? 'Duration: 00:03:12.50' : opts.durationInBanner;
        return ok('', `Input #0, mov,mp4,m4a, from 'source.webm':\n  ${banner}, start: 0.000000, bitrate: 160 kb/s`);
      }
      // Probe (`ffmpeg -i file`): exits 1, duration on stderr.
      return fail('Input #0, mov,mp4,m4a:\n  Duration: 00:03:12.50, start: 0.000000');
    }
    throw new Error(`unexpected run: ${bin} ${args.join(' ')}`);
  };
  return { run, calls };
}

describe('fetchYouTubeAudio', () => {
  let cacheDir;
  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yta-test-'));
  });
  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  const deps = (run, extra = {}) => ({ run, bin: 'yt-dlp-test', ffmpegBin: 'ffmpeg-test', cacheDir, ...extra });

  it('extracts, converts, caches, then serves repeats from cache', async () => {
    const { run, calls } = makeRun();
    const first = await fetchYouTubeAudio({ url: WATCH }, deps(run));
    expect(first.videoId).toBe(ID);
    expect(first.title).toBe('A Song');
    expect(first.durationSeconds).toBe(192);
    expect(first.cached).toBe(false);
    expect((await fs.readFile(first.filePath)).toString()).toBe('fake-aac-audio');
    // yt-dlp: version probe, metadata, download. ffmpeg: one conversion.
    expect(calls.filter(c => c.bin === 'yt-dlp-test').length).toBe(3);
    expect(calls.filter(c => c.bin === 'ffmpeg-test').length).toBe(1);

    const second = await fetchYouTubeAudio({ url: `https://youtu.be/${ID}` }, deps(run));
    expect(second.cached).toBe(true);
    expect(second.durationSeconds).toBe(192);
    expect(calls.length).toBe(4); // no further process runs at all
  });

  it('rejects an invalid link before running anything', async () => {
    const { run, calls } = makeRun();
    await expect(fetchYouTubeAudio({ url: 'https://example.com/watch?v=' + ID }, deps(run)))
      .rejects.toMatchObject({ code: 'invalid_youtube_url', status: 400 });
    expect(calls).toEqual([]);
  });

  it('maps a missing yt-dlp binary to 503 youtube_audio_unavailable', async () => {
    const { run, calls } = makeRun({ missingYtDlp: true });
    await expect(fetchYouTubeAudio({ url: WATCH }, deps(run)))
      .rejects.toMatchObject({ code: 'youtube_audio_unavailable', status: 503 });
    expect(calls.length).toBe(1); // probe only — metadata/download never attempted
  });

  it('maps an unavailable video to 404 youtube_video_unavailable', async () => {
    const { run } = makeRun({ metaError: `ERROR: [youtube] ${ID}: Video unavailable` });
    await expect(fetchYouTubeAudio({ url: WATCH }, deps(run)))
      .rejects.toMatchObject({ code: 'youtube_video_unavailable', status: 404 });
  });

  it('maps other yt-dlp failures to 502 youtube_fetch_failed', async () => {
    const { run } = makeRun({ metaError: 'ERROR: Unable to download webpage: HTTP Error 503' });
    await expect(fetchYouTubeAudio({ url: WATCH }, deps(run)))
      .rejects.toMatchObject({ code: 'youtube_fetch_failed', status: 502 });
  });

  it('enforces the 10-minute cap from metadata, before downloading', async () => {
    const { run, calls } = makeRun({ meta: { id: ID, title: 'Long mix', duration: YOUTUBE_AUDIO_MAX_SECONDS + 1 } });
    const err = await fetchYouTubeAudio({ url: WATCH }, deps(run)).catch(e => e);
    expect(err).toMatchObject({ code: 'youtube_audio_too_long', status: 422 });
    expect(err.extra).toEqual({ durationSeconds: YOUTUBE_AUDIO_MAX_SECONDS + 1, maxDurationSeconds: YOUTUBE_AUDIO_MAX_SECONDS });
    expect(calls.some(c => c.args.includes('-o'))).toBe(false);
  });

  it('rejects live streams', async () => {
    const { run } = makeRun({ meta: { id: ID, title: 'Live', duration: null, is_live: true } });
    await expect(fetchYouTubeAudio({ url: WATCH }, deps(run)))
      .rejects.toMatchObject({ code: 'youtube_live_not_supported', status: 422 });
  });

  it('falls back to the ffmpeg banner duration when metadata has none', async () => {
    const { run } = makeRun({ meta: { id: ID, title: 'No duration', duration: null } });
    const result = await fetchYouTubeAudio({ url: WATCH }, deps(run));
    expect(result.durationSeconds).toBeCloseTo(192.5);
  });

  it('re-extracts once the cache entry is older than the TTL', async () => {
    const { run, calls } = makeRun();
    const t0 = Date.now();
    await fetchYouTubeAudio({ url: WATCH }, deps(run, { ttlMs: 1000, now: () => t0 }));
    const later = await fetchYouTubeAudio({ url: WATCH }, deps(run, { ttlMs: 1000, now: () => t0 + 60_000 }));
    expect(later.cached).toBe(false);
    expect(calls.filter(c => c.args.includes('-o')).length).toBe(2);
  });
});

describe('youtubeAudioErrorBody', () => {
  it('maps typed errors to { error, code } with their status', () => {
    const { status, body } = youtubeAudioErrorBody(
      new YouTubeAudioError('youtube_audio_too_long', 422, 'Too long', { durationSeconds: 601, maxDurationSeconds: 600 })
    );
    expect(status).toBe(422);
    expect(body).toEqual({ error: 'Too long', code: 'youtube_audio_too_long', durationSeconds: 601, maxDurationSeconds: 600 });
  });

  it('maps unexpected errors to a 500 youtube_fetch_failed', () => {
    const { status, body } = youtubeAudioErrorBody(new Error('boom'));
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'YouTube audio fetch failed', code: 'youtube_fetch_failed' });
  });
});
