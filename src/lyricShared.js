// Pure caption helpers shared by the server (lyric_captions, burn) and the browser (streaming
// captions): line building from word timestamps, and the ASS script (one two-line Dialogue per caption).
import { normalizeCaptionText } from './server/captionHelpers.js';

export const DEFAULT_POSITION_FROM_BOTTOM_PCT = 20;

export const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
export const isCjkText = (s) => CJK_RE.test(String(s || ''));
export const SENTENCE_END_RE = /[.!?。！？…]$/;
export const CLAUSE_END_RE = /[.!?。！？…,;:，；：、]$/;

export function joinWords(words) {
  let out = '';
  for (const w of words) {
    const t = String(w.w ?? '').trim();
    if (!t) continue;
    if (out && !(isCjkText(out.slice(-1)) && isCjkText(t[0])) && !/^[,.!?;:，。！？、；：)]/.test(t)) out += ' ';
    out += t;
  }
  return out;
}

/**
 * Turn a transcription ({ segments:[{start,end,text}], words:[{w,start,end}] }) into caption
 * lines timed from their first/last word. Long segments split at word boundaries (max ~42 Latin or
 * ~18 CJK characters) and at pauses over 1.2 s, so each event fits on screen as one line.
 */
export function buildLines({ segments = [], words = [] } = {}, { maxChars, maxGap = 1.2 } = {}) {
  // A segment that repeats the previous one's text while overlapping it in time is a transcriber
  // duplicate; drop it. Back-to-back repeats (a chorus line sung twice) are real and stay.
  const segs = [];
  for (const s of segments) {
    const text = String(s.text || '').trim();
    if (!text) continue;
    const prev = segs[segs.length - 1];
    if (prev && sameText(prev.text, text) && s.start < prev.end - 0.05) {
      prev.end = Math.max(prev.end, s.end);
      continue;
    }
    segs.push({ ...s, text, words: [] });
  }
  const ws = words
    .filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && String(w.w ?? '').trim())
    .filter((w, i, arr) => !(i > 0 && arr[i - 1].start === w.start && arr[i - 1].end === w.end && arr[i - 1].w === w.w));
  if (!segs.length && ws.length) segs.push({ start: ws[0].start, end: ws[ws.length - 1].end, text: joinWords(ws), words: [] });
  for (const w of ws) {
    const mid = (w.start + w.end) / 2;
    let best = segs[0];
    let bestDist = Infinity;
    for (const s of segs) {
      const d = mid < s.start ? s.start - mid : mid > s.end ? mid - s.end : 0;
      if (d < bestDist) { best = s; bestDist = d; }
    }
    best?.words.push(w);
  }
  const lines = [];
  for (const s of segs) {
    const limit = maxChars ?? (isCjkText(s.text) ? 18 : 42);
    if (!s.words.length) {
      lines.push({ start: s.start, end: s.end, text: s.text, words: [] });
      continue;
    }
    // Break at pauses, after sentence ends, and before the line gets too long — preferring the
    // last comma/clause break in the line over a cut mid-phrase.
    const groups = [];
    let cur = [];
    const minSentence = Math.round(limit * 0.3);
    for (const w of s.words) {
      const prev = cur[cur.length - 1];
      if (prev && w.start - prev.end > maxGap) {
        groups.push(cur);
        cur = [];
      } else if (prev && joinWords([...cur, w]).length > limit) {
        let k = -1;
        for (let j = cur.length - 2; j >= 0; j--) if (CLAUSE_END_RE.test(String(cur[j].w).trim())) { k = j; break; }
        if (k >= 0) {
          groups.push(cur.slice(0, k + 1));
          cur = cur.slice(k + 1);
        } else {
          groups.push(cur);
          cur = [];
        }
      }
      cur.push(w);
      if (SENTENCE_END_RE.test(String(w.w).trim()) && joinWords(cur).length >= minSentence) {
        groups.push(cur);
        cur = [];
      }
    }
    if (cur.length) groups.push(cur);
    for (const g of groups) {
      lines.push({
        start: g[0].start,
        end: g[g.length - 1].end,
        text: groups.length === 1 ? s.text : joinWords(g),
        words: g.map(w => ({ w: String(w.w).trim(), start: round3(w.start), end: round3(w.end) })),
      });
    }
  }
  lines.sort((a, b) => a.start - b.start);
  // Minimum on-screen time without overlapping the next line.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    let end = Math.max(lines[i].end, lines[i].start + 0.8);
    if (next) end = Math.min(end, next.start);
    lines[i].start = round3(lines[i].start);
    lines[i].end = round3(Math.max(end, lines[i].start + 0.05));
  }
  return lines;
}

