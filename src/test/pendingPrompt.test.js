import { describe, it, expect } from 'vitest';
import { cleanPrompt, readDeepLink, storePendingPrompt, takePendingPrompt, MAX_PROMPT } from '../pendingPrompt.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

describe('guide-page deep links', () => {
  it('reads prompt and start, ignoring unknown start values', () => {
    expect(readDeepLink('?prompt=Generate%20captions%20for%20this%20video&start=signin')).toEqual({ prompt: 'Generate captions for this video', start: 'signin' });
    expect(readDeepLink('?start=sample')).toEqual({ prompt: '', start: 'sample' });
    expect(readDeepLink('?start=evil&prompt=')).toEqual({ prompt: '', start: null });
  });
  it('strips control characters and caps the length', () => {
    expect(cleanPrompt('a\nb\u0000c   d ')).toBe('a b c d');
    expect(cleanPrompt('x'.repeat(1000))).toHaveLength(MAX_PROMPT);
    expect(cleanPrompt(42)).toBe('');
  });
  it('stores once and is consumed on take', () => {
    const s = memoryStorage();
    storePendingPrompt('Add lyric captions to this video with an English translation', s);
    expect(takePendingPrompt(s)).toBe('Add lyric captions to this video with an English translation');
    expect(takePendingPrompt(s)).toBe('');
    storePendingPrompt('   ', s);
    expect(takePendingPrompt(s)).toBe('');
  });
});
