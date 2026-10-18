// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { keepAwake } from '../wakeLock.js';
import { sameBuild, newBuildAvailable } from '../buildInfo.js';

describe('keepAwake (screen wake lock while captions stream)', () => {
  it('requests the lock, asks again when the tab becomes visible, and releases it', async () => {
    const released = [];
    const request = vi.fn(async () => { const s = { addEventListener: () => {}, release: () => released.push(1) }; return s; });
    const handlers = {};
    const doc = { visibilityState: 'visible', addEventListener: (k, f) => { handlers[k] = f; }, removeEventListener: (k) => { delete handlers[k]; } };
    const events = [];
    const release = keepAwake({ nav: { wakeLock: { request } }, doc, onEvent: (e) => events.push(e) });
    await Promise.resolve(); await Promise.resolve();
    expect(request).toHaveBeenCalledWith('screen');
    expect(events).toContain('acquired');
    release();
    expect(released).toEqual([1]);
    expect(handlers.visibilitychange).toBeUndefined();
  });
  it('is harmless where unsupported or refused', async () => {
    const events = [];
    expect(() => keepAwake({ nav: {}, onEvent: (e) => events.push(e) })()).not.toThrow();
    expect(events).toEqual(['unsupported']);
    const refused = [];
    keepAwake({ nav: { wakeLock: { request: async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); } } }, doc: null, onEvent: (e) => refused.push(e) });
    await Promise.resolve(); await Promise.resolve();
    expect(refused).toEqual(['refused']);
  });
});

describe('build id check', () => {
  it('commits match by prefix either way; unknown never nags', () => {
    expect(sameBuild('abcdef1234567890', 'abcdef1')).toBe(true);
    expect(sameBuild('abcdef1', 'abcdef1234567890')).toBe(true);
    expect(sameBuild('abcdef1', '1234567')).toBe(false);
    expect(sameBuild('', '1234567')).toBe(true);
  });
  it('reports a newer build only when the server commit differs; ignores -dirty, errors and a dev bundle', async () => {
    const health = (commit) => vi.fn(async () => ({ json: async () => ({ ok: true, commit }) }));
    expect(await newBuildAvailable({ fetchImpl: health('1234567'), own: 'abcdef1234567890' })).toBe(true);
    expect(await newBuildAvailable({ fetchImpl: health('abcdef1'), own: 'abcdef1234567890' })).toBe(false);
    expect(await newBuildAvailable({ fetchImpl: health('abcdef1-dirty'), own: 'abcdef1234567890' })).toBe(false);
    expect(await newBuildAvailable({ fetchImpl: health(null), own: 'abcdef1234567890' })).toBe(false);
    expect(await newBuildAvailable({ fetchImpl: vi.fn(async () => { throw new Error('offline'); }), own: 'abcdef1234567890' })).toBe(false);
    const never = vi.fn();
    expect(await newBuildAvailable({ fetchImpl: never, own: 'dev' })).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });
});
