import { describe, it, expect } from 'vitest';
import { getEngineMode, ENGINE_CLIENT } from '../engineMode.js';

describe('engine mode', () => {
  it('is always the in-browser client (ffmpeg.wasm); there is no flag, override, or rollout', () => {
    expect(getEngineMode()).toBe(ENGINE_CLIENT);
    expect(getEngineMode()).toBe('client');
  });
});
