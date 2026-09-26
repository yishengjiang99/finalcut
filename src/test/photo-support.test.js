// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import ffmpeg from 'fluent-ffmpeg';
import {
  sniffMediaFormat,
  detectMediaType,
  imageFormatFromHints,
  isImageProbe,
  isAcceptedUpload,
} from '../server/mediaType.js';
import {
  OpValidationError,
  PHOTO_SUPPORTED_OPS,
  applyOperation,
  applyTrim,
  assertOperationSupported,
  buildColorFilter,
  buildImageCommand,
  buildVisualFilter,
  escapeDrawtext,
  parseTimeToSeconds,
  prepareImageInput,
  processImageToFile,
  resolveImageOutputMeta,
} from '../server/ffmpegOps.js';
import os from 'os';
import { existsSync, unlinkSync } from 'fs';
import { publicJob, classifyAndValidateUpload, jobsRouter } from '../server/jobs.js';
import { videoRouter } from '../server/video.js';
import { issueSampleAccessToken } from '../server/middleware.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);
const JPG = fixture('photo-64x48.jpg');
const PNG = fixture('photo-64x48.png');
const HEIC = fixture('photo-128x96.heic');
const MP4 = fixture('silent-2s.mp4');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function args(command) {
  return command._getArguments();
}

function recorder() {
  const calls = [];
  const cmd = {
    calls,
    setStartTime(v) { calls.push(['ss', v]); return cmd; },
    setDuration(v) { calls.push(['t', v]); return cmd; },
    outputOptions(v) { calls.push(['opts', v]); return cmd; },
    videoFilters(v) { calls.push(['vf', v]); return cmd; },
    audioCodec(v) { calls.push(['ac', v]); return cmd; },
  };
  return cmd;
}

