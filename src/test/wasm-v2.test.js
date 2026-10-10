// Unit tests for the /v2 in-browser FFmpeg helpers (pure functions only).
import { describe, it, expect } from 'vitest';
import { buildTrimArgs, TrimArgsError } from '../wasm/ops/trim.js';
import { checkClip, isConstrainedBrowser, DEFAULT_CLIP_LIMITS } from '../wasm/clipLimits.js';

const io = { input: '/in1/a.mp4', output: '/out1/out.mp4' };
const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('buildTrimArgs (parity with server applyTrim)', () => {
  it('stream-copies start..end like /api/process-video', () => {
    expect(buildTrimArgs({ start: 1, end: 3 }, io)).toEqual(
      ['-hide_banner', '-nostdin', '-y', '-ss', '1', '-i', '/in1/a.mp4', '-t', '2', '-c', 'copy', '-movflags', '+faststart', '/out1/out.mp4']);
  });
  it('accepts only start or only end, and HH:MM:SS', () => {
    expect(buildTrimArgs({ start: '00:01:05' }, io)).toContain('65');
    const a = buildTrimArgs({ end: 4.5 }, io);
    expect(a).not.toContain('-ss');
    expect(a.slice(a.indexOf('-t'), a.indexOf('-t') + 2)).toEqual(['-t', '4.5']);
  });
  it('puts -threads after the input so it caps the encoder', () => {
    const a = buildTrimArgs({ start: 0, end: 1, precise: true }, { ...io, threads: 4 });
    expect(a.indexOf('-threads')).toBeGreaterThan(a.indexOf('-i'));
    expect(a).toContain('libx264');
  });
  it('rejects bad ranges', () => {
    expect(() => buildTrimArgs({}, io)).toThrow(TrimArgsError);
    expect(() => buildTrimArgs({ start: 3, end: 1 }, io)).toThrow(/greater/);
    expect(() => buildTrimArgs({ start: -1, end: 1 }, io)).toThrow();
    expect(() => buildTrimArgs({ start: 10, end: 12 }, { ...io, duration: 6 })).toThrow(/past the end/);
    expect(() => buildTrimArgs({ start: 'file:/etc/passwd' }, io)).toThrow();
  });
});

describe('clip limits', () => {
  it('desktop: warn above 1 GB, block above ~1.8 GB', () => {
    expect(checkClip({ bytes: 900 * MB }, { constrained: false }).level).toBe('ok');
    expect(checkClip({ bytes: 1.2 * GB }, { constrained: false }).level).toBe('warn');
    expect(checkClip({ bytes: 1.9 * GB }, { constrained: false }).level).toBe('block');
  });
  it('mobile/Safari: warn above 300 MB, block above 500 MB', () => {
    expect(checkClip({ bytes: 200 * MB }, { constrained: true }).level).toBe('ok');
    expect(checkClip({ bytes: 350 * MB }, { constrained: true }).level).toBe('warn');
    expect(checkClip({ bytes: 501 * MB }, { constrained: true }).level).toBe('block');
  });
  it('warns on >10 min of 1080p', () => {
    expect(checkClip({ bytes: 10 * MB, durationSec: 601, height: 1080 }, { constrained: false }).level).toBe('warn');
    expect(checkClip({ bytes: 10 * MB, durationSec: 601, height: 720 }, { constrained: false }).level).toBe('ok');
  });
  it('limits are overridable (server catalog)', () => {
    const limits = { ...DEFAULT_CLIP_LIMITS, desktop: { warnBytes: 10, blockBytes: 20 } };
    expect(checkClip({ bytes: 30 }, { limits, constrained: false }).level).toBe('block');
  });
  it('detects mobile and Safari', () => {
    expect(isConstrainedBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe(true);
    expect(isConstrainedBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 0)).toBe(true);
    expect(isConstrainedBrowser('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 0)).toBe(false);
  });
});

describe('pickMode', async () => {
  const { pickMode, coreUrls } = await import('../wasm/ffmpegHost.js');
  it('mt only when isolated with SharedArrayBuffer and >1 core', () => {
    expect(pickMode({ isolated: true, sab: true, cores: 8 })).toBe('mt');
    expect(pickMode({ isolated: false, sab: true, cores: 8 })).toBe('st');
    expect(pickMode({ isolated: true, sab: false, cores: 8 })).toBe('st');
    expect(pickMode({ isolated: true, sab: true, cores: 1 })).toBe('st');
  });
  it('?wasm= override cannot force mt without isolation', () => {
    expect(pickMode({ override: 'st', isolated: true, sab: true, cores: 8 })).toBe('st');
    expect(pickMode({ override: 'mt', isolated: false, sab: true, cores: 8 })).toBe('st');
  });
  it('self-hosted versioned core URLs under /v2 (no CDN, no core-st)', () => {
    const mt = coreUrls('mt');
    expect(mt.coreURL).toMatch(/\/v2\/ffmpeg-core\/mt\/0\.12\.10\/ffmpeg-core\.js$/);
    expect(mt.workerURL).toMatch(/ffmpeg-core\.worker\.js$/);
    expect(coreUrls('st').workerURL).toBeUndefined();
    expect(JSON.stringify([mt, coreUrls('st')])).not.toMatch(/jsdelivr|unpkg|core-st/);
  });
});

describe('caption fonts', async () => {
  const { fontCovers, cjkFontFor } = await import('../wasm/ffmpegEngine.js');
  it('Inter covers Latin, Greek, Cyrillic and common punctuation', () => {
    expect(fontCovers('Hello, world! 50% — «Привет» Γεια')).toBe(true);
    expect(fontCovers('')).toBe(true);
  });
  it('CJK text is not covered by Inter', () => {
    expect(fontCovers('你好世界')).toBe(false);
    expect(fontCovers('こんにちは')).toBe(false);
    expect(fontCovers('Hello 你好')).toBe(false);
  });
  it('cjkFontFor picks jp for kana, sc for han', () => {
    expect(cjkFontFor('Hello world')).toBe(null);
    expect(cjkFontFor('你好世界')).toBe('sc');
    expect(cjkFontFor('繁體中文')).toBe('sc');
    expect(cjkFontFor('こんにちは世界')).toBe('jp');
    expect(cjkFontFor('カタカナ')).toBe('jp');
  });
  it('cjkFontFor returns null for scripts with no bundled font (hangul, emoji)', () => {
    expect(cjkFontFor('안녕하세요')).toBe(null);
    expect(cjkFontFor('hello 😀')).toBe(null);
  });
});
