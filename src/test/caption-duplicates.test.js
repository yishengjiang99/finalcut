// @vitest-environment node
// Regression: burned-in captions showed every line twice. Each caption line must be in the
// burned subtitle files exactly once, and burn_subtitles must apply a single subtitles filter
// unless there is a real translation. OpenAI transcription is mocked.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => { process.env.OPENAI_API_KEY ||= 'test-openai-key-not-for-prod'; });

import express from 'express';
import axios from 'axios';
import { spawnSync } from 'child_process';
import { promises as fs, readFileSync, mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import { captionsRouter } from '../server/captions.js';
import { videoRouter, burnSubtitleTracks } from '../server/video.js';
import { issueSampleAccessToken, videoProcessLimiter } from '../server/middleware.js';
import {
  dedupeSegments,
  dedupeSrtCues,
  translatedTrackWithoutDuplicates,
  parseSrtCues,
} from '../server/captionHelpers.js';

const filters = spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout?.toString() || '';
const hasLibass = /\ssubtitles\s+V->V/.test(filters);

const countLine = (srt, line) => parseSrtCues(srt).filter(c => c.text === line).length;

describe('caption de-duplication helpers', () => {
  it('merges back-to-back repeated transcriber segments', () => {
    const segs = dedupeSegments([
      { start: 0, end: 2, text: 'Hello world', speaker: null },
      { start: 2, end: 4, text: 'hello world.', speaker: null },
      { start: 4, end: 6, text: 'Second line', speaker: null },
      { start: 30, end: 32, text: 'Second line', speaker: null }, // a real repeat much later stays
    ]);
    expect(segs.map(s => [s.start, s.end, s.text])).toEqual([[0, 4, 'Hello world'], [4, 6, 'Second line'], [30, 32, 'Second line']]);
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nHi there\n\n2\n00:00:01,500 --> 00:00:03,000\nHi there!\n\n3\n00:00:03,000 --> 00:00:04,000\nBye';
    expect(dedupeSrtCues(srt)).toBe('1\n00:00:00,000 --> 00:00:03,000\nHi there\n\n2\n00:00:03,000 --> 00:00:04,000\nBye');
  });

  it('drops translated cues that only repeat the original line', () => {
    const original = '1\n00:00:00,000 --> 00:00:02,000\nHello world\n\n2\n00:00:02,000 --> 00:00:04,000\nGood morning';
    // Same-language "translation" that only changed punctuation/case → nothing to burn.
    expect(translatedTrackWithoutDuplicates(original, '1\n00:00:00,000 --> 00:00:02,000\nHello, World!\n\n2\n00:00:02,000 --> 00:00:04,000\ngood morning')).toBe('');
    // Partial translation (second cue padded with the original) → only the real translation stays.
    expect(translatedTrackWithoutDuplicates(original, '1\n00:00:00,000 --> 00:00:02,000\nHola mundo\n\n2\n00:00:02,000 --> 00:00:04,000\nGood morning'))
      .toBe('1\n00:00:00,000 --> 00:00:02,000\nHola mundo');
    const tracks = burnSubtitleTracks(original, '1\n00:00:00,000 --> 00:00:02,000\nHola mundo\n\n2\n00:00:02,000 --> 00:00:04,000\nBuenos días');
    expect(parseSrtCues(tracks.translatedTrack)).toHaveLength(2);
    expect(burnSubtitleTracks(original, original).translatedTrack).toBe('');
  });
});

describe.skipIf(!hasLibass)('generate → burn_subtitles (real ffmpeg, mocked transcription)', () => {
  let server;
  let base;
  let dir;
  let video;
  let axiosSpy;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'capdup-'));
    video = path.join(dir, 'in.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x204060:s=360x640:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
    // Whisper-style response with the same line emitted twice back to back.
    axiosSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        language: 'english',
        duration: 4,
        segments: [
          { start: 0, end: 1.5, text: ' Hello world' },
          { start: 1.5, end: 2, text: ' Hello world.' },
          { start: 2, end: 4, text: ' This is a test' },
        ],
      },
    });
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(captionsRouter);
    app.use(videoRouter);
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
    for (const key of ['127.0.0.1', '::ffff:127.0.0.1']) await videoProcessLimiter.resetKey(key);
  });

  afterAll(async () => {
    axiosSpy?.mockRestore();
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('each line is burned exactly once with a single subtitles filter', async () => {
    const token = issueSampleAccessToken();
    const gen = await fetch(`${base}/api/generate-captions`, {
      method: 'POST',
      headers: { 'Content-Type': 'video/mp4', 'x-args': '{"language":"en"}', 'sample-access-token': token },
      body: readFileSync(video),
    });
    expect(gen.status).toBe(200);
    const { srt } = await gen.json();
    expect(countLine(srt, 'Hello world')).toBe(1);
    expect(countLine(srt, 'Hello world.')).toBe(0);
    expect(countLine(srt, 'This is a test')).toBe(1);

    // A same-language "translation" (only punctuation changed) used to be burned as a second track.
    const translated = srt.replace('Hello world', 'Hello, world!').replace('This is a test', 'This is a test.');
    const written = [];
    const realWrite = fs.writeFile;
    const writeSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (p, data, ...rest) => {
      if (String(p).endsWith('.srt')) written.push(String(data));
      return realWrite.call(fs, p, data, ...rest);
    });
    const commands = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (String(args[0]).startsWith('FFmpeg command (burn_subtitles)')) commands.push(String(args[1]));
    });
    try {
      const form = new FormData();
      form.append('video', new Blob([readFileSync(video)], { type: 'video/mp4' }), 'in.mp4');
      form.append('operation', 'burn_subtitles');
      form.append('args', JSON.stringify({ srtContent: srt, translatedSrtContent: translated }));
      const res = await fetch(`${base}/api/process-video`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
      expect(res.status).toBe(200);
      const out = Buffer.from(await res.arrayBuffer());
      expect(out.length).toBeGreaterThan(1000);
    } finally {
      writeSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(written).toHaveLength(1); // no second (translated) track
    const allText = written.join('\n');
    for (const line of ['Hello world', 'This is a test']) {
      expect(allText.split(line).length - 1).toBe(1);
    }
    expect(commands).toHaveLength(1);
    expect(commands[0].match(/subtitles=/g)).toHaveLength(1);
    expect(commands[0]).not.toMatch(/drawtext/);
  });
});
