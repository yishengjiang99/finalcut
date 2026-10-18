// The caption track: overlay timing, style clamping, SRT/ASS, what edits do to it, and reload persistence.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setTrack, getTrack, updateTrackStyle, clearTrack, activeLine, overlayFontPx, normalizeStyle, trackToSrt, trackToAss,
  carryTrackOnEdit, parseClock, shiftLines, restoreTrack, videoKey, persistTrack, CAPTIONS_CLEARED_NOTICE,
} from '../captionTrack.js';
import { recordCaptionBurn } from '../captionLineage.js';

const lines = [
  { start: 1, end: 3, text: 'Hello there', translation: '你好' },
  { start: 4, end: 6, text: 'Same', translation: 'Same' },
  { start: 10, end: 12, text: 'Later', translation: 'Plus tard' },
];
const makeStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
beforeEach(() => { globalThis.localStorage = makeStorage(); });

describe('overlay', () => {
  it('shows the active line, timed from the lines, and nothing between them', () => {
    const t = setTrack(new Uint8Array([1]), { lines });
    expect(activeLine(t, 0.5)).toBeNull();
    expect(activeLine(t, 1)).toEqual({ text: 'Hello there', translation: '你好' });
    expect(activeLine(t, 2.99)).toEqual({ text: 'Hello there', translation: '你好' });
    expect(activeLine(t, 3)).toBeNull();
    expect(activeLine(t, 5)).toEqual({ text: 'Same', translation: '' }); // a translation that repeats the original is not drawn twice
  });

  it('style changes are clamped and drive the overlay size and the export', () => {
    expect(normalizeStyle({ positionFromBottomPct: 99, sizeScale: 9 })).toMatchObject({ positionFromBottomPct: 45, sizeScale: 2.5 });
    expect(normalizeStyle({ positionFromBottomPct: -5, sizeScale: 0.1 })).toMatchObject({ positionFromBottomPct: 0, sizeScale: 0.5 });
    expect(normalizeStyle({})).toMatchObject({ positionFromBottomPct: 20, sizeScale: 1 });
    const bytes = new Uint8Array([2]);
    setTrack(bytes, { lines });
    const before = overlayFontPx(getTrack(bytes), 1000);
    updateTrackStyle(bytes, { sizeScale: 1.8, positionFromBottomPct: 35 });
    expect(overlayFontPx(getTrack(bytes), 1000)).toBeGreaterThan(before);
    const ass = trackToAss(getTrack(bytes), { width: 1080, height: 1920 });
    expect(ass).toMatch(/,672,1\n/); // MarginV: 35% of 1920
    expect(ass).toMatch(/Style: Default,[^,]+,130,/); // 1920 × 48/1280 × 1.8 = 129.6
    expect(trackToAss(getTrack(bytes), { width: 1080, height: 1920 })).toContain('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello there\\N你好');
  });

  it('writes SRT with both lines and skips a duplicate translation', () => {
    const srt = trackToSrt(setTrack(new Uint8Array([3]), { lines }));
    expect(srt).toContain('1\n00:00:01,000 --> 00:00:03,000\nHello there\n你好\n');
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:06,000\nSame\n');
    expect(srt).not.toContain('Same\nSame');
  });
});

