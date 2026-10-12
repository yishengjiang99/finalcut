#!/usr/bin/env node
// LIVE eval of agentic tool calling (opt-in, NOT part of `npm test` or CI).
// Sends a fixed prompt set to xAI with the exact /api/v2/chat system prompt + web tools
// and reports which tools the model calls. With --ffmpeg it also replays the chosen calls
// with the native ffmpeg CLI on a generated testsrc clip and checks size / SAR / encode count.
//
//   XAI_API_KEY=... npm run eval:agentic -- [--runs 3] [--ffmpeg] [--only bw_instagram]
//
// Run it whenever src/tools.js, src/server/chat.js, src/server/v2.js, src/clientTurn.js
// or the ops builders change. The key is read from XAI_API_KEY (or XAI_API_TOKEN) and never printed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const RUNS = Number(opt('runs', 3));
const ONLY = opt('only', null);
const KEY = process.env.XAI_API_KEY || process.env.XAI_API_TOKEN;
if (!KEY) { console.error('Set XAI_API_KEY to run the live eval.'); process.exit(2); }
// The server modules check these at import time; the eval itself never uses them.
process.env.XAI_API_TOKEN ||= 'eval-unused';
process.env.SESSION_SECRET ||= 'eval-only-session-secret-not-used-0000';

const { buildSystemMessage, getClientExecutionModel } = await import('../src/server/chat.js');
const { mediaContextText } = await import('../src/server/clientExecution.js');
const { WEB_PROFILE } = await import('../src/server/v2.js');
const ops = await import('../src/wasm/ops/process.js');

const MEDIA = { type: 'video', duration: 6, width: 1920, height: 1080, fps: 30, hasAudio: true, sizeBytes: 900000 };
// expect: tool names that must appear (all), in this order; shape: expected final WxH after replay (optional).
const PROMPTS = [
  { id: 'bw_instagram', text: 'make the video black and white and resize to Instagram shape', expect: ['apply_edits'], shape: '1080x1350' },
  { id: 'sepia_reels', text: 'sepia look and make it 9:16 for reels', expect: ['apply_edits'], shape: '1080x1920' },
  { id: 'trim_gray', text: 'trim to the first 3 seconds and make it grayscale', expect: ['trim_video'] },
  { id: 'speed_square', text: 'speed it up 2x and crop it to a square', expect: ['adjust_speed'] },
  { id: 'single_bw', text: 'make it black and white', expect: ['apply_color_filter'] },
  { id: 'single_reels', text: 'resize for TikTok', expect: ['resize_video_preset'], shape: '1080x1920' },
  { id: 'ambiguous_insta', text: 'make it look good for insta', expect: [] },
  { id: 'audio_visual', text: 'turn the volume down by half and make it black and white', expect: ['adjust_audio_volume', 'apply_color_filter'] },
  { id: 'three_op', text: 'flip it horizontally, boost saturation a bit, and make it square', expect: ['apply_edits'], shape: '1080x1080' },
].filter(p => !ONLY || p.id === ONLY);

const system = buildSystemMessage({ mediaType: 'video' }).content + '\n\n' +
  [WEB_PROFILE.instructions, mediaContextText(MEDIA), ...WEB_PROFILE.guidance].join('\n');
const tools = WEB_PROFILE.tools({ mediaType: 'video' });

async function ask(text) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: getClientExecutionModel(), messages: [{ role: 'system', content: system }, { role: 'user', content: text }], tools, tool_choice: 'auto', stream: false }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const msg = (await res.json()).choices?.[0]?.message || {};
  return {
    content: msg.content || '',
    raw: process.env.EVAL_RAW ? (msg.tool_calls || []).map(c => c.function.arguments) : undefined,
    calls: (msg.tool_calls || []).map(c => { let a = {}; try { a = JSON.parse(c.function.arguments || '{}'); } catch { a = { _bad: true }; } return { name: c.function.name, args: a }; }),
  };
}