export const round3 = (n) => Math.round(n * 1000) / 1000;

/** ASS time H:MM:SS.cc */
export function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Make lyric text inert in ASS: no override blocks, no backslash escapes, one line. */
export function escapeAssText(text) {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
    .trim();
}

/** One family for Latin and Chinese lines (Yisheng's style spec); it also covers kana and hangul. */
export const LYRIC_FONT = 'Noto Sans CJK SC';
export function fontForLanguages() {
  return LYRIC_FONT;
}

export function needsCjkFont(lines, ...langs) {
  if (langs.some(l => /^(zh|ja|ko)/i.test(String(l || '')))) return true;
  return lines.some(l => isCjkText(l.text) || isCjkText(l.translation));
}

/**
 * Style spec, defined at 720x1280 and scaled to the video: font 48 (48/1280 of the height),
 * MarginV 256 (20% of the height, or position_from_bottom_pct), MarginL/R 48 (48/720 of the width),
 * outline 3, shadow 1, bottom-center.
 */
export const REFERENCE_SIZE = Object.freeze({ width: 720, height: 1280, fontSize: 48, marginLR: 48 });

// ─── Caption style the model can choose in chat ─────────────────────────────────────────────
// The default is the agreed style: Noto Sans CJK SC Bold 48 at 720x1280 (scaled), MarginV 20 %,
// Alignment 2 (bottom center). The fonts are the ones the browser engine (ffmpeg.wasm/libass) and
// the overlay can draw: the CJK family and the bundled Latin Inter.
export const CAPTION_FONTS = Object.freeze([LYRIC_FONT, 'Inter']);
export const CAPTION_SIZE_PRESETS = Object.freeze({ small: 0.75, default: 1, large: 1.4, xl: 1.8 });
/** position → ASS Alignment (numpad: 2 bottom, 5 middle, 8 top, all centered). */
export const CAPTION_ALIGNMENTS = Object.freeze({ bottom: 2, middle: 5, top: 8 });
export const TOP_MARGIN_PCT = 8;
export const SIZE_SCALE_RANGE = Object.freeze({ min: 0.5, max: 2.5 });
const SIZE_ALIASES = { small: 'small', smaller: 'small', tiny: 'small', default: 'default', normal: 'default', medium: 'default', regular: 'default', large: 'large', big: 'large', bigger: 'large', xl: 'xl', 'extra large': 'xl', 'extra-large': 'xl', xlarge: 'xl', huge: 'xl' };
const POSITION_ALIASES = { bottom: 'bottom', low: 'bottom', middle: 'middle', center: 'middle', centre: 'middle', top: 'top' };
const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const CAPTION_STYLE_QUESTION = 'Which font and where should the captions go? Default is Noto Sans CJK SC Bold, bottom, 20% up.';
/** The rule the model follows for caption style, in the web system prompt (server-owned). */
export const CAPTION_STYLE_GUIDANCE = 'Caption style: when the user asks for captions (lyric_captions) and has not said how they should look (font, size, position) and has not said "default" or "just do it", do not call the tool yet. Ask exactly one short question: "Which font and where should the captions go? Default is Noto Sans CJK SC Bold, bottom, 20% up." Then call lyric_captions with explicit font, size and position (and position_from_bottom_pct) from their answer. If they already stated any style preference ("bottom, large", "at the top", "bigger"), or say "default", "just do it" or "any", call the tool straight away, with the stated parts as parameters and the defaults for the rest. Never ask the style question twice.';

/**
 * Validate the style arguments of a lyric_captions call. Never throws: a bad value is dropped (the
 * default stays) and named in `ignored` so the caller can log it. Position and font size are
 * clamped: height 0-45 %, size 0.5x-2.5x of the default.
 * @returns {{ style: { font: string, sizeScale: number, alignment: 2|5|8, positionFromBottomPct: number }, ignored: string[] }}
 */
