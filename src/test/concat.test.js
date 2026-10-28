import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { setUploadConsentHandler } from '../engineMode.js';

vi.mock('../wasm/ffmpegEngine.js', async (importOriginal) => (await import('./helpers/noWasmEngine.js')).noWasmEngine(importOriginal));
beforeAll(() => setUploadConsentHandler(() => true));
import { toolFunctions } from '../toolFunctions.js';
import * as engine from '../wasm/ffmpegEngine.js';
import { buildConcatArgs } from '../wasm/ops/multi.js';
import { validateClips, clipsContextText } from '../server/clientExecution.js';

const clip = (over = {}) => ({ path: 'a.mp4', duration: 2, width: 1280, height: 720, hasAudio: true, ...over });

describe('buildConcatArgs', () => {
  it('needs two clips', () => {
    expect(() => buildConcatArgs([clip()], { output: 'o.mp4' })).toThrow(/two video clips/);
  });

  it('fits every clip to the first clip and joins audio and video', () => {
    const args = buildConcatArgs([clip({ path: 'a.mp4', width: 1281 }), clip({ path: 'b.mp4', width: 640, height: 360 })], { output: 'o.mp4' });
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('scale=1280:720');
    expect(graph).toContain('concat=n=2:v=1:a=0[v]');
    expect(graph).toContain('concat=n=2:v=0:a=1[a]');
    expect(args).toContain('[a]');
    expect(args.at(-1)).toBe('o.mp4');
  });

  it('gives a silent clip silence of its own length', () => {
    const args = buildConcatArgs([clip(), clip({ hasAudio: false, duration: 3.5 })], { output: 'o.mp4' });
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=3.5[a1]');
  });

  it('drops audio entirely when no clip has any', () => {
    const args = buildConcatArgs([clip({ hasAudio: false }), clip({ hasAudio: false })], { output: 'o.mp4' });
    expect(args).not.toContain('[a]');
  });
});

describe('concat_videos', () => {
  let addMessage;
  let setVideoFileData;
  beforeEach(() => {
    vi.clearAllMocks();
    addMessage = vi.fn();
    setVideoFileData = vi.fn();
    global.URL.createObjectURL = vi.fn(() => 'mock-url');
  });

  it('joins the requested clips and posts the result', async () => {
    const loadClips = vi.fn(async ids => ids.map(() => ({ bytes: new Uint8Array([1]), mimeType: 'video/mp4' })));
    const result = await toolFunctions.concat_videos({ clipIds: ['1', '2'] }, new Uint8Array([1]), setVideoFileData, addMessage, { loadClips });
    expect(loadClips).toHaveBeenCalledWith(['1', '2']);
    expect(engine.concatClips).toHaveBeenCalledOnce();
    expect(setVideoFileData).toHaveBeenCalled();
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: 'mock-url', mimeType: 'video/mp4' }));
    expect(result).toMatch(/^Joined 2 clips/);
  });

  it('fails with fewer than two clip ids', async () => {
    const result = await toolFunctions.concat_videos({ clipIds: ['1'] }, new Uint8Array([1]), setVideoFileData, addMessage, { loadClips: vi.fn() });
    expect(result).toMatch(/^Failed to join videos/);
    expect(setVideoFileData).not.toHaveBeenCalled();
  });

  it('fails when a clip id is unknown', async () => {
    const loadClips = vi.fn(async () => { throw new Error('Clip 9 is not in the project.'); });
    const result = await toolFunctions.concat_videos({ clipIds: ['1', '9'] }, new Uint8Array([1]), setVideoFileData, addMessage, { loadClips });
    expect(result).toMatch(/Clip 9 is not in the project/);
  });
});

describe('clips request field', () => {
  it('normalizes and bounds the clip list', () => {
    expect(validateClips(undefined)).toEqual([]);
    expect(validateClips([{ id: '3', label: 'a\nb' }])).toEqual([{ id: '3', label: 'a b' }]);
    expect(() => validateClips([{ id: 3 }])).toThrow();
    expect(() => validateClips(Array.from({ length: 21 }, (_, i) => ({ id: String(i) })))).toThrow();
  });

  it('describes the clips to the model', () => {
    expect(clipsContextText([{ id: '1', label: 'a.mp4' }, { id: '2', label: 'b.mp4' }])).toContain('1 = "a.mp4", 2 = "b.mp4"');
  });
});