describe('edits after captioning (safe behavior: follow, shift exactly, or clear with a notice)', () => {
  it('timeline-preserving edits carry the captions and the style to the new clip', () => {
    const a = new Uint8Array([1]); const b = new Uint8Array([2]);
    setTrack(a, { lines, style: { positionFromBottomPct: 33 } });
    expect(carryTrackOnEdit(a, b, 'resize_video', {})).toBe('kept');
    expect(getTrack(b).lines).toHaveLength(3);
    expect(getTrack(b).style.positionFromBottomPct).toBe(33);
    expect(getTrack(a)).not.toBeNull(); // the earlier clip keeps its captions (Undo)
  });

  it('a trim shifts the captions exactly and drops lines outside the kept part', () => {
    const a = new Uint8Array([1]); const b = new Uint8Array([2]);
    setTrack(a, { lines });
    expect(carryTrackOnEdit(a, b, 'trim_video', { start: '2', end: '00:00:11' })).toBe('shifted');
    expect(getTrack(b).lines.map(l => [l.start, l.end, l.text])).toEqual([[0, 1, 'Hello there'], [2, 4, 'Same'], [8, 9, 'Later']]);
    expect(shiftLines(lines, 7, 2)).toEqual([]);
    expect(parseClock('1:30')).toBe(90);
    expect(parseClock('00:00:01.5')).toBe(1.5);
    expect(parseClock('abc')).toBeNull();
  });

  it('edits that change timing (speed, silence removal, transitions) or an unparsable trim clear the overlay', () => {
    for (const [tool, args] of [['adjust_speed', { speed: 2 }], ['audio_silence_remove', {}], ['add_video_transition', {}], ['trim_video', { start: 'x', end: 'y' }], ['run_ffmpeg', {}]]) {
      const a = new Uint8Array([1]); const b = new Uint8Array([2]);
      setTrack(a, { lines });
      expect(carryTrackOnEdit(a, b, tool, args)).toBe('cleared');
      expect(getTrack(b)).toBeNull();
    }
    expect(CAPTIONS_CLEARED_NOTICE).toMatch(/timing/);
  });

  it('no track: nothing happens; a burn output never gets an overlay', () => {
    const a = new Uint8Array([1]); const b = new Uint8Array([2]);
    expect(carryTrackOnEdit(a, b, 'resize_video', {})).toBe('none');
    setTrack(a, { lines });
    recordCaptionBurn(a, b);
    expect(carryTrackOnEdit(a, b, 'resize_video', {})).toBe('cleared');
    expect(getTrack(b)).toBeNull();
  });
});

describe('surviving a reload (text only)', () => {
  it('restores the captions and the style for the same video bytes, not for another video', () => {
    const video = new Uint8Array(200000).map((_, i) => (i * 7) % 251);
    setTrack(video, { lines, language: 'en', targetLanguage: 'zh-Hans', style: { positionFromBottomPct: 12, sizeScale: 1.4 } });
    expect(JSON.parse(localStorage.getItem('fc.captions.v1'))[0]).not.toHaveProperty('bytes');
    const reloaded = new Uint8Array(video); // the same file, a new tab
    const t = restoreTrack(reloaded);
    expect(t.lines).toHaveLength(3);
    expect(t.style).toMatchObject({ positionFromBottomPct: 12, sizeScale: 1.4 });
    expect(t.targetLanguage).toBe('zh-Hans');
    const other = new Uint8Array(200000).map((_, i) => (i * 11) % 251);
    expect(restoreTrack(other)).toBeNull();
  });

  it('a style change is saved too, removal forgets it, and the store stays small', () => {
    const v = new Uint8Array([5, 6, 7]);
    setTrack(v, { lines });
    updateTrackStyle(v, { positionFromBottomPct: 40 });
    expect(restoreTrack(new Uint8Array([5, 6, 7])).style.positionFromBottomPct).toBe(40);
    clearTrack(v);
    expect(restoreTrack(new Uint8Array([5, 6, 7]))).toBeNull();
    for (let i = 0; i < 12; i += 1) persistTrack(new Uint8Array([i, 1, 2, 3]), { lines, style: normalizeStyle() });
    expect(JSON.parse(localStorage.getItem('fc.captions.v1')).length).toBeLessThanOrEqual(8);
    expect(videoKey(new Uint8Array([1, 2, 3]))).toBe(videoKey(new Uint8Array([1, 2, 3])));
    expect(videoKey(new Uint8Array(0))).toBeNull();
  });

  it('never throws without storage (private mode)', () => {
    globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    const v = new Uint8Array([9, 9]);
    expect(() => setTrack(v, { lines })).not.toThrow();
    expect(restoreTrack(new Uint8Array([9, 9, 1]))).toBeNull();
  });
});