export function resolveCaptionStyle(args = {}, { videoHeight = 0 } = {}) {
  const ignored = [];
  const a = args && typeof args === 'object' ? args : {};
  const style = { font: LYRIC_FONT, sizeScale: 1, alignment: 2, positionFromBottomPct: DEFAULT_POSITION_FROM_BOTTOM_PCT };
  if (a.font != null && a.font !== '') {
    const want = String(a.font).replace(/\bbold\b/i, '').trim().toLowerCase();
    const hit = CAPTION_FONTS.find(f => f.toLowerCase() === want) || (/^noto sans( cjk)?( sc)?$/.test(want) ? LYRIC_FONT : null);
    if (hit) style.font = hit; else ignored.push('font');
  }
  if (a.size != null && a.size !== '') {
    const id = SIZE_ALIASES[String(a.size).trim().toLowerCase()];
    if (id) style.sizeScale = CAPTION_SIZE_PRESETS[id]; else ignored.push('size');
  } else if (a.font_size != null && a.font_size !== '') {
    const px = Number(a.font_size);
    const base = videoHeight * (REFERENCE_SIZE.fontSize / REFERENCE_SIZE.height);
    if (Number.isFinite(px) && px > 0 && base > 0) style.sizeScale = Math.round(clampNum(px / base, SIZE_SCALE_RANGE.min, SIZE_SCALE_RANGE.max) * 100) / 100;
    else ignored.push('font_size');
  }
  let position = 'bottom';
  if (a.position != null && a.position !== '') {
    position = POSITION_ALIASES[String(a.position).trim().toLowerCase()];
    if (!position) { ignored.push('position'); position = 'bottom'; }
  }
  style.alignment = CAPTION_ALIGNMENTS[position];
  if (a.position_from_bottom_pct != null && a.position_from_bottom_pct !== '') {
    const pct = Number(a.position_from_bottom_pct);
    if (Number.isFinite(pct)) style.positionFromBottomPct = Math.round(clampNum(pct, 0, 45));
    else ignored.push('position_from_bottom_pct');
  }
  return { style, ignored };
}

/** MarginV in px for an alignment: from the bottom (2), none (5, centered), or from the top (8). */
export function marginVFor({ height, alignment = 2, positionFromBottomPct = DEFAULT_POSITION_FROM_BOTTOM_PCT }) {
  if (alignment === 5) return 0;
  if (alignment === 8) return Math.round(height * TOP_MARGIN_PCT / 100);
  return Math.round(height * positionFromBottomPct / 100);
}

export function assStyleFor({ width, height, fontSize, positionFromBottomPct = DEFAULT_POSITION_FROM_BOTTOM_PCT, alignment = 2 }) {
  const al = alignment === 5 || alignment === 8 ? alignment : 2;
  return {
    fontSize: fontSize ?? Math.max(12, Math.round(REFERENCE_SIZE.fontSize * height / REFERENCE_SIZE.height)),
    marginV: marginVFor({ height, alignment: al, positionFromBottomPct }),
    marginLR: Math.round(REFERENCE_SIZE.marginLR * width / REFERENCE_SIZE.width),
    outline: 3,
    shadow: 1,
    alignment: al,
  };
}

export const sameText = (a, b) => normalizeCaptionText(a) !== '' && normalizeCaptionText(a) === normalizeCaptionText(b);

/** The translation to draw under a line, or '' when it just repeats the original. */
export function translationToShow(line) {
  const t = escapeAssText(line.translation);
  return t && !sameText(t, line.text) ? t : '';
}

/** ASS file: PlayRes = video size, one Dialogue per line with "original\Ntranslation". */
export function buildAss({ lines, width, height, fontName = LYRIC_FONT, fontSize, positionFromBottomPct, alignment }) {
  const st = assStyleFor({ width, height, fontSize, positionFromBottomPct, alignment });
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${st.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${st.outline},${st.shadow},${st.alignment},${st.marginLR},${st.marginLR},${st.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  // Exactly one Dialogue per caption line: original, hard \N, translation. A translation that only
  // repeats the original is left out so the same text is never drawn twice.
  const events = lines
    .map(l => ({ l, text: escapeAssText(l.text), translation: translationToShow(l) }))
    .filter(e => e.text || e.translation)
    .map(({ l, text, translation }) => {
      const parts = [text, translation].filter(Boolean);
      return `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Default,,0,0,0,,${parts.join('\\N')}`;
    });
  return `${[...header, ...events].join('\n')}\n`;
}

