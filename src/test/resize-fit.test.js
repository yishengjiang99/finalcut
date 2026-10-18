import { describe, it, expect } from 'vitest';
import { buildVisualFilter as wasmFilter } from '../wasm/ops/process.js';
import { buildVisualFilter as serverFilter, resizeFilter } from '../server/ffmpegOps.js';
import { webToolsFor, WEB_PROFILE } from '../server/v2.js';

describe('resize_video fit', () => {
  it('pads without stretching in the browser engine', () => {
    expect(wasmFilter('resize_video', { width: 1080, height: 1350, fit: 'pad' }))
      .toBe('scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2,setsar=1');
  });
  it('crops to fill in the browser engine', () => {
    expect(wasmFilter('resize_video', { width: 1080, height: 1920, fit: 'crop' }))
      .toBe('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1');
  });
  it('keeps the plain scale when no fit is given', () => {
    expect(wasmFilter('resize_video', { width: 640, height: -1 })).toBe('scale=640:-2');
    expect(resizeFilter(640, 480)).toBe('scale=640:480');
  });
  it('server filter matches the browser filter', () => {
    expect(serverFilter('resize_video', { width: 1080, height: 1350, fit: 'pad' }, 'video'))
      .toBe(wasmFilter('resize_video', { width: 1080, height: 1350, fit: 'pad' }));
  });
  it('offers the Instagram 4:5 feed preset and a fit option', () => {
    const t = webToolsFor({ mediaType: 'video' }).find(x => x.function.name === 'resize_video_preset').function.parameters.properties;
    expect(t.preset.enum).toContain('4:5');
    expect(t.fit.enum).toEqual(['pad', 'crop']);
    expect(WEB_PROFILE.guidance.join(' ')).toMatch(/Instagram.*4:5/);
  });
});
