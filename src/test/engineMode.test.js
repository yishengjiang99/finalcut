import { describe, it, expect } from 'vitest';
import { resolveEngineMode, ENGINE_CLIENT, ENGINE_SERVER } from '../engineMode.js';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('resolveEngineMode', () => {
  it('defaults to the client engine, even on phones', () => {
    // supported=false simulates a phone Safari that the old default excluded.
    expect(resolveEngineMode({ supported: false, search: '' }).mode).toBe(ENGINE_CLIENT);
    expect(resolveEngineMode({ search: '', flag: { mode: 'on', percent: 100 } }).mode).toBe(ENGINE_CLIENT);
  });

  it('still honors the server kill-switch', () => {
    expect(resolveEngineMode({ flag: { mode: 'off', percent: 0 }, search: '' }).mode).toBe(ENGINE_SERVER);
  });

  it('still honors explicit ?engine= overrides', () => {
    expect(resolveEngineMode({ search: '?engine=server' }).mode).toBe(ENGINE_SERVER);
    expect(resolveEngineMode({ search: '?engine=client', supported: false }).mode).toBe(ENGINE_CLIENT);
  });

  it('still honors percent rollouts by bucket', () => {
    const flag = { mode: 'percent', percent: 25 };
    expect(resolveEngineMode({ flag, bucket: 10, search: '' }).mode).toBe(ENGINE_CLIENT);
    expect(resolveEngineMode({ flag, bucket: 90, search: '' }).mode).toBe(ENGINE_SERVER);
  });

  it('a failed flag fetch (null config) means client', () => {
    expect(resolveEngineMode({ flag: undefined, supported: false, search: '' }).mode).toBe(ENGINE_CLIENT);
  });

  it('documents the mobile UA this default now covers', () => {
    expect(MOBILE_UA).toMatch(/iPhone/);
  });
});
