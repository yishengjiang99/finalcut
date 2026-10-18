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
export function assStyleFor({ width, height, fontSize, positionFromBottomPct = DEFAULT_POSITION_FROM_BOTTOM_PCT }) {
  return {
    fontSize: fontSize ?? Math.max(12, Math.round(REFERENCE_SIZE.fontSize * height / REFERENCE_SIZE.height)),
    marginV: Math.round(height * positionFromBottomPct / 100),
    marginLR: Math.round(REFERENCE_SIZE.marginLR * width / REFERENCE_SIZE.width),
    outline: 3,
    shadow: 1,
    alignment: 2,
  };
}

export const sameText = (a, b) => normalizeCaptionText(a) !== '' && normalizeCaptionText(a) === normalizeCaptionText(b);

/** The translation to draw under a line, or '' when it just repeats the original. */
export function translationToShow(line) {
  const t = escapeAssText(line.translation);
  return t && !sameText(t, line.text) ? t : '';
}

/** ASS file: PlayRes = video size, one Dialogue per line with "original\Ntranslation". */
export function buildAss({ lines, width, height, fontName = LYRIC_FONT, fontSize, positionFromBottomPct }) {
  const st = assStyleFor({ width, height, fontSize, positionFromBottomPct });
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

