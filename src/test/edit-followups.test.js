// Server-side edit fixes. The browser/wasm engine is being replaced, so its parity is deferred.
import { describe, it, expect } from 'vitest';
import { buildVisualFilter, buildEditsFilter, resizeFilter, applyOperation } from '../server/ffmpegOps.js';

const v = (op, args) => buildVisualFilter(op, args, 'video');
const filtersOf = (op, args) => {
  const seen = [];
  applyOperation({ videoFilters(f) { seen.push(f); return this; }, audioCodec() { return this; } }, op, args);
  return seen;
};

describe('server rotate_video (video) never clips corners', () => {
  it.each([[90, 'transpose=clock'], [-270, 'transpose=clock'], [180, 'hflip,vflip'], [270, 'transpose=cclock'], [-90, 'transpose=cclock'], [0, 'null']])(
    'quarter turn %s -> %s', (angle, f) => { expect(v('rotate_video', { angle })).toBe(f); });
  it('arbitrary angles expand to the even rotated bounding box', () => {
    expect(v('rotate_video', { angle: 45 }))
      .toBe("rotate=45*PI/180:ow='trunc(rotw(45*PI/180)/2)*2':oh='trunc(roth(45*PI/180)/2)*2':c=black");
  });
  it('applyOperation and apply_edits use the same filter', () => {
    expect(filtersOf('rotate_video', { angle: 90 })).toEqual(['transpose=clock']);
    expect(buildEditsFilter([{ op: 'rotate_video', angle: 90 }, { op: 'flip_video_horizontal' }], 'video')).toBe('transpose=clock,hflip');
  });
});

describe('server sizes are even for video', () => {
  it('pad / crop / plain resize round odd sizes down', () => {
    expect(v('resize_video', { width: 1081, height: 1351, fit: 'pad' }))
      .toBe('scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2,setsar=1');
    expect(v('resize_video', { width: 1081, height: 1351, fit: 'crop' }))
      .toBe('scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350,setsar=1');
    expect(v('resize_video', { width: 641, height: 481 })).toBe('scale=640:480');
    expect(v('resize_video', { width: 641, height: -1 })).toBe('scale=640:-2');
    expect(filtersOf('resize_video', { width: 1081, height: 1351, fit: 'pad' })[0]).toContain('pad=1080:1350');
  });
  it('photos keep the exact size', () => {
    expect(buildVisualFilter('resize_video', { width: 1081, height: 1351, fit: 'pad' }, 'image')).toContain('pad=1081:1351');
    expect(resizeFilter(1081, 1351, 'pad', { even: false })).toContain('pad=1081:1351');
  });
  it('video crop is evened; photo crop is exact', () => {
    expect(v('crop_video', { width: 721, height: 721, x: 0, y: 0 })).toBe('crop=721:721:0:0,scale=trunc(iw/2)*2:trunc(ih/2)*2');
    expect(buildVisualFilter('crop_video', { width: 721, height: 721, x: 0, y: 0 }, 'image')).toBe('crop=721:721:0:0');
    expect(filtersOf('crop_video', { width: 721, height: 721, x: 0, y: 0 })).toEqual(['crop=721:721:0:0,scale=trunc(iw/2)*2:trunc(ih/2)*2']);
  });
});

describe('server apply_edits ordering', () => {
  it('color ops first (own order), then geometry (own order), so pad bars stay black', () => {
    const f = buildEditsFilter([
      { op: 'resize_video', preset: '1:1' }, { op: 'rotate_video', angle: 90 },
      { op: 'apply_color_filter', filter: 'invert' }, { op: 'adjust_saturation', saturation: 1.2 },
    ], 'video');
    expect(f.startsWith('negate,eq=saturation=1.2,scale=1080:1080')).toBe(true);
    expect(f.endsWith('setsar=1,transpose=clock')).toBe(true);
  });
});
