import { describe, it, expect } from 'vitest';
import { fontCovers } from '../wasm/ffmpegEngine.js';
import { cleanPrompt } from '../pendingPrompt.js';

// The character classes are written without raw control-character ranges; check every BMP code
// point (and one astral one) against the ranges they replaced.
const FONT_RANGES = [[0x0000, 0x052f], [0x1e00, 0x1eff], [0x2000, 0x206f], [0x20a0, 0x20bf], [0x2100, 0x214f], [0x2190, 0x21ff], [0x2200, 0x22ff]];
const inFont = (cp) => FONT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
const isPromptControl = (cp) => cp <= 0x1f || cp === 0x7f;
const codePoints = () => {
  const out = [];
  for (let cp = 0; cp <= 0xffff; cp++) if (cp < 0xd800 || cp > 0xdfff) out.push(cp);
  out.push(0x1f600);
  return out;
};

describe('control-character ranges', () => {
  it('fontCovers matches the bundled font ranges exactly', () => {
    const wrong = codePoints().filter((cp) => fontCovers(String.fromCodePoint(cp)) !== inFont(cp));
    expect(wrong).toEqual([]);
  });

  it('cleanPrompt strips exactly U+0000-U+001F and U+007F', () => {
    const wrong = codePoints().filter((cp) => {
      const out = cleanPrompt(`a${String.fromCodePoint(cp)}b`);
      const stripped = out === 'a b' || out === 'a  b';
      return isPromptControl(cp) ? !stripped : /\s/.test(String.fromCodePoint(cp)) ? false : out !== `a${String.fromCodePoint(cp)}b`;
    });
    expect(wrong).toEqual([]);
  });
});
