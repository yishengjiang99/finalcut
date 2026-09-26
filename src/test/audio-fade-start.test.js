// @vitest-environment node
// audio_fade `start`: documented optional arg, validated, with defaults that match iOS
// (fade-in at 0, fade-out ending at the end of the clip).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, unlinkSync, mkdtempSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { tools } from '../tools.js';
import {
  OpValidationError,
  applyOperation,
  audioFadeNeedsDuration,
  buildAudioFadeFilter,
  probeMediaDuration,
  processVideoToFile,
  validateAudioFadeArgs,
  validateVideoOperation,
} from '../server/ffmpegOps.js';
import { jobsRouter } from '../server/jobs.js';
import { videoRouter } from '../server/video.js';
import { issueSampleAccessToken } from '../server/middleware.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaFile = path.join(here, '..', '..', 'docs', 'api', 'tools-schema.v1.json');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function recorder() {
  const calls = [];
  const cmd = {
    calls,
    audioFilters(v) { calls.push(['af', v]); return cmd; },
    videoCodec(v) { calls.push(['vc', v]); return cmd; },
  };
  return cmd;
}

function codeOf(fn) {
  try { fn(); } catch (e) { return e instanceof OpValidationError ? e.code : `not-op-error: ${e.message}`; }
  return null;
}

describe('audio_fade tool definition', () => {
  const fade = () => tools.find(t => t.function.name === 'audio_fade').function.parameters;

  it('declares start as an optional non-negative number with a description', () => {
    const { properties, required } = fade();
    expect(properties.start).toMatchObject({ type: 'number', minimum: 0 });
    expect(properties.start.description).toMatch(/seconds/);
    expect(properties.start.description).toMatch(/clip length - duration/);
    expect(required).toEqual(['type', 'duration']);
    expect(required).not.toContain('start');
  });

  it('only adds start (type/duration unchanged)', () => {
    const { properties } = fade();
    expect(Object.keys(properties)).toEqual(['type', 'duration', 'start']);
    expect(properties.type.enum).toEqual(['in', 'out']);
    expect(properties.duration).toEqual({ type: 'number', description: 'Duration of the fade effect in seconds.', default: 3 });
  });

  it('the committed v1 schema documents start and stays schemaVersion "1"', () => {
    const schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
    expect(schema.schemaVersion).toBe('1');
    const fadeTool = schema.tools.find(t => t.function.name === 'audio_fade');
    expect(fadeTool.function.parameters.properties.start).toEqual(fade().properties.start);
    expect(fadeTool.function.parameters.required).not.toContain('start');
  });
});

describe('audio_fade filter semantics', () => {
  it('uses an explicit start for both fade types', () => {
    expect(buildAudioFadeFilter({ type: 'in', start: 1.5, duration: 2 })).toBe('afade=t=in:st=1.5:d=2');
    expect(buildAudioFadeFilter({ type: 'out', start: 4, duration: 2 }, { mediaDuration: 10 })).toBe('afade=t=out:st=4:d=2');
    expect(buildAudioFadeFilter({ type: 'in', start: 0, duration: 1 })).toBe('afade=t=in:st=0:d=1');
  });

  it('defaults a fade-in to start 0 without probing', () => {
    expect(audioFadeNeedsDuration({ type: 'in', duration: 3 })).toBe(false);
    expect(buildAudioFadeFilter({ type: 'in', duration: 3 })).toBe('afade=t=in:st=0:d=3');
  });

  it('defaults a fade-out to clip length - duration so it ends at the end', () => {
    expect(audioFadeNeedsDuration({ type: 'out', duration: 2 })).toBe(true);
    expect(audioFadeNeedsDuration({ type: 'out', duration: 2, start: 1 })).toBe(false);
    expect(buildAudioFadeFilter({ type: 'out', duration: 2 }, { mediaDuration: 6 })).toBe('afade=t=out:st=4:d=2');
    expect(buildAudioFadeFilter({ type: 'out', duration: 2 }, { mediaDuration: 6.016 })).toBe('afade=t=out:st=4.016:d=2');
    // Fade longer than the clip: start clamps to 0.
    expect(buildAudioFadeFilter({ type: 'out', duration: 10 }, { mediaDuration: 6 })).toBe('afade=t=out:st=0:d=10');
  });

  it('never emits st=undefined: a fade-out without start and unknown length is invalid_arguments', () => {
    expect(codeOf(() => buildAudioFadeFilter({ type: 'out', duration: 2 }))).toBe('invalid_arguments');
    expect(() => buildAudioFadeFilter({ type: 'out', duration: 2 })).toThrow(/start is required/);
  });

  it('accepts numeric strings (as the server did before)', () => {
    expect(buildAudioFadeFilter({ type: 'in', start: '2', duration: '1.5' })).toBe('afade=t=in:st=2:d=1.5');
  });

  it('applyOperation wires the filter and copies video', () => {
    const cmd = applyOperation(recorder(), 'audio_fade', { type: 'out', duration: 1 }, { mediaDuration: 5 });
    expect(cmd.calls).toEqual([['af', 'afade=t=out:st=4:d=1'], ['vc', 'copy']]);
  });
});

