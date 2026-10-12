import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVisualFilter } from '../wasm/ops/process.js';

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// Runs the real filter strings through ffmpeg on synthetic landscape/portrait clips (skipped without ffmpeg).
describe.skipIf(!hasFfmpeg)('resize_video fit with real ffmpeg', () => {
  const run = (srcSize, fit, w, h) => {
    const dir = mkdtempSync(join(tmpdir(), 'fit-'));
    try {
      const src = join(dir, 'in.mp4'), out = join(dir, 'out.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${srcSize}:d=0.5`, '-f', 'lavfi', '-i', 'sine=d=0.5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', buildVisualFilter('resize_video', { width: w, height: h, fit }), '-c:a', 'copy', out]);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,sample_aspect_ratio,display_aspect_ratio', '-of', 'json', out]).toString());
      return probe.streams;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  for (const src of ['1920x1080', '1080x1920', '854x480']) {
    for (const fit of ['pad', 'crop']) {
      it(`${src} -> 4:5 ${fit} is exactly 1080x1350, square pixels, audio kept`, () => {
        const streams = run(src, fit, 1080, 1350);
        const v = streams.find(s => s.codec_type === 'video');
        expect([v.width, v.height, v.sample_aspect_ratio, v.display_aspect_ratio]).toEqual([1080, 1350, '1:1', '4:5']);
        expect(streams.some(s => s.codec_type === 'audio')).toBe(true);
      });
    }
  }
}, 60000);
