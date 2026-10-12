#!/usr/bin/env node
// Runs the SERVER filter builders (src/server/ffmpegOps.js) through a real ffmpeg binary and checks
// output size, SAR, pad-bar color and rotate framing. Opt-in, not part of `npm test` or CI.
//   FFMPEG=/path/to/ffmpeg-4.4.2 FFPROBE=/path/to/ffprobe node scripts/verify-server-filters.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildVisualFilter, buildEditsFilter } from '../src/server/ffmpegOps.js';

const FF = process.env.FFMPEG || 'ffmpeg';
const FP = process.env.FFPROBE || 'ffprobe';
const dir = mkdtempSync(path.join(tmpdir(), 'fc-verify-'));
const src = path.join(dir, 'src.mp4');
const run = (args) => execFileSync(FF, ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
run(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);

const probe = (f) => {
  const [w, h, sar] = execFileSync(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio', '-of', 'csv=p=0', f]).toString().trim().split(',');
  return { w: +w, h: +h, sar };
};
// Mean RGB of a small box of the first frame.
const sample = (f, x, y, s = 8) => {
  const buf = execFileSync(FF, ['-v', 'error', '-i', f, '-frames:v', '1', '-vf', `crop=${s}:${s}:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const m = [0, 1, 2].map(c => { let t = 0; for (let i = c; i < buf.length; i += 3) t += buf[i]; return Math.round(t / (buf.length / 3)); });
  return m;
};
const dark = (rgb) => rgb.every(c => c < 24);

const cases = [
  { name: 'B&W + 4:5 pad (apply_edits)', vf: buildEditsFilter([{ op: 'apply_color_filter', filter: 'black_and_white' }, { op: 'resize_video', preset: '4:5' }], 'video'), w: 1080, h: 1350, bar: [0, 0] },
  { name: 'invert listed after 1:1 pad: bars stay black', vf: buildEditsFilter([{ op: 'resize_video', preset: '1:1' }, { op: 'apply_color_filter', filter: 'invert' }], 'video'), w: 1080, h: 1080, bar: [0, 0] },
  { name: 'sepia + 9:16 crop', vf: buildEditsFilter([{ op: 'apply_color_filter', filter: 'sepia' }, { op: 'resize_video', preset: '9:16', fit: 'crop' }], 'video'), w: 1080, h: 1920 },
  { name: 'odd pad size 1081x1351 -> even', vf: buildVisualFilter('resize_video', { width: 1081, height: 1351, fit: 'pad' }, 'video'), w: 1080, h: 1350 },
  { name: 'odd crop-fit 721x721 -> even', vf: buildVisualFilter('resize_video', { width: 721, height: 721, fit: 'crop' }, 'video'), w: 720, h: 720 },
  { name: 'odd crop_video 721x501', vf: buildVisualFilter('crop_video', { width: 721, height: 501, x: 10, y: 10 }, 'video'), w: 720, h: 500, sarAny: true },
  { name: 'odd plain scale 641x-1', vf: buildVisualFilter('resize_video', { width: 641, height: -1 }, 'video'), w: 640, h: 360, sarAny: true },
  { name: 'rotate 90 (transpose, no clip)', vf: buildVisualFilter('rotate_video', { angle: 90 }, 'video'), w: 1080, h: 1920, sarAny: true, content: [540, 960] },
  { name: 'rotate 270', vf: buildVisualFilter('rotate_video', { angle: 270 }, 'video'), w: 1080, h: 1920, sarAny: true },
  { name: 'rotate 180', vf: buildVisualFilter('rotate_video', { angle: 180 }, 'video'), w: 1920, h: 1080, sarAny: true },
  { name: 'rotate 45 (bounding box, even)', vf: buildVisualFilter('rotate_video', { angle: 45 }, 'video'), even: true, minW: 2100, sarAny: true, bar: [0, 0] },
  { name: 'apply_edits rotate 90 + 4:5 pad', vf: buildEditsFilter([{ op: 'rotate_video', angle: 90 }, { op: 'resize_video', preset: '4:5' }], 'video'), w: 1080, h: 1350 },
];

let fails = 0;
console.log(execFileSync(FF, ['-version']).toString().split('\n')[0]);
console.log('| case | filter ok | size | SAR | checks |\n|---|---|---|---|---|');
for (const [i, c] of cases.entries()) {
  const out = path.join(dir, `o${i}.mp4`);
  let row;
  try {
    run(['-i', src, '-vf', c.vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', out]);
    const p = probe(out);
    const notes = [];
    let ok = true;
    if (c.w && (p.w !== c.w || p.h !== c.h)) { ok = false; notes.push(`expected ${c.w}x${c.h}`); }
    if (c.even && (p.w % 2 || p.h % 2)) { ok = false; notes.push('odd size'); }
    if (c.minW && p.w < c.minW) { ok = false; notes.push('clipped'); }
    if (!c.sarAny && p.sar !== '1:1') { ok = false; notes.push('SAR not 1:1'); }
    if (c.bar) { const rgb = sample(out, ...c.bar); if (!dark(rgb)) { ok = false; notes.push(`bar ${rgb}`); } else notes.push(`bar black ${rgb}`); }
    if (c.content) { const rgb = sample(out, ...c.content); if (dark(rgb)) { ok = false; notes.push('center black'); } else notes.push('center has picture'); }
    if (!ok) fails += 1;
    row = `| ${c.name} | ${ok ? 'yes' : 'NO'} | ${p.w}x${p.h} | ${p.sar} | ${notes.join('; ')} |`;
  } catch (e) {
    fails += 1;
    row = `| ${c.name} | NO | - | - | ffmpeg error: ${String(e.stderr || e.message).split('\n')[0].slice(0, 120)} |`;
  }
  console.log(row);
}
rmSync(dir, { recursive: true, force: true });
console.log(`\n${cases.length - fails}/${cases.length} passed`);
process.exit(fails ? 1 : 0);
