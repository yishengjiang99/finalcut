import { describe, it, expect } from 'vitest';
import {
  normalizeLanguageCode,
  stripLlmFences,
  parseSrtCues,
  mergeTranslatedSrt,
  srtHasSpeech,
} from '../server/captionHelpers.js';

describe('normalizeLanguageCode', () => {
  it('accepts auto and ISO codes', () => {
    expect(normalizeLanguageCode('auto')).toBe('auto');
    expect(normalizeLanguageCode('en')).toBe('en');
    expect(normalizeLanguageCode('en-US')).toBe('en');
  });

  it('maps common language names', () => {
    expect(normalizeLanguageCode('Spanish')).toBe('es');
    expect(normalizeLanguageCode('Chinese')).toBe('zh');
    expect(normalizeLanguageCode('English', { allowAuto: false })).toBe('en');
  });

  it('rejects garbage', () => {
    expect(normalizeLanguageCode('!!!')).toBeNull();
    expect(normalizeLanguageCode('auto', { allowAuto: false })).toBeNull();
  });
});

describe('SRT merge / fences', () => {
  const original = `1
00:00:00,000 --> 00:00:01,000
Hello

2
00:00:01,000 --> 00:00:02,000
World`;

  it('strips markdown fences', () => {
    expect(stripLlmFences('```srt\n' + original + '\n```')).toContain('Hello');
  });

  it('keeps original timestamps when model mangles them', () => {
    const mangled = `1
00:00:99,000 --> 00:00:99,500
Hola

2
00:00:99,500 --> 00:00:99,900
Mundo`;
    const merged = mergeTranslatedSrt(original, mangled);
    expect(merged).toContain('00:00:00,000 --> 00:00:01,000');
    expect(merged).toContain('Hola');
    expect(merged).toContain('Mundo');
    expect(merged).not.toContain('00:00:99');
  });

  it('parses cues', () => {
    expect(parseSrtCues(original)).toHaveLength(2);
  });

  it('detects speech', () => {
    expect(srtHasSpeech(original)).toBe(true);
    expect(srtHasSpeech('')).toBe(false);
  });
});
