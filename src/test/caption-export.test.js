// The export decision: burn the captions into the frames with WebCodecs where it works; otherwise the soft
// caption track plus an SRT, or the SRT alone, with one line saying so. Never a server step.
import { describe, it, expect, vi } from 'vitest';
import { exportCaptionedVideo, EXPORT_NOTICES, CONSTRAINED_MAX_LONG_EDGE } from '../captionExport.js';
import { webCodecsAvailable, outputSize, burnCaptionsWebCodecs } from '../captionBurn.js';

const track = { lines: [{ start: 0, end: 2, text: '你好', translation: 'Hello' }], style: { alignment: 2, positionFromBottomPct: 20, sizeScale: 1, font: 'Noto Sans CJK SC' } };
const bytes = new Uint8Array([1, 2, 3]);
const err = (code) => Object.assign(new Error(code), { code });
const deps = (over = {}) => ({
  burn: vi.fn(async () => ({ bytes: new Uint8Array([9]), mime: 'video/mp4' })),
  mux: vi.fn(async () => ({ bytes: new Uint8Array([8]), mime: 'video/mp4' })),
  webCodecs: () => true,
  ...over,
});
const clogOf = () => { const events = []; return { events, log: (ev, data) => events.push({ ev, ...data }) }; };

describe('exportCaptionedVideo', () => {
  it('burns in the browser and stops there: no soft track, no SRT', async () => {
    const d = deps();
    const out = await exportCaptionedVideo({ bytes, track, deps: d });
    expect(out).toMatchObject({ kind: 'burned', ext: 'mp4', mime: 'video/mp4', notice: EXPORT_NOTICES.burned });
    expect(out.srt).toBeUndefined();
    expect(d.burn).toHaveBeenCalledTimes(1);
    expect(d.mux).not.toHaveBeenCalled();
  });

  it('phones shrink the picture to 1920 on the long edge; desktops do not', async () => {
    const a = deps(); await exportCaptionedVideo({ bytes, track, constrained: true, deps: a });
    expect(a.burn.mock.calls[0][0].maxLongEdge).toBe(CONSTRAINED_MAX_LONG_EDGE);
    const b = deps(); await exportCaptionedVideo({ bytes, track, constrained: false, deps: b });
    expect(b.burn.mock.calls[0][0].maxLongEdge).toBe(0);
  });

  it('a burn failure falls back to the soft track plus an SRT (one notice), still all local', async () => {
    const clog = clogOf();
    const d = deps({ burn: vi.fn(async () => { throw err('burn_failed'); }) });
    const out = await exportCaptionedVideo({ bytes, track, clog, deps: d });
    expect(out).toMatchObject({ kind: 'soft_track', ext: 'mp4', burnError: 'burn_failed', notice: EXPORT_NOTICES.soft_track });
    expect(out.srt).toContain('你好\nHello');
    expect(clog.events.map(e => e.ev)).toContain('export_fallback');
  });

  it('no WebCodecs: straight to the soft track plus SRT; the burn is never tried', async () => {
    const d = deps({ webCodecs: () => false });
    const out = await exportCaptionedVideo({ bytes, track, deps: d });
    expect(out).toMatchObject({ kind: 'soft_track', burnError: 'webcodecs_unsupported' });
    expect(d.burn).not.toHaveBeenCalled();
  });

  it('a QuickTime source keeps its .mov in the soft-track fallback', async () => {
    const d = deps({ webCodecs: () => false, mux: vi.fn(async () => ({ bytes: new Uint8Array([8]), mime: 'video/quicktime' })) });
    expect((await exportCaptionedVideo({ bytes, mime: 'video/quicktime', track, deps: d })).ext).toBe('mov');
  });

  it('neither works: the SRT alone, with the reason in the notice', async () => {
    const unsupported = deps({ webCodecs: () => false, mux: vi.fn(async () => { throw err('soft_track_unsupported'); }) });
    expect(await exportCaptionedVideo({ bytes, track, deps: unsupported })).toMatchObject({ kind: 'srt', notice: EXPORT_NOTICES.srt_unsupported });
    const failed = deps({ webCodecs: () => false, mux: vi.fn(async () => { throw err('wasm_crashed'); }) });
    const out = await exportCaptionedVideo({ bytes, track, deps: failed });
    expect(out).toMatchObject({ kind: 'srt', notice: EXPORT_NOTICES.srt });
    expect(out.bytes).toBeUndefined();
  });

  it('cancelling stops everything: no fallback runs', async () => {
    const d = deps({ burn: vi.fn(async () => { throw err('cancelled'); }) });
    await expect(exportCaptionedVideo({ bytes, track, deps: d })).rejects.toMatchObject({ code: 'cancelled' });
    expect(d.mux).not.toHaveBeenCalled();
  });

  it('never logs caption text', async () => {
    const clog = clogOf();
    await exportCaptionedVideo({ bytes, track, clog, deps: deps({ burn: vi.fn(async () => { throw err('burn_failed'); }) }) });
    expect(JSON.stringify(clog.events)).not.toMatch(/你好|Hello/);
  });
});

describe('captionBurn helpers', () => {
  it('webCodecsAvailable needs the decoder, the encoder, VideoFrame and a document', () => {
    const full = { VideoDecoder() {}, VideoEncoder() {}, VideoFrame() {}, document: { createElement() {} } };
    expect(webCodecsAvailable(full)).toBe(true);
    expect(webCodecsAvailable({ ...full, VideoEncoder: undefined })).toBe(false);
    expect(webCodecsAvailable({ ...full, document: undefined })).toBe(false);
    expect(webCodecsAvailable({})).toBe(false);
  });

  it('outputSize keeps the picture unless a long-edge cap applies, and stays even', () => {
    expect(outputSize(1080, 1920, 0)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(2160, 3840, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(3840, 2160, 1920)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(1281, 721, 0)).toEqual({ width: 1282, height: 722 });
    expect(outputSize(1280, 720, 1920)).toEqual({ width: 1280, height: 720 });
  });

  it('without WebCodecs the burn refuses with webcodecs_unsupported before touching anything', async () => {
    await expect(burnCaptionsWebCodecs({ bytes, track })).rejects.toMatchObject({ code: 'webcodecs_unsupported' });
  });
});

it('the web export no longer imports an ffmpeg.wasm burn', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync('src/App.jsx', 'utf8');
  const exportSrc = readFileSync('src/captionExport.js', 'utf8');
  expect(`${app}\n${exportSrc}`).not.toMatch(/burnSubtitles|burnAss|burnCaptionTrack/);
  expect(app).toMatch(/burnCaptionsWebCodecs/);
});
