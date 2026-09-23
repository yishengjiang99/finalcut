import { describe, expect, it } from 'vitest';
import { assertToolCallApplied } from '../useCallAPI.js';

describe('assertToolCallApplied', () => {
  it('accepts a successful tool result', () => {
    expect(assertToolCallApplied('Audio volume adjusted successfully.', 'adjust_volume'))
      .toBe('Audio volume adjusted successfully.');
  });

  it('rejects a failed tool result', () => {
    expect(() => assertToolCallApplied('Failed to adjust volume: FFmpeg error', 'adjust_volume'))
      .toThrow('adjust_volume');
  });

  it('rejects a missing tool result', () => {
    expect(() => assertToolCallApplied('', 'adjust_brightness'))
      .toThrow('no result returned');
  });
});