const short = c => {
  if (c.name === 'apply_edits') return `apply_edits[${(c.args.edits || []).map(e => e.op === 'resize_video' && e.preset ? `resize:${e.preset}${e.fit ? '/' + e.fit : ''}` : e.op === 'apply_color_filter' ? `color:${e.filter}` : e.op).join(',')}]`;
  if (c.name === 'resize_video_preset') return `resize_video_preset:${c.args.preset}${c.args.fit ? '/' + c.args.fit : ''}`;
  if (c.name === 'apply_color_filter') return `color:${c.args.filter}`;
  return c.name;
};

// ── ffmpeg replay ────────────────────────────────────────────────────────────
const PRESETS = ops.ASPECT_PRESET_SIZES;
function toOp(call) {
  const { name, args } = call;
  if (name === 'resize_video_preset') { const [w, h] = PRESETS[args.preset] || []; return w && ['resize_video', { width: w, height: h, fit: args.fit === 'crop' ? 'crop' : 'pad' }]; }
  if (name === 'adjust_speed') return ['speed_video', args];
  if (name === 'adjust_audio_volume') return ['adjust_volume', args];
  const known = ['apply_edits', 'apply_color_filter', 'crop_video', 'resize_video', 'rotate_video', 'flip_video_horizontal', 'flip_video_vertical', 'adjust_brightness', 'adjust_contrast', 'adjust_hue', 'adjust_saturation', 'trim_video', 'adjust_volume', 'adjust_audio_volume'];
  return known.includes(name) ? [name, args] : null;
}
function replay(calls, src, dir) {
  let input = src; let encodes = 0; const t0 = Date.now();
  for (const [i, call] of calls.entries()) {
    const op = toOp(call);
    if (!op) return { note: `not replayed: ${call.name}` };
    const out = path.join(dir, `step${i}.mp4`);
    const args = ops.buildProcessArgs(op[0], op[1], { input, output: out, duration: MEDIA.duration });
    execFileSync('ffmpeg', ['-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (args.includes('libx264')) encodes += 1;
    input = out;
  }
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,sample_aspect_ratio,display_aspect_ratio', '-of', 'csv=p=0', input]).toString().trim().split(',');
  return { size: `${probe[0]}x${probe[1]}`, sar: probe[2], dar: probe[3], encodes, ms: Date.now() - t0 };
}

let src; let dir;
if (flag('ffmpeg')) {
  dir = mkdtempSync(path.join(tmpdir(), 'fc-eval-'));
  src = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${MEDIA.width}x${MEDIA.height}:r=30:d=${MEDIA.duration}`, '-f', 'lavfi', '-i', `sine=d=${MEDIA.duration}`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
}

const rows = [];
for (const p of PROMPTS) {
  const results = await Promise.all(Array.from({ length: RUNS }, () => ask(p.text)));
  for (const [run, r] of results.entries()) {
    if (r.raw) console.error(p.id, JSON.stringify(r.raw));
    const names = (r.calls || []).map(c => c.name);
    const pass = !r.error && p.expect.every(n => names.includes(n));
    const row = { prompt: p.id, run, calls: r.error || (r.calls.length ? r.calls.map(short).join(' -> ') : `(no tools) ${r.content.slice(0, 80)}`), pass };
    if (src && r.calls?.length && run === 0) {
      try { Object.assign(row, replay(r.calls, src, dir)); if (p.shape && row.size !== p.shape) row.pass = false; } catch (e) { row.note = `ffmpeg failed: ${String(e.stderr || e.message).slice(0, 120)}`; row.pass = false; }
    }
    rows.push(row);
  }
}
if (dir) rmSync(dir, { recursive: true, force: true });

console.log(`model=${getClientExecutionModel()} runs=${RUNS} prompts=${PROMPTS.length}\n`);
console.log('| prompt | run | tool calls | ok | final size | SAR | encodes | ms |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.prompt} | ${r.run} | ${r.calls} | ${r.pass ? 'yes' : 'NO'} | ${r.size || r.note || ''} | ${r.sar || ''} | ${r.encodes ?? ''} | ${r.ms ?? ''} |`);
const passed = rows.filter(r => r.pass).length;
console.log(`\n${passed}/${rows.length} runs met expectations`);