describe('photo detection', () => {
  it('sniffs jpg/png/heic magic bytes and recognises mp4 as video', () => {
    expect(sniffMediaFormat(readFileSync(JPG))).toBe('jpeg');
    expect(sniffMediaFormat(readFileSync(PNG))).toBe('png');
    expect(sniffMediaFormat(readFileSync(HEIC))).toBe('heic');
    expect(sniffMediaFormat(readFileSync(MP4))).toBe('video');
    expect(sniffMediaFormat(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffMediaFormat(Buffer.alloc(0))).toBeNull();
  });

  it('detects a photo even when the client labels it video/mp4 (iOS bug report)', async () => {
    const result = await detectMediaType({
      buffer: readFileSync(JPG),
      mimetype: 'video/mp4',
      filename: 'video.mp4',
    });
    expect(result).toMatchObject({ mediaType: 'image', imageFormat: 'jpeg', source: 'magic' });
  });

  it('keeps videos as video', async () => {
    const result = await detectMediaType({ buffer: readFileSync(MP4), mimetype: 'video/mp4', filename: 'clip.mp4' });
    expect(result.mediaType).toBe('video');
  });

  it('falls back to mimetype / extension hints', async () => {
    expect(imageFormatFromHints({ filename: 'IMG_0001.HEIC' })).toBe('heic');
    expect(imageFormatFromHints({ mimetype: 'image/png' })).toBe('png');
    expect(imageFormatFromHints({ mimetype: 'image/webp; charset=binary' })).toBe('webp');
    expect(imageFormatFromHints({ filename: 'movie.mov', mimetype: 'image/jpeg' })).toBe('video');
    const r = await detectMediaType({ buffer: Buffer.from('????????'), filename: 'x.heif' });
    expect(r).toMatchObject({ mediaType: 'image', imageFormat: 'heic' });
  });

  it('uses ffprobe (single frame, no duration) when bytes and hints are inconclusive', async () => {
    const photoProbe = async () => ({
      streams: [{ codec_type: 'video', codec_name: 'png', nb_frames: '1' }],
      format: { format_name: 'png_pipe' },
    });
    const r = await detectMediaType({ buffer: Buffer.from('????'), inputPath: '/tmp/x', probe: photoProbe });
    expect(r).toMatchObject({ mediaType: 'image', imageFormat: 'png', source: 'ffprobe' });

    const videoProbe = async () => ({
      streams: [{ codec_type: 'video', codec_name: 'h264', duration: '2.0', nb_frames: '60' }, { codec_type: 'audio' }],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2.0' },
    });
    const v = await detectMediaType({ buffer: Buffer.from('????'), inputPath: '/tmp/x', probe: videoProbe });
    expect(v.mediaType).toBe('video');
  });

  it('isImageProbe: HEIC-style single hevc frame without duration is an image; audio-only is not', () => {
    expect(isImageProbe({ streams: [{ codec_type: 'video', codec_name: 'hevc', nb_frames: '1' }], format: { format_name: 'mov,mp4' } })).toBe(true);
    expect(isImageProbe({ streams: [{ codec_type: 'audio' }], format: {} })).toBe(false);
    expect(isImageProbe({ streams: [{ codec_type: 'video', codec_name: 'mjpeg', duration: '12.5' }], format: {} })).toBe(false);
  });

  it.skipIf(!hasFfmpeg)('ffprobe detects the generated jpg fixture as an image', async () => {
    const r = await detectMediaType({ buffer: Buffer.from('????'), inputPath: JPG });
    expect(r).toMatchObject({ mediaType: 'image', source: 'ffprobe' });
  });

  it('multer filter accepts photos, videos, audio and octet-stream', () => {
    expect(isAcceptedUpload({ mimetype: 'image/heic', filename: 'IMG.HEIC' })).toBe(true);
    expect(isAcceptedUpload({ mimetype: 'image/jpeg' })).toBe(true);
    expect(isAcceptedUpload({ mimetype: 'video/mp4' })).toBe(true);
    expect(isAcceptedUpload({ mimetype: 'application/octet-stream', filename: 'x' })).toBe(true);
    expect(isAcceptedUpload({ mimetype: 'application/pdf', filename: 'x.pdf' })).toBe(false);
  });
});

describe('photo ffmpeg command', () => {
  it('builds a single-frame image command with no -ss/-t', () => {
    const { command, meta } = buildImageCommand({
      inputPath: JPG,
      outputPath: '/tmp/out.jpg',
      imageFormat: 'jpeg',
      operation: 'apply_color_filter',
      args: { filter: 'red' },
    });
    const argv = args(command);
    expect(argv).not.toContain('-ss');
    expect(argv).not.toContain('-t');
    expect(argv.join(' ')).toContain('-frames:v 1');
    expect(argv.join(' ')).toMatch(/colorchannelmixer=rr=1:.*gg=0\.4.*bb=0\.4/);
    expect(argv).toContain('image2');
    expect(meta).toMatchObject({ outputExt: 'jpg', contentType: 'image/jpeg', mediaType: 'image' });
  });

  it('keeps png as png, converts heic to jpeg, honours convert_image_format', () => {
    expect(resolveImageOutputMeta('png', 'adjust_brightness', {}).contentType).toBe('image/png');
    expect(resolveImageOutputMeta('heic', 'adjust_brightness', {})).toMatchObject({ outputExt: 'jpg', contentType: 'image/jpeg' });
    expect(resolveImageOutputMeta('jpeg', 'convert_image_format', { format: 'png' }).contentType).toBe('image/png');
    expect(resolveImageOutputMeta('webp', 'adjust_hue', {}, { canEncodeWebp: false }).contentType).toBe('image/png');
    expect(() => resolveImageOutputMeta('jpeg', 'convert_image_format', { format: 'gif' })).toThrow(OpValidationError);
  });

  it('validates numbers for photo filters', () => {
    expect(buildVisualFilter('adjust_brightness', { brightness: 0.2 })).toBe('eq=brightness=0.2');
    expect(buildVisualFilter('rotate_video', { angle: 90 })).toBe('transpose=clock');
    expect(buildVisualFilter('crop_video', { width: 10, height: 10 })).toBe('crop=10:10:0:0');
    expect(() => buildVisualFilter('adjust_brightness', {})).toThrow(/brightness must be a number/);
    expect(() => buildVisualFilter('resize_video', { width: 'abc', height: 10 })).toThrow(OpValidationError);
    expect(() => buildVisualFilter('add_text', { text: 'hi', color: "white:x=1'" })).toThrow(OpValidationError);
    expect(buildColorFilter({ filter: 'Black and White' })).toMatch(/^colorchannelmixer=rr=0\.299/);
    expect(buildColorFilter({ filter: 'invert' })).toBe('negate');
    expect(() => buildColorFilter({ filter: 'purple-ish' })).toThrow(/filter must be one of/);
  });

  it('escapes drawtext without quotes so apostrophes and colons are safe', () => {
    expect(escapeDrawtext("it's: 100%")).toBe("it\\\\\\'s\\\\: 100%");
  });

  it('rejects unsupported photo ops with a clear 400', () => {
    for (const op of ['trim_video', 'speed_video', 'adjust_volume', 'audio_fade', 'extract_audio', 'generate_captions', 'fade_transition', 'burn_subtitles', 'add_video_transition']) {
      let err;
      try { assertOperationSupported(op, 'image'); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(OpValidationError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toContain('not supported for photos');
    }
    for (const op of PHOTO_SUPPORTED_OPS) {
      expect(() => assertOperationSupported(op, 'image')).not.toThrow();
    }
    expect(() => assertOperationSupported('trim_video', 'video')).not.toThrow();
  });

  it('HEIC falls back to heif-convert, then a clear 415 when nothing can decode it', async () => {
    const noProbe = async () => null;
    await expect(prepareImageInput('/tmp/x.heic', 'heic', { probe: noProbe, convert: async () => false }))
      .rejects.toMatchObject({ statusCode: 415, message: expect.stringContaining('HEIC') });
    const converted = await prepareImageInput('/tmp/x.heic', 'heic', { probe: noProbe, convert: async () => true });
    expect(converted).toMatchObject({ imageFormat: 'jpeg', path: '/tmp/x.heic.heic-converted.jpg' });
    const direct = await prepareImageInput('/tmp/x.heic', 'heic', {
      probe: async () => ({ streams: [{ codec_type: 'video', width: 128, height: 96 }] }),
    });
    expect(direct).toMatchObject({ imageFormat: 'heic', path: '/tmp/x.heic', cleanup: null });
  });
});

describe('video -ss guard', () => {
  it('parses times and rejects garbage', () => {
    expect(parseTimeToSeconds(undefined)).toBeNull();
    expect(parseTimeToSeconds('')).toBeNull();
    expect(parseTimeToSeconds('undefined')).toBeNull();
    expect(parseTimeToSeconds(3)).toBe(3);
    expect(parseTimeToSeconds('00:01:05.5')).toBe(65.5);
    expect(parseTimeToSeconds('1:30')).toBe(90);
    expect(() => parseTimeToSeconds('abc', 'start')).toThrow(/start must be/);
    expect(() => parseTimeToSeconds(-1, 'start')).toThrow(OpValidationError);
  });

  it('skips -ss when start is undefined and never passes undefined', () => {
    const cmd = recorder();
    applyTrim(cmd, { end: 5 });
    expect(cmd.calls.find(c => c[0] === 'ss')).toBeUndefined();
    expect(cmd.calls).toContainEqual(['t', 5]);

    const cmd2 = recorder();
    applyTrim(cmd2, { start: '00:00:02', end: '00:00:05' });
    expect(cmd2.calls).toContainEqual(['ss', 2]);
    expect(cmd2.calls).toContainEqual(['t', 3]);
  });

  it('trim_video with no args is a 400, not `-ss undefined`', () => {
    expect(() => applyOperation(recorder(), 'trim_video', {})).toThrow(OpValidationError);
    expect(() => applyOperation(recorder(), 'trim_video', { start: 5, end: 2 })).toThrow(/greater than start/);
  });

  it('real fluent-ffmpeg trim args omit -ss when start is missing', () => {
    const cmd = applyOperation(ffmpeg(MP4), 'trim_video', { end: 1 });
    const argv = args(cmd.output('/tmp/o.mp4'));
    expect(argv).not.toContain('-ss');
    expect(argv).not.toContain('undefined');
    expect(argv).toContain('-t');
  });
});

describe('jobs mediaType contract', () => {
  it('publicJob includes mediaType and image content type', () => {
    const body = publicJob({
      id: 'abc', status: 'succeeded', progress: 1, operation: 'apply_color_filter',
      mediaType: 'image', resultContentType: 'image/jpeg', createdAt: 't', updatedAt: 't',
    }, 'https://grepawk.com');
    expect(body).toMatchObject({
      jobId: 'abc', mediaType: 'image', contentType: 'image/jpeg',
      resultUrl: 'https://grepawk.com/api/jobs/abc/result',
    });
    expect(publicJob({ id: 'v', status: 'queued', progress: 0 }, 'x').mediaType).toBe('video');
  });

  it('classifyAndValidateUpload rejects trim on a photo and accepts a color filter', async () => {
    const buffer = readFileSync(JPG);
    await expect(classifyAndValidateUpload({ buffer, mimetype: 'video/mp4', filename: 'video.mp4', operation: 'trim_video', args: {} }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('not supported for photos') });
    const ok = await classifyAndValidateUpload({ buffer, mimetype: 'image/jpeg', filename: 'a.jpg', operation: 'apply_color_filter', args: { filter: 'red' } });
    expect(ok).toMatchObject({ mediaType: 'image', imageFormat: 'jpeg', expectedOutputExt: 'jpg' });
  });
});

describe('HTTP routes (photo)', () => {
  let server;
  let base;
  let token;

  beforeAll(async () => {
    const app = express();
    app.use(videoRouter);
    app.use(jobsRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    token = issueSampleAccessToken();
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  function jobForm(file, name, type, operation, jobArgs) {
    const form = new FormData();
    form.append('operation', operation);
    if (jobArgs) form.append('args', JSON.stringify(jobArgs));
    form.append('video', new Blob([readFileSync(file)], { type }), name);
    return form;
  }

  it('POST /api/jobs/process-video returns 400 for trim_video on a photo', async () => {
    const res = await fetch(`${base}/api/jobs/process-video`, {
      method: 'POST',
      headers: { 'sample-access-token': token },
      body: jobForm(JPG, 'IMG_0001.jpg', 'video/mp4', 'trim_video'),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('not supported for photos');
  });

  it('POST /api/jobs/process-video returns 400 (not an ffmpeg crash) for video trim without times', async () => {
    const res = await fetch(`${base}/api/jobs/process-video`, {
      method: 'POST',
      headers: { 'sample-access-token': token },
      body: jobForm(MP4, 'clip.mp4', 'video/mp4', 'trim_video'),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/start and\/or end/);
  });

  it.skipIf(!hasFfmpeg)('photo job succeeds with mediaType image and image/jpeg result', async () => {
    const enqueue = await fetch(`${base}/api/jobs/process-video`, {
      method: 'POST',
      headers: { 'sample-access-token': token },
      body: jobForm(JPG, 'IMG_0001.jpg', 'image/jpeg', 'apply_color_filter', { filter: 'red' }),
    });
    expect(enqueue.status).toBe(202);
    const queued = await enqueue.json();
    expect(queued.mediaType).toBe('image');

    let job;
    for (let i = 0; i < 100; i += 1) {
      job = await (await fetch(`${base}/api/jobs/${queued.jobId}`, { headers: { 'sample-access-token': token } })).json();
      if (job.status === 'succeeded' || job.status === 'failed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(job).toMatchObject({ status: 'succeeded', mediaType: 'image', contentType: 'image/jpeg' });
    expect(job.resultUrl).toContain(`/api/jobs/${queued.jobId}/result`);

    const result = await fetch(`${base}/api/jobs/${queued.jobId}/result`, { headers: { 'sample-access-token': token } });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await result.arrayBuffer());
    expect(sniffMediaFormat(bytes)).toBe('jpeg');
  });

  it.skipIf(!hasFfmpeg)('sync POST /api/process-video edits a png and returns image/png', async () => {
    const res = await fetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: {
        'sample-access-token': token,
        'Content-Type': 'image/png',
        'x-operation': 'adjust_brightness',
        'x-args': JSON.stringify({ brightness: 0.1 }),
      },
      body: readFileSync(PNG),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-media-type')).toBe('image');
    expect(sniffMediaFormat(Buffer.from(await res.arrayBuffer()))).toBe('png');
  });

  it('sync POST /api/process-video rejects audio ops on a photo with 400', async () => {
    const res = await fetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: {
        'sample-access-token': token,
        'Content-Type': 'image/jpeg',
        'x-operation': 'adjust_volume',
        'x-args': JSON.stringify({ volume: 2 }),
      },
      body: readFileSync(JPG),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('not supported for photos');
  });

  it.skipIf(!hasFfmpeg)('sync video path still returns video/mp4 for a video edit', async () => {
    const res = await fetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: {
        'sample-access-token': token,
        'Content-Type': 'video/mp4',
        'x-operation': 'adjust_brightness',
        'x-args': JSON.stringify({ brightness: 0.1 }),
      },
      body: readFileSync(MP4),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('sync trim_video on a video without times is a 400', async () => {
    const res = await fetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: {
        'sample-access-token': token,
        'Content-Type': 'video/mp4',
        'x-operation': 'trim_video',
        'x-args': JSON.stringify({}),
      },
      body: readFileSync(MP4),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/start and\/or end/);
  });
});

describe('HEIC decoding', () => {
  it.skipIf(!hasFfmpeg)('converts HEIC to JPEG when ffmpeg can decode HEIF, else a clear 415', async () => {
    const out = path.join(os.tmpdir(), `heic-test-${Date.now()}.jpg`);
    try {
      const result = await processImageToFile({
        inputPath: HEIC, imageFormat: 'heic', operation: 'apply_color_filter', args: { filter: 'sepia' }, outputPath: out,
      });
      expect(result).toMatchObject({ contentType: 'image/jpeg', outputExt: 'jpg', mediaType: 'image' });
      expect(sniffMediaFormat(readFileSync(out))).toBe('jpeg');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 415 });
    } finally {
      if (existsSync(out)) unlinkSync(out);
    }
  });
});
