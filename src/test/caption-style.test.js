// The caption style a model can choose in chat: schema, validation, clamping, mapping to ASS
// Alignment/MarginV, the defaults (the agreed style), and the question the system prompt asks.
import { describe, it, expect } from 'vitest';
import { tools, systemPrompt } from '../tools.js';
import { offeredToolsFor } from '../server/toolsSchema.js';
import { IOS_TOOL_ALLOWLIST } from '../server/iosToolAllowlist.js';
import {
  resolveCaptionStyle, resolveCaptionStylePatch, CAPTION_FONTS, CAPTION_SIZE_PRESETS, marginVFor, assStyleFor, buildAss, LYRIC_FONT,
} from '../lyricShared.js';

const lc = tools.find(t => t.function.name === 'lyric_captions').function;

describe('lyric_captions style schema', () => {
  it('adds font (whitelist), size and position next to the existing params; target_language stays the only required one', () => {
    const p = lc.parameters.properties;
    expect(lc.parameters.required).toEqual(['target_language']);
    expect(p.font.enum).toEqual(CAPTION_FONTS);
    expect(p.font.default).toBe('Noto Sans CJK SC');
    expect(p.size.enum).toEqual(['small', 'default', 'large', 'xl']);
    expect(p.position.enum).toEqual(['bottom', 'middle', 'top']);
    expect(p.position_from_bottom_pct).toMatchObject({ minimum: 0, maximum: 45, default: 20 });
    expect(Object.keys(p)).toEqual(['target_language', 'source_language', 'mode', 'position_from_bottom_pct', 'font_size', 'font', 'size', 'position']);
  });
});

describe('the system prompt: caption straight away, then offer a change', () => {
  it('has no style question before captioning, passes only a stated style, offers a change after, and re-styles with style_captions', () => {
    expect(systemPrompt).not.toMatch(/Which font and where should the captions go/);
    expect(systemPrompt).not.toMatch(/ask exactly one short question|style question/i);
    expect(systemPrompt).toMatch(/call it straight away\. Never ask about font, size or position before captioning/);
    expect(systemPrompt).toMatch(/already stated a style/);
    expect(systemPrompt).toMatch(/Want a different font or position\?/);
    expect(systemPrompt).toMatch(/call style_captions with only the parts that change/);
    expect(systemPrompt).toMatch(/without transcribing or translating again/);
    expect(systemPrompt).toMatch(/Never call lyric_captions again just to change the look/);
  });
  it('lyric_captions tells the model not to ask first, and to use style_captions for a later change', () => {
    expect(lc.description).toMatch(/Never ask about font, size or position first/);
    expect(lc.description).toMatch(/call style_captions, not this tool again/);
    expect(lc.description).not.toMatch(/ask one short question/);
  });
});

describe('style_captions: the re-style tool', () => {
  const sc = tools.find(t => t.function.name === 'style_captions').function;
  it('has the style params only, none required, same enums as lyric_captions', () => {
    expect(sc.parameters.required).toEqual([]);
    expect(Object.keys(sc.parameters.properties)).toEqual(['font', 'size', 'position', 'position_from_bottom_pct', 'font_size']);
    expect(sc.parameters.properties.font.enum).toEqual(CAPTION_FONTS);
    expect(sc.parameters.properties.size.enum).toEqual(['small', 'default', 'large', 'xl']);
    expect(sc.parameters.properties.position.enum).toEqual(['bottom', 'middle', 'top']);
    expect(sc.description).toMatch(/without transcribing or translating again/);
    expect(sc.description).toMatch(/no new edit is used/);
  });
  it('is web-only: the iOS allowlist never offers it', () => {
    expect(IOS_TOOL_ALLOWLIST.style_captions).toBeUndefined();
    expect(offeredToolsFor({ userAgent: 'FinalCap-iOS/12', mediaType: 'video' }).map(t => t.function.name)).not.toContain('style_captions');
    expect(offeredToolsFor({ userAgent: 'FinalCap-iOS/10', mediaType: 'video' }).map(t => t.function.name)).not.toContain('style_captions');
    expect(offeredToolsFor({ userAgent: 'Mozilla/5.0', mediaType: 'video' }).map(t => t.function.name)).toContain('style_captions');
    expect(offeredToolsFor({ userAgent: 'Mozilla/5.0', mediaType: 'image' }).map(t => t.function.name)).not.toContain('style_captions');
  });
});

