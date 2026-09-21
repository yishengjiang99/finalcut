/**
 * Caption language + SRT helpers shared by generate/translate endpoints and tests.
 */

const LANGUAGE_ALIASES = {
  english: 'en', en: 'en',
  spanish: 'es', es: 'es', español: 'es', espanol: 'es',
  french: 'fr', fr: 'fr', français: 'fr', francais: 'fr',
  german: 'de', de: 'de', deutsch: 'de',
  italian: 'it', it: 'it',
  portuguese: 'pt', pt: 'pt',
  russian: 'ru', ru: 'ru',
  japanese: 'ja', jp: 'ja', ja: 'ja',
  chinese: 'zh', zh: 'zh', mandarin: 'zh', cantonese: 'zh',
  korean: 'ko', ko: 'ko',
  arabic: 'ar', ar: 'ar',
  hindi: 'hi', hi: 'hi',
  dutch: 'nl', nl: 'nl',
  swedish: 'sv', sv: 'sv',
  norwegian: 'no', no: 'no',
  danish: 'da', da: 'da',
  finnish: 'fi', fi: 'fi',
  polish: 'pl', pl: 'pl',
  turkish: 'tr', tr: 'tr',
  vietnamese: 'vi', vi: 'vi',
  thai: 'th', th: 'th',
  indonesian: 'id', id: 'id',
  hebrew: 'he', he: 'he',
  ukrainian: 'uk', uk: 'uk',
};

/**
 * Normalize a language hint to an ISO-ish code, or 'auto'.
 * Accepts "en", "en-US", "English", "spanish", etc.
 * Returns null if unusable.
 */
export function normalizeLanguageCode(raw, { allowAuto = true } = {}) {
  if (raw == null) return allowAuto ? 'auto' : null;
  const trimmed = String(raw).trim();
  if (!trimmed) return allowAuto ? 'auto' : null;
  if (allowAuto && /^auto$/i.test(trimmed)) return 'auto';

  const lower = trimmed.toLowerCase();
  if (LANGUAGE_ALIASES[lower]) return LANGUAGE_ALIASES[lower];

  // en-US / zh-CN style
  const bcp = /^([a-zA-Z]{2,3})(?:-[a-zA-Z0-9]{2,8})*$/.exec(trimmed);
  if (bcp) {
    const base = bcp[1].toLowerCase();
    return LANGUAGE_ALIASES[base] || base;
  }

  // "to Spanish" / "in French"
  const m = /(?:^|\s)(?:to|in|into)?\s*([a-zA-Z]{3,})/i.exec(trimmed);
  if (m && LANGUAGE_ALIASES[m[1].toLowerCase()]) {
    return LANGUAGE_ALIASES[m[1].toLowerCase()];
  }

  return null;
}

export function stripLlmFences(text) {
  if (!text) return '';
  let t = String(text).trim();
  // ```srt ... ``` or ``` ... ```
  const fenced = /^```(?:srt|vtt|text)?\s*\n?([\s\S]*?)\n?```$/i.exec(t);
  if (fenced) t = fenced[1].trim();
  // Drop leading prose before first cue index
  const idx = t.search(/(?:^|\n)\s*1\s*\n\s*\d{2}:\d{2}:\d{2}/);
  if (idx > 0) t = t.slice(idx).replace(/^\n/, '');
  return t.trim();
}

const TS = String.raw`\d{2}:\d{2}:\d{2}[,.]\d{3}`;
const TIMING_RE = new RegExp(String.raw`^(${TS})\s*-->\s*(${TS})`);

/**
 * Parse SRT into cues: { index, start, end, timingLine, text }.
 */
export function parseSrtCues(srt) {
  if (!srt || !String(srt).trim()) return [];
  const blocks = String(srt).replace(/\r\n/g, '\n').trim().split(/\n\s*\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trimEnd()).filter((l, i, arr) => !(i === 0 && l === '') );
    if (!lines.length) continue;
    let i = 0;
    let index = cues.length + 1;
    if (/^\d+$/.test(lines[0].trim())) {
      index = parseInt(lines[0].trim(), 10);
      i = 1;
    }
    if (i >= lines.length) continue;
    const timingLine = lines[i].trim();
    const tm = TIMING_RE.exec(timingLine);
    if (!tm) continue;
    i += 1;
    const text = lines.slice(i).join('\n').trim();
    cues.push({
      index,
      start: tm[1].replace('.', ','),
      end: tm[2].replace('.', ','),
      timingLine: `${tm[1].replace('.', ',')} --> ${tm[2].replace('.', ',')}`,
      text,
    });
  }
  return cues;
}

export function cuesToSrt(cues) {
  return cues.map((c, i) => `${c.index || i + 1}\n${c.timingLine}\n${c.text}`).join('\n\n');
}

/**
 * Keep original timestamps/order; swap in translated cue texts.
 * Prevents Grok from mangling SRT timing lines.
 */
export function mergeTranslatedSrt(originalSrt, translatedRaw) {
  const original = parseSrtCues(originalSrt);
  if (!original.length) {
    throw new Error('Original SRT has no cues to translate');
  }
  const cleaned = stripLlmFences(translatedRaw);
  let translated = parseSrtCues(cleaned);

  // If structure broke, harvest non-index/non-timing lines in order
  if (translated.length !== original.length) {
    const textLines = cleaned
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !/^\d+$/.test(l) && !TIMING_RE.test(l) && !/^```/.test(l));
    if (textLines.length >= original.length) {
      translated = original.map((c, i) => ({ ...c, text: textLines[i] }));
    } else if (translated.length > 0 && translated.length < original.length) {
      // Partial: pad with original text for missing cues
      const pad = [...translated];
      while (pad.length < original.length) {
        const o = original[pad.length];
        pad.push({ ...o });
      }
      translated = pad;
    } else {
      throw new Error(
        `Translation cue count mismatch (original ${original.length}, translated ${translated.length}). Retry with shorter clip or without translation.`
      );
    }
  }

  const merged = original.map((o, i) => ({
    index: o.index,
    timingLine: o.timingLine,
    text: (translated[i].text || o.text || '').trim() || o.text,
  }));

  // Verify timings unchanged
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].timingLine !== original[i].timingLine) {
      merged[i].timingLine = original[i].timingLine;
    }
  }

  return cuesToSrt(merged);
}

export function srtHasSpeech(srt) {
  const cues = parseSrtCues(srt);
  const texts = cues
    .map(c => (c.text || '').replace(/\[[^\]]*\]/g, '').trim())
    .filter(Boolean);
  if (!texts.length) return false;

  // Whisper-family models often hallucinate on silence / near-silence.
  const joined = texts.join(' ').trim();
  const lower = joined.toLowerCase();
  const trivial = new Set([
    'you', 'thanks', 'thank you', 'thank you.', 'thanks for watching',
    'thanks for watching.', 'bye', 'the end', '.', '...',
  ]);
  if (trivial.has(lower)) return false;
  if (texts.length === 1 && texts[0].split(/\s+/).length <= 2 && texts[0].length < 12) {
    return false;
  }
  return true;
}
