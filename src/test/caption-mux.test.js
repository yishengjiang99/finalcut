// The caption track export: argv for ffmpeg (mov_text, -c copy), and, when a local ffmpeg is installed,
// a real mux checked with ffprobe: the video and audio stay byte-identical (stream copy) and the track
// is a mov_text subtitle stream with the language tag and both caption lines.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildMuxSoftSubsArgs } from '../wasm/ops/multi.js';
import { trackToSrt } from '../captionTrack.js';

describe('buildMuxSoftSubsArgs', () => {
  const argv = buildMuxSoftSubsArgs({ input: 'in.mp4', srtPath: '/d/captions.srt', output: '/d/out.mp4', language: 'zho' });
  it('copies video and audio and encodes only the subtitle track as mov_text', () => {
    expect(argv).toEqual(expect.arrayContaining(['-c', 'copy', '-c:s', 'mov_text']));
    expect(argv.indexOf('copy')).toBeLessThan(argv.indexOf('mov_text')); // order matters: -c copy first
    expect(argv).not.toContain('-vf');
    expect(argv).not.toContain('libx264');
    expect(argv.join(' ')).not.toMatch(/ass=|subtitles=|fontsdir/); // no burn, no font
  });
  it('maps the first video, optional audio and the SRT only, so phone data streams (tmcd, mebx) are left out', () => {
    expect(argv.join(' ')).toContain('-map 0:v:0 -map 0:a? -map 1:0');
  });
  it('tags the language (ISO 639-2) and the handler name, and makes the track the default one', () => {
    expect(argv.join(' ')).toContain('-metadata:s:s:0 language=zho');
    expect(argv.join(' ')).toContain('handler_name=Captions');
    expect(argv.join(' ')).toContain('-disposition:s:0 default');
    expect(buildMuxSoftSubsArgs({ input: 'a', srtPath: 'b', output: 'c', language: 'zh-Hans' }).join(' ')).toContain('language=und');
  });
  it('faststart, output last', () => {
    expect(argv.slice(-3)).toEqual(['-movflags', '+faststart', '/d/out.mp4']);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
describe.skipIf(!hasFfmpeg)('real ffmpeg: mov_text mux with -c copy', () => {
  it('adds one mov_text track and leaves the video and audio streams untouched', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mux-'));
    try {
      const inp = path.join(dir, 'in.mp4');
      const out = path.join(dir, 'out.mp4');
      const srtFile = path.join(dir, 'captions.srt');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x284:rate=15:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', inp]);
      const track = { lines: [{ start: 0.5, end: 2, text: 'Hello <i>world</i>', translation: '你好，世界' }, { start: 2.5, end: 3.5, text: 'Bye', translation: '再见' }] };
      writeFileSync(srtFile, trackToSrt(track));
      const argv = buildMuxSoftSubsArgs({ input: inp, srtPath: srtFile, output: out, language: 'zho' }).filter(a => a !== '-hide_banner');
      execFileSync('ffmpeg', ['-loglevel', 'error', ...argv]);
      const probe = JSON.parse(execFileSync('ffprobe', ['-loglevel', 'error', '-show_streams', '-of', 'json', out]).toString());
      const kinds = probe.streams.map(s => `${s.codec_type}:${s.codec_name}`);
      expect(kinds).toEqual(['video:h264', 'audio:aac', 'subtitle:mov_text']);
      expect(probe.streams[2].tags.language).toBe('zho');
      const md5 = (file, map) => execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-map', map, '-c', 'copy', '-f', 'md5', '-']).toString();
      expect(md5(out, '0:v')).toBe(md5(inp, '0:v'));
      expect(md5(out, '0:a')).toBe(md5(inp, '0:a'));
      const text = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-map', '0:s:0', '-f', 'srt', '-']).toString();
      expect(text).toContain('Hello world');
      expect(text).toContain('你好，世界');
      expect(text).not.toMatch(/<i>/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
