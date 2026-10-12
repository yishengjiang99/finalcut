import { describe, it, expect } from 'vitest';
import { buildVisualFilter as wasmFilter, buildProcessArgs, buildEditsFilter, OpArgsError } from '../wasm/ops/process.js';
import { buildVisualFilter as serverFilter, validateVideoOperation, applyOperation, OpValidationError, assertOperationSupported } from '../server/ffmpegOps.js';
import { webToolsFor, WEB_PROFILE } from '../server/v2.js';
import { tools } from '../tools.js';

const GRAY = 'colorchannelmixer=rr=0.299:rg=0.587:rb=0.114:gr=0.299:gg=0.587:gb=0.114:br=0.299:bg=0.587:bb=0.114';
const PAD45 = 'scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2,setsar=1';
const bwInsta = [{ op: 'apply_color_filter', filter: 'black_and_white' }, { op: 'resize_video', preset: '4:5' }];

describe('apply_edits filter graph', () => {
  it('joins the edits in order into one chain (browser)', () => {
    expect(wasmFilter('apply_edits', { edits: bwInsta })).toBe(`${GRAY},${PAD45}`);
  });
  it('keeps list order', () => {
    expect(buildEditsFilter([bwInsta[1], bwInsta[0]])).toBe(`${PAD45},${GRAY}`);
  });
  it('server builds the identical chain', () => {
    expect(serverFilter('apply_edits', { edits: bwInsta }, 'video')).toBe(wasmFilter('apply_edits', { edits: bwInsta }));
  });
  it('maps preset + fit:crop to a fill-and-crop', () => {
    expect(wasmFilter('apply_edits', { edits: [{ op: 'resize_video', preset: '9:16', fit: 'crop' }, { op: 'apply_color_filter', filter: 'sepia' }] }))
      .toMatch(/^scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,colorchannelmixer=/);
  });
  it('accepts explicit sizes and other frame ops', () => {
    expect(wasmFilter('apply_edits', { edits: [{ op: 'flip_video_horizontal' }, { op: 'resize_video', width: 640, height: -1 }] }))
      .toBe('hflip,scale=640:-2');
  });
  it('encodes once: a single -vf and a single output', () => {
    const argv = buildProcessArgs('apply_edits', { edits: bwInsta }, { input: 'in.mp4', output: 'out.mp4' });
    expect(argv.filter(a => a === '-vf')).toHaveLength(1);
    expect(argv[argv.indexOf('-vf') + 1]).toBe(`${GRAY},${PAD45}`);
    expect(argv.at(-1)).toBe('out.mp4');
  });
  it('rejects bad input', () => {
    expect(() => buildEditsFilter([])).toThrow(OpArgsError);
    expect(() => buildEditsFilter([{ op: 'trim_video' }])).toThrow(/edit op must be one of/);
    expect(() => buildEditsFilter([{ op: 'resize_video', preset: '5:4' }])).toThrow(/preset must be one of/);
    expect(() => buildEditsFilter(Array(9).fill(bwInsta[0]))).toThrow(/at most 8/);
    expect(() => validateVideoOperation('apply_edits', { edits: [{ op: 'nope' }] })).toThrow(OpValidationError);
  });
  it('server applyOperation sets the chain as one video filter and copies audio', () => {
    const calls = [];
    const cmd = { videoFilters(f) { calls.push(['vf', f]); return this; }, audioCodec(c) { calls.push(['a', c]); return this; } };
    applyOperation(cmd, 'apply_edits', { edits: bwInsta });
    expect(calls).toEqual([['vf', `${GRAY},${PAD45}`], ['a', 'copy']]);
  });
  it('is allowed on photos', () => {
    expect(() => assertOperationSupported('apply_edits', 'image')).not.toThrow();
  });
});

describe('apply_edits exposure', () => {
  it('is offered to the web profile for video and photo, not audio', () => {
    expect(webToolsFor({ mediaType: 'video' }).some(t => t.function.name === 'apply_edits')).toBe(true);
    expect(webToolsFor({ mediaType: 'image' }).some(t => t.function.name === 'apply_edits')).toBe(true);
    expect(webToolsFor({ mediaType: 'audio' }).some(t => t.function.name === 'apply_edits')).toBe(false);
    expect(WEB_PROFILE.guidance.join(' ')).toMatch(/single apply_edits call/);
  });
  it('is not in the shared/iOS schema', () => {
    expect(tools.some(t => t.function.name === 'apply_edits')).toBe(false);
  });
});
