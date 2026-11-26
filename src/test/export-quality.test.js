import { describe, it, expect } from 'vitest';
import { X264 } from '../wasm/ops/encode.js';
import { buildProcessArgs } from '../wasm/ops/process.js';
import { buildTrimArgs } from '../wasm/ops/trim.js';
import { buildConcatArgs, buildTransitionArgs, buildBurnAssArgs, outputFps } from '../wasm/ops/multi.js';
import { withReencodeQuality, FILTER_REENCODE_OPS, X264_QUALITY } from '../server/ffmpegOps.js';

// Edits chain, so the per-edit H.264 quality decides how much a few edits in a row lose.
const crfOf = (argv) => argv[argv.indexOf('-crf') + 1];
const clip = (over = {}) => ({ path: 'a.mp4', duration: 4, width: 1920, height: 1080, hasAudio: true, fps: 30, ...over });
const graphOf = (argv) => argv[argv.indexOf('-filter_complex') + 1];

describe('browser H.264 quality', () => {
  it('re-encodes at crf 18, 8-bit yuv420p, everywhere it re-encodes', () => {
    expect(X264).toEqual(['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']);
    const io = { input: 'in.mp4', output: 'out.mp4' };
    expect(crfOf(buildProcessArgs('adjust_brightness', { brightness: 0.1 }, io))).toBe('18');
    expect(crfOf(buildProcessArgs('speed_video', { speed: 2 }, io))).toBe('18');
    expect(crfOf(buildProcessArgs('convert_video_format', { format: 'mp4', codec: 'libx264' }, io))).toBe('18');
    expect(crfOf(buildTrimArgs({ start: 1, end: 2, precise: true }, io))).toBe('18');
    expect(crfOf(buildConcatArgs([clip(), clip()], { output: 'o.mp4' }))).toBe('18');
    expect(crfOf(buildBurnAssArgs({ input: 'in.mp4', assPath: 's.ass', fontsDir: '/f', output: 'o.mp4' }))).toBe('18');
  });

  it('still stream-copies a plain trim', () => {
    const argv = buildTrimArgs({ start: 1, end: 2 }, { input: 'in.mp4', output: 'out.mp4' });
    expect(argv).not.toContain('-crf');
    expect(argv).toContain('copy');
  });
});

describe('joined clip frame rate', () => {
  it('keeps the fastest clip\'s rate instead of forcing 30', () => {
    expect(outputFps([clip({ fps: 30 }), clip({ fps: 59.94 })])).toBe(59.94);
    expect(graphOf(buildConcatArgs([clip({ fps: 60 }), clip({ fps: 30 })], { output: 'o.mp4' }))).toContain('fps=60,');
    expect(graphOf(buildTransitionArgs({ transition: 'crossfade' }, [clip({ fps: 24 }), clip({ fps: 25 })], { output: 'o.mp4' }))).toContain('fps=25,');
  });

  it('caps at 60 and falls back to 30 when no clip reports a rate', () => {
    expect(outputFps([clip({ fps: 120 }), clip({ fps: 240 })])).toBe(60);
    expect(outputFps([clip({ fps: null }), clip({ fps: undefined })])).toBe(30);
  });
});

describe('server H.264 quality', () => {
  const recorder = () => {
    const options = [];
    return { options, outputOptions(o) { options.push(...o); return this; } };
  };

  it('adds crf 18 to ops that re-encode through a filter', () => {
    for (const op of ['resize_video', 'apply_edits', 'speed_video', 'add_text']) {
      expect(FILTER_REENCODE_OPS.has(op)).toBe(true);
      expect(withReencodeQuality(recorder(), op).options).toEqual(X264_QUALITY);
    }
    expect(X264_QUALITY).toEqual(['-crf', '18']);
  });

  it('leaves copies and ops with their own encoder settings alone', () => {
    for (const op of ['trim_video', 'adjust_volume', 'convert_video_format', 'compress_video']) {
      expect(withReencodeQuality(recorder(), op).options).toEqual([]);
    }
  });
});