describe('audio_fade argument validation (invalid_arguments)', () => {
  for (const start of [-1, -0.001, 'abc', '', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects start=${JSON.stringify(start) ?? String(start)}`, () => {
      expect(codeOf(() => validateAudioFadeArgs({ type: 'in', duration: 1, start }))).toBe('invalid_arguments');
      expect(codeOf(() => validateVideoOperation('audio_fade', { type: 'in', duration: 1, start }))).toBe('invalid_arguments');
    });
  }

  it('allows start omitted, null, 0 and positive values', () => {
    expect(validateAudioFadeArgs({ type: 'out', duration: 1 })).toEqual({ start: null, duration: 1 });
    expect(validateAudioFadeArgs({ type: 'out', duration: 1, start: null })).toEqual({ start: null, duration: 1 });
    expect(validateAudioFadeArgs({ type: 'in', duration: 1, start: 0 })).toEqual({ start: 0, duration: 1 });
    expect(() => validateVideoOperation('audio_fade', { type: 'in', duration: 1, start: 12.5 })).not.toThrow();
  });

  it('rejects a missing or non-positive duration instead of crashing ffmpeg', () => {
    for (const duration of [undefined, null, 0, -2, 'x']) {
      expect(codeOf(() => validateVideoOperation('audio_fade', { type: 'in', duration }))).toBe('invalid_arguments');
    }
  });
});

describe('probeMediaDuration', () => {
  it('prefers format duration, falls back to the longest stream, else null', async () => {
    expect(await probeMediaDuration('x', { probe: async () => ({ format: { duration: 6.5 }, streams: [{ duration: '6.4' }] }) })).toBe(6.5);
    expect(await probeMediaDuration('x', { probe: async () => ({ format: {}, streams: [{ duration: '3' }, { duration: '4.2' }] }) })).toBe(4.2);
    expect(await probeMediaDuration('x', { probe: async () => ({ format: { duration: 'N/A' }, streams: [] }) })).toBeNull();
    expect(await probeMediaDuration('x', { probe: async () => null })).toBeNull();
  });
});

// Real ffmpeg: a 4s 440Hz tone (lavfi sine is 1/8 scale, about -21 dB mean), measured in windows after the fade.
function meanVolume(file, ss, t) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(ss), '-t', String(t), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = String(r.stderr).match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!m) throw new Error(`volumedetect failed: ${r.stderr}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

describe.skipIf(!hasFfmpeg)('audio_fade end to end', () => {
  let dir;
  let tone;
  let server;
  let base;
  let token;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fade-'));
    tone = path.join(dir, 'tone-4s.mp4');
    const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tone]);
    if (gen.status !== 0) throw new Error(String(gen.stderr));
    const app = express();
    app.use(videoRouter);
    app.use(jobsRouter);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
    token = issueSampleAccessToken();
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  async function runJob(args) {
    const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}.mp4`);
    await processVideoToFile({ inputPath: tone, inputMime: 'video/mp4', operation: 'audio_fade', args, outputPath: out });
    return out;
  }

  it('fade-out without start ends at the end of the clip', async () => {
    const out = await runJob({ type: 'out', duration: 1 });
    const body = meanVolume(out, 0.5, 2);
    const tail = meanVolume(out, 3.6, 0.35);
    expect(body).toBeGreaterThan(-25);
    expect(tail).toBeLessThan(body - 10);
    unlinkSync(out);
  });

  it('fade-in without start begins at 0', async () => {
    const out = await runJob({ type: 'in', duration: 1 });
    expect(meanVolume(out, 0, 0.3)).toBeLessThan(meanVolume(out, 2, 1.5) - 10);
    unlinkSync(out);
  });

  it('explicit start: fade-out at 1s leaves the rest silent; fade-in at 2s is silent before it', async () => {
    const out1 = await runJob({ type: 'out', start: 1, duration: 0.5 });
    expect(meanVolume(out1, 0.2, 0.6)).toBeGreaterThan(-25);
    expect(meanVolume(out1, 2, 1.5)).toBeLessThan(-60);
    const out2 = await runJob({ type: 'in', start: 2, duration: 0.5 });
    expect(meanVolume(out2, 0.2, 1.5)).toBeLessThan(-60);
    expect(meanVolume(out2, 3, 0.8)).toBeGreaterThan(-25);
    [out1, out2].forEach(p => existsSync(p) && unlinkSync(p));
  });

  it('sync POST /api/process-video: fade-out with no start succeeds (was afade st=undefined)', async () => {
    const res = await fetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: {
        'sample-access-token': token,
        'Content-Type': 'video/mp4',
        'x-operation': 'audio_fade',
        'x-args': JSON.stringify({ type: 'out', duration: 1 }),
      },
      body: readFileSync(tone),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  it('sync POST /api/process-video: negative start is 400 invalid_arguments', async () => {
    const res = await fetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: {
        'sample-access-token': token,
        'Content-Type': 'video/mp4',
        'x-operation': 'audio_fade',
        'x-args': JSON.stringify({ type: 'in', duration: 1, start: -2 }),
      },
      body: readFileSync(tone),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'audio_fade start must be a non-negative number of seconds', code: 'invalid_arguments' });
  });

  it('POST /api/jobs/process-video: non-numeric start is 400 invalid_arguments at submit', async () => {
    const form = new FormData();
    form.append('operation', 'audio_fade');
    form.append('args', JSON.stringify({ type: 'out', duration: 1, start: 'soon' }));
    form.append('video', new Blob([readFileSync(tone)], { type: 'video/mp4' }), 'clip.mp4');
    const res = await fetch(`${base}/api/jobs/process-video`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'audio_fade start must be a non-negative number of seconds', code: 'invalid_arguments' });
  });

  it('POST /api/jobs/process-video: fade-out with no start succeeds', async () => {
    const form = new FormData();
    form.append('operation', 'audio_fade');
    form.append('args', JSON.stringify({ type: 'out', duration: 1 }));
    form.append('video', new Blob([readFileSync(tone)], { type: 'video/mp4' }), 'clip.mp4');
    const enqueue = await fetch(`${base}/api/jobs/process-video`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
    expect(enqueue.status).toBe(202);
    const { jobId } = await enqueue.json();
    let job;
    for (let i = 0; i < 200; i += 1) {
      job = await (await fetch(`${base}/api/jobs/${jobId}`, { headers: { 'sample-access-token': token } })).json();
      if (job.status === 'succeeded' || job.status === 'failed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(job).toMatchObject({ status: 'succeeded', contentType: 'video/mp4' });
  });
});