describe('resolveCaptionStylePatch: only the named parts change', () => {
  it('maps each named part and leaves the rest out', () => {
    expect(resolveCaptionStylePatch({})).toEqual({ patch: {}, ignored: [] });
    expect(resolveCaptionStylePatch({ size: 'large' }).patch).toEqual({ sizeScale: 1.4 });
    expect(resolveCaptionStylePatch({ position: 'top' }).patch).toEqual({ alignment: 8 });
    expect(resolveCaptionStylePatch({ position_from_bottom_pct: 30 }).patch).toEqual({ positionFromBottomPct: 30 });
    expect(resolveCaptionStylePatch({ font: 'Inter', size: 'small', position: 'middle' }).patch).toEqual({ font: 'Inter', sizeScale: 0.75, alignment: 5 });
    expect(resolveCaptionStylePatch({ font_size: 54 }, { videoHeight: 1280 }).patch).toEqual({ sizeScale: 1.13 });
  });
  it('drops a bad value and names it', () => {
    expect(resolveCaptionStylePatch({ size: 'gigantic', position: 'top' })).toEqual({ patch: { alignment: 8 }, ignored: ['size'] });
    expect(resolveCaptionStylePatch({ font: 'Comic Sans' })).toEqual({ patch: {}, ignored: ['font'] });
    expect(resolveCaptionStylePatch({ position_from_bottom_pct: 99 }).patch).toEqual({ positionFromBottomPct: 45 });
  });
});

describe('resolveCaptionStyle: validate and clamp', () => {
  it('defaults are the agreed style', () => {
    expect(resolveCaptionStyle({}).style).toEqual({ font: LYRIC_FONT, sizeScale: 1, alignment: 2, positionFromBottomPct: 20 });
    expect(resolveCaptionStyle({}).ignored).toEqual([]);
  });
  it('maps size presets and positions (Alignment 2/5/8)', () => {
    for (const [name, scale] of Object.entries(CAPTION_SIZE_PRESETS)) expect(resolveCaptionStyle({ size: name }).style.sizeScale).toBe(scale);
    expect(resolveCaptionStyle({ size: 'Extra Large' }).style.sizeScale).toBe(1.8);
    expect(resolveCaptionStyle({ position: 'bottom' }).style.alignment).toBe(2);
    expect(resolveCaptionStyle({ position: 'middle' }).style.alignment).toBe(5);
    expect(resolveCaptionStyle({ position: 'Center' }).style.alignment).toBe(5);
    expect(resolveCaptionStyle({ position: 'top' }).style.alignment).toBe(8);
  });
  it('font is checked against the whitelist (case-insensitive, "Bold" tolerated); unknown fonts are ignored', () => {
    expect(resolveCaptionStyle({ font: 'inter' }).style.font).toBe('Inter');
    expect(resolveCaptionStyle({ font: 'Noto Sans CJK SC Bold' }).style.font).toBe('Noto Sans CJK SC');
    const bad = resolveCaptionStyle({ font: 'Papyrus' });
    expect(bad.style.font).toBe(LYRIC_FONT);
    expect(bad.ignored).toEqual(['font']);
  });
  it('clamps height to 0-45 % and font_size to 0.5x-2.5x', () => {
    expect(resolveCaptionStyle({ position_from_bottom_pct: -4 }).style.positionFromBottomPct).toBe(0);
    expect(resolveCaptionStyle({ position_from_bottom_pct: 80 }).style.positionFromBottomPct).toBe(45);
    expect(resolveCaptionStyle({ font_size: 4 }, { videoHeight: 1280 }).style.sizeScale).toBe(0.5);
    expect(resolveCaptionStyle({ font_size: 4000 }, { videoHeight: 1280 }).style.sizeScale).toBe(2.5);
    expect(resolveCaptionStyle({ font_size: 96 }, { videoHeight: 1280 }).style.sizeScale).toBe(2);
    expect(resolveCaptionStyle({ font_size: 50 }).ignored).toEqual(['font_size']); // no video height: cannot convert
  });
  it('never throws on junk', () => {
    expect(() => resolveCaptionStyle(null)).not.toThrow();
    expect(() => resolveCaptionStyle({ font: {}, size: [], position: 7, position_from_bottom_pct: 'x' })).not.toThrow();
  });
});

describe('ASS: Alignment and MarginV follow the position', () => {
  it('bottom: Alignment 2, MarginV = N % of the height (20 % of 1280 = 256)', () => {
    expect(assStyleFor({ width: 720, height: 1280 })).toMatchObject({ fontSize: 48, alignment: 2, marginV: 256, marginLR: 48 });
    expect(marginVFor({ height: 1280, alignment: 2, positionFromBottomPct: 30 })).toBe(384);
  });
  it('middle: Alignment 5, MarginV 0. top: Alignment 8, MarginV 8 % of the height', () => {
    expect(assStyleFor({ width: 720, height: 1280, alignment: 5 })).toMatchObject({ alignment: 5, marginV: 0 });
    expect(assStyleFor({ width: 720, height: 1280, alignment: 8 })).toMatchObject({ alignment: 8, marginV: 102 });
  });
  it('the Style line carries the alignment', () => {
    const ass = buildAss({ lines: [{ start: 0, end: 1, text: 'a', translation: 'b' }], width: 720, height: 1280, alignment: 8 });
    expect(ass).toMatch(/Style: Default,Noto Sans CJK SC,48,.*,1,3,1,8,48,48,102,1\n/);
    expect(buildAss({ lines: [], width: 720, height: 1280 })).toMatch(/,1,3,1,2,48,48,256,1\n/);
  });
});
