// Export on phones uses the share sheet; everything else downloads. Capability branching and logging.
import { describe, it, expect, vi } from 'vitest';
import { makeShareFile, canShareFile, shareOrDownload, isMobileDevice } from '../shareFile.js';

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Safari', platform: 'iPhone', maxTouchPoints: 5 };
const DESKTOP = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130', platform: 'MacIntel', maxTouchPoints: 0 };
const file = () => makeShareFile(new Uint8Array([1, 2, 3]), 'finalcap-clip.mp4', 'video/mp4');
const nav = (base, share, canShare = () => true) => ({ ...base, share, canShare });

describe('makeShareFile', () => {
  it('builds a File with the right type and name (mime from the extension when none is given)', () => {
    const f = file();
    expect(f).toBeInstanceOf(File);
    expect(f.name).toBe('finalcap-clip.mp4');
    expect(f.type).toBe('video/mp4');
    expect(f.size).toBe(3);
    expect(makeShareFile(new Uint8Array([1]), 'a.mov').type).toBe('video/quicktime');
    expect(makeShareFile(new Uint8Array([1]), 'a.mp4', 'video/mp4; codecs=avc1').type).toBe('video/mp4');
  });
});

describe('capability branching', () => {
  it('phones with share + canShare({files}) share; desktop keeps downloading; missing APIs download', () => {
    expect(isMobileDevice(IPHONE)).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile' })).toBe(true);
    expect(isMobileDevice({ ...DESKTOP, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true); // iPadOS reports a Mac
    expect(canShareFile(file(), nav(IPHONE, vi.fn()))).toBe(true);
    expect(canShareFile(file(), nav(DESKTOP, vi.fn()))).toBe(false); // desktop unchanged
    expect(canShareFile(file(), { ...IPHONE, share: vi.fn() })).toBe(false); // no canShare
    expect(canShareFile(file(), { ...IPHONE, canShare: () => true })).toBe(false); // no share
    expect(canShareFile(file(), nav(IPHONE, vi.fn(), () => false))).toBe(false); // refuses these files
    expect(canShareFile(file(), nav(IPHONE, vi.fn(), () => { throw new Error('x'); }))).toBe(false);
    expect(canShareFile(null, nav(IPHONE, vi.fn()))).toBe(false);
  });

  it('asks canShare with the file and shares exactly that file', async () => {
    const share = vi.fn(async () => {});
    const canShare = vi.fn(() => true);
    const f = file();
    const log = vi.fn();
    const out = await shareOrDownload(f, { nav: { ...IPHONE, share, canShare }, download: vi.fn(), log, kind: 'export' });
    expect(out).toBe('shared');
    expect(canShare).toHaveBeenCalledWith({ files: [f] });
    expect(share).toHaveBeenCalledWith({ files: [f] });
    expect(log).toHaveBeenCalledWith('share_ok', { kind: 'export', bytes: 3, type: 'video/mp4' });
  });

  it('navigator.share is called synchronously (inside the tap), before any await', () => {
    let called = false;
    const share = vi.fn(() => { called = true; return Promise.resolve(); });
    shareOrDownload(file(), { nav: nav(IPHONE, share), download: vi.fn() });
    expect(called).toBe(true); // no await happened before the call
  });
});

describe('outcomes', () => {
  it('desktop or unsupported: downloads, never calls share', async () => {
    const share = vi.fn();
    const download = vi.fn();
    expect(await shareOrDownload(file(), { nav: nav(DESKTOP, share), download })).toBe('downloaded');
    expect(share).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('cancelling the sheet (AbortError) is not an error: nothing downloads, a share_cancel event is logged', async () => {
    const download = vi.fn();
    const log = vi.fn();
    const share = vi.fn(async () => { throw Object.assign(new Error('Share canceled'), { name: 'AbortError' }); });
    expect(await shareOrDownload(file(), { nav: nav(IPHONE, share), download, log })).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('share_cancel', { kind: 'file' });
    expect(log).not.toHaveBeenCalledWith('share_fail', expect.anything());
  });

  it('an expired activation (NotAllowedError) asks the caller for a fresh tap instead of failing', async () => {
    const download = vi.fn();
    const log = vi.fn();
    const share = vi.fn(async () => { throw Object.assign(new Error('Must be handling a user gesture'), { name: 'NotAllowedError' }); });
    expect(await shareOrDownload(file(), { nav: nav(IPHONE, share), download, log })).toBe('needsTap');
    expect(download).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('share_fail', expect.objectContaining({ name: 'NotAllowedError' }));
  });

  it('any other failure logs share_fail (no file content, ASCII message) and falls back to the download', async () => {
    const download = vi.fn();
    const log = vi.fn();
    const share = vi.fn(async () => { throw Object.assign(new Error('Data error 数据'), { name: 'DataError' }); });
    expect(await shareOrDownload(file(), { nav: nav(IPHONE, share), download, log, kind: 'export_burned' })).toBe('downloaded');
    expect(download).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('share_fail', { kind: 'export_burned', name: 'DataError', msg: 'Data error ', bytes: 3 });
  });
});
