// The caption drawing of the export that burns captions into the frames: same look as the overlay and the
// agreed style (bold CJK sans, white fill, black outline, shadow, bottom-centre 20% up, 48 px at 720x1280
// scaled). Drawn on a recording stub, so every call is visible.
import { describe, it, expect } from 'vitest';
import { createCaptionDrawer, captionMetrics, captionFont, wrapText, loadCaptionFace, _resetCaptionFaceForTests, CAPTION_FACE, CAPTION_FONT_URL } from '../captionRender.js';
import { DEFAULT_CAPTION_STYLE } from '../captionTrack.js';

function recorder(charWidth = 20) {
  const calls = [];
  const ctx = {
    calls,
    save: () => calls.push(['save']), restore: () => calls.push(['restore']),
    measureText: (s) => ({ width: [...s].length * charWidth }),
    strokeText: (t, x, y) => calls.push(['stroke', t, x, y, ctx.lineWidth, ctx.shadowOffsetX, ctx.shadowColor]),
    fillText: (t, x, y) => calls.push(['fill', t, x, y, ctx.fillStyle, ctx.shadowColor]),
  };
  return ctx;
}
const track = (over = {}, style = {}) => ({
  lines: [{ start: 1, end: 3, text: '你好世界', translation: 'Hello world' }],
  style: { ...DEFAULT_CAPTION_STYLE, ...style }, ...over,
});

describe('metrics and font', () => {
  it('48 px at 720x1280, scaled with the frame height and the track size; outline 3 px, shadow 1 px at 1280', () => {
    expect(captionMetrics(track(), 1280)).toMatchObject({ px: 48, outline: 3, shadow: 1 });
    expect(captionMetrics(track(), 1920)).toMatchObject({ px: 72, outline: 4.5 });
    expect(captionMetrics(track({}, { sizeScale: 1.4 }), 1280).px).toBe(67);
    expect(captionMetrics(track(), 240).px).toBeGreaterThanOrEqual(10);
  });

  it('bold, the overlay family stack, then the bundled subset before the generic fallback', () => {
    const f = captionFont(track(), 48);
    expect(f).toMatch(/^bold 48px "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC"/);
    expect(f).toContain(`"${CAPTION_FACE}", system-ui`);
    expect(captionFont(track({}, { font: 'Inter' }), 48)).toMatch(/^bold 48px Inter, "FinalCap Caption", system-ui/);
  });
});

describe('drawing', () => {
  it('draws nothing outside a line\'s time', () => {
    const ctx = recorder();
    const d = createCaptionDrawer(track(), 720, 1280);
    expect(d.draw(ctx, 0.5)).toBe(false);
    expect(d.draw(ctx, 3)).toBe(false);
    expect(ctx.calls).toEqual([]);
  });

  it('original then translation, centred, each stroked (outline 3 px, shadow) then filled white, bottom edge 20% up', () => {
    const ctx = recorder();
    const d = createCaptionDrawer(track(), 720, 1280);
    expect(d.draw(ctx, 1.5)).toBe(true);
    const strokes = ctx.calls.filter(c => c[0] === 'stroke');
    const fills = ctx.calls.filter(c => c[0] === 'fill');
    expect(strokes.map(c => c[1])).toEqual(['你好世界', 'Hello world']);
    expect(fills.map(c => c[1])).toEqual(['你好世界', 'Hello world']);
    expect(strokes.every(c => c[2] === 360 && c[4] === 6 && c[5] === 1 && c[6] === 'rgba(0,0,0,0.5)')).toBe(true); // lineWidth 6 = 3 px each side
    expect(fills.every(c => c[4] === '#ffffff' && c[5] === 'transparent')).toBe(true);
    // The block's bottom edge is 20% up from the bottom: 1280 * 0.8 = 1024; two lines of 60 px.
    expect(fills.at(-1)[3]).toBe(1024);
    expect(fills[0][3]).toBe(964);
    // Stroke comes before fill for the same line (the fill covers the inner half of the stroke).
    expect(ctx.calls.findIndex(c => c[0] === 'stroke')).toBeLessThan(ctx.calls.findIndex(c => c[0] === 'fill'));
  });

  it('honors position: middle centres the block, top starts at 8%, bottom uses the chosen percentage', () => {
    const run = (style) => {
      const ctx = recorder();
      createCaptionDrawer(track({}, style), 720, 1280).draw(ctx, 2);
      return ctx.calls.filter(c => c[0] === 'fill').map(c => c[3]);
    };
    expect(run({ alignment: 5 })).toEqual([Math.round((1280 - 120) / 2 + 60), Math.round((1280 - 120) / 2 + 120)]);
    expect(run({ alignment: 8 })).toEqual([Math.round(1280 * 0.08 + 60), Math.round(1280 * 0.08 + 120)]);
    expect(run({ positionFromBottomPct: 10 }).at(-1)).toBe(1152);
  });

  it('does not repeat a translation that only repeats the original', () => {
    const ctx = recorder();
    createCaptionDrawer(track({ lines: [{ start: 0, end: 5, text: 'Same', translation: 'same' }] }), 720, 1280).draw(ctx, 1);
    expect(ctx.calls.filter(c => c[0] === 'fill').map(c => c[1])).toEqual(['Same']);
  });

  it('wraps long lines at 90% of the width: between CJK characters, at spaces for Latin', () => {
    const measure = (s) => [...s].length * 20;
    expect(wrapText(measure, '一二三四五六七八九十', 100)).toEqual(['一二三四五', '六七八九十']);
    expect(wrapText(measure, 'aaaa bbbb cccc', 100)).toEqual(['aaaa', 'bbbb', 'cccc']);
    expect(wrapText(measure, 'short', 500)).toEqual(['short']);
    const ctx = recorder(30); // 30 px per character, 648 px wide box
    createCaptionDrawer(track({ lines: [{ start: 0, end: 5, text: '一'.repeat(30), translation: '' }] }), 720, 1280).draw(ctx, 1);
    expect(ctx.calls.filter(c => c[0] === 'fill').map(c => [...c[1]].length)).toEqual([21, 9]);
  });
});

describe('loadCaptionFace', () => {
  it('loads the bundled subset once, adds it to the document fonts, and tolerates failure', async () => {
    _resetCaptionFaceForTests();
    const added = [];
    const made = [];
    class FakeFace { constructor(name, src, desc) { made.push([name, src, desc]); } load() { return Promise.resolve(this); } }
    const fonts = { add: (f) => added.push(f) };
    expect(await loadCaptionFace({ FontFaceCtor: FakeFace, fonts })).toBe(true);
    expect(await loadCaptionFace({ FontFaceCtor: FakeFace, fonts })).toBe(true);
    expect(made).toEqual([[CAPTION_FACE, `url(${CAPTION_FONT_URL})`, { weight: '400' }]]);
    expect(added).toHaveLength(1);

    _resetCaptionFaceForTests();
    class BadFace { load() { return Promise.reject(new Error('offline')); } }
    expect(await loadCaptionFace({ FontFaceCtor: BadFace, fonts })).toBe(false);
    expect(await loadCaptionFace({ FontFaceCtor: undefined, fonts })).toBe(false);
    _resetCaptionFaceForTests();
  });
});
