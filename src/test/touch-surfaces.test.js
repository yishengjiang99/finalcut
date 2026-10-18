// iPhone Safari: a long press on the video preview, the clip rail or the caption overlay selected them like
// text. These surfaces opt out of selection and the long-press callout; text surfaces must not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/App.css', 'utf8');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] }));
const noSelect = rules.filter(r => /-webkit-user-select:\s*none/.test(r.body) && /(^|[^-])user-select:\s*none/.test(r.body) && /-webkit-touch-callout:\s*none/.test(r.body));
const selectors = noSelect.flatMap(r => r.sel.split(',').map(s => s.trim()));

describe('touch surfaces do not select on long press', () => {
  it.each(['.vp', '.vp *', '.rc-media *', '.clip *', '.thumb *', '.cap-overlay', '.cap-overlay *', '.media-x'])('%s opts out', (sel) => {
    expect(selectors).toContain(sel);
  });

  it('no rule that disables selection touches chat messages, the composer, inputs or textareas', () => {
    const all = rules.filter(r => /user-select:\s*none/.test(r.body)).map(r => r.sel).join(',');
    expect(all).not.toMatch(/\.msg\b|\.chat\b|\.composer|textarea|input(?!\[type="range"\])|\.bubble|\.md\b/);
    expect(all).not.toMatch(/(^|,)\s*(\*|body|html|#root)\s*(,|$)/);
  });

  it('the preview roots carry the class', () => {
    const src = readFileSync('src/VideoPreview.jsx', 'utf8');
    expect(src.match(/className="vp"/g)).toHaveLength(3);
  });

  it('tap highlight is cleared on the preview and the rail', () => {
    expect(css).toMatch(/\.vp[^{]*\{[^}]*-webkit-tap-highlight-color:\s*transparent/);
  });
});
