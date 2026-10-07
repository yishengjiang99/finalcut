// lyric_captions: audio in, timed bilingual captions out. The client burns them in.
//
// POST /api/lyric-captions takes an audio file only (WAV, m4a/aac, opus/ogg, mp3, ≤ 25 MB and
// ≤ 10 min), never the video. The server:
//   1. converts it to 16 kHz mono WAV (ffmpeg) and transcribes it with word timestamps through the
//      existing OpenAI transcription path (whisper-1 verbose_json, timestamp_granularities word +
//      segment). No Python sidecar: whisper-1 already gives word-level timing.
//   2. asks Grok to identify the song and correct misheard lines against the published lyrics
//      (Responses API + web_search when available, else chat completions from model knowledge),
//      keeping one corrected line per transcript line (timestamps untouched), and to translate each
//      line into the target language.
//   3. returns { song, mode, language, targetLanguage, lines:[{start,end,text,translation,words}],
//      ass? } as an async job result. The ASS is generated only when width/height are given.
// The uploaded audio and the WAV are deleted as soon as transcription finishes. The lines live in
// memory for LYRIC_RESULT_TTL_MS so the web fallback burn (POST /api/lyric-captions/:jobId/burn)
// can use them, then the job is dropped. See docs/api/LYRIC_CAPTIONS.md.
import express from 'express';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import axios from 'axios';
import FormData from 'form-data';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { OPENAI_API_KEY, XAI_API_TOKEN } from './config.js';
import {
  videoProcessLimiter,
  requireAuthenticatedUser,
  requireInferenceAccess,
  uploadSingle,
  getBaseUrlFromRequest,
  isValidSampleModeRequest,
} from './middleware.js';
import { extractAudioToWav } from './captions.js';
import { normalizeLanguageCode, stripLlmFences, normalizeCaptionText } from './captionHelpers.js';
import { enqueueCustomJob, JOBS_DIR, _jobsForTests as jobs } from './jobs.js';

export const LYRIC_AUDIO_MAX_BYTES = 25 * 1024 * 1024; // OpenAI audio limit; 10 min of 16 kHz WAV is 19.2 MB
export const LYRIC_AUDIO_MAX_SECONDS = 10 * 60;
export const LYRIC_RESULT_TTL_MS = 30 * 60 * 1000;
export const LYRIC_MODES = ['auto', 'lyrics', 'speech'];
export const DEFAULT_POSITION_FROM_BOTTOM_PCT = 20;
export const UNAVAILABLE = 'lyric_captions_unavailable';
const SEARCH_MODEL = process.env.LYRIC_CAPTIONS_MODEL || 'grok-4.7';
const FALLBACK_MODEL = process.env.LYRIC_CAPTIONS_FALLBACK_MODEL || 'grok-3';

export class LyricCaptionsError extends Error {
  constructor(message, { status = 400, code = 'invalid_arguments' } = {}) {
    super(message);
    this.name = 'LyricCaptionsError';
    this.status = status;
    this.code = code;
  }
  toJSON() { return { error: this.message, code: this.code, operation: 'lyric_captions' }; }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
const isCjkText = (s) => CJK_RE.test(String(s || ''));
const SENTENCE_END_RE = /[.!?。！？…]$/;
const CLAUSE_END_RE = /[.!?。！？…,;:，；：、]$/;

/** Target language: keep a valid BCP-47 tag as given (zh-Hans, pt-BR); otherwise a normalized code. */
export function parseTargetLanguage(raw) {
  if (raw == null || !String(raw).trim()) return null;
  const trimmed = String(raw).trim();
  const base = normalizeLanguageCode(trimmed, { allowAuto: false });
  if (!base) return null;
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})+$/.test(trimmed) ? trimmed : base;
}

/** Validate and default the request options shared by the endpoint, the burn, and the tool. */
export function parseLyricOptions(raw = {}) {
  const targetLanguage = parseTargetLanguage(raw.target_language ?? raw.targetLanguage);
  if (!targetLanguage) {
    throw new LyricCaptionsError('target_language is required: a language code or name such as "zh-Hans", "es", or "Japanese"');
  }
  const sourceLanguage = normalizeLanguageCode(raw.source_language ?? raw.sourceLanguage ?? 'auto', { allowAuto: true });
  if (!sourceLanguage) throw new LyricCaptionsError('source_language must be "auto" or a language code/name');
  const mode = raw.mode == null || raw.mode === '' ? 'auto' : String(raw.mode);
  if (!LYRIC_MODES.includes(mode)) throw new LyricCaptionsError(`mode must be one of: ${LYRIC_MODES.join(', ')}`);
  const style = parseStyleOptions(raw);
  const width = optionalInt(raw.width, 'width', 16, 8192);
  const height = optionalInt(raw.height, 'height', 16, 8192);
  if ((width == null) !== (height == null)) throw new LyricCaptionsError('width and height must be given together');
  return { targetLanguage, sourceLanguage, mode, ...style, width, height };
}

export function parseStyleOptions(raw = {}) {
  const pct = raw.position_from_bottom_pct ?? raw.positionFromBottomPct;
  const positionFromBottomPct = pct == null || pct === '' ? DEFAULT_POSITION_FROM_BOTTOM_PCT : Number(pct);
  if (!Number.isFinite(positionFromBottomPct) || positionFromBottomPct < 0 || positionFromBottomPct > 45) {
    throw new LyricCaptionsError('position_from_bottom_pct must be a number from 0 to 45');
  }
  const fontSize = optionalInt(raw.font_size ?? raw.fontSize, 'font_size', 8, 400);
  return { positionFromBottomPct, fontSize };
}

function optionalInt(value, field, min, max) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new LyricCaptionsError(`${field} must be an integer from ${min} to ${max}`);
  return n;
}

function joinWords(words) {
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

const round3 = (n) => Math.round(n * 1000) / 1000;

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

const sameText = (a, b) => normalizeCaptionText(a) !== '' && normalizeCaptionText(a) === normalizeCaptionText(b);

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

/** Pull the JSON object out of a model reply (tolerates fences and prose around it). */
export function parseModelJson(text) {
  const t = stripLlmFences(String(text || '')).replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function cleanUrl(u) {
  if (typeof u !== 'string' || u.length > 500) return undefined;
  try {
    const parsed = new URL(u.trim());
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : undefined;
  } catch { return undefined; }
}

/**
 * Merge the model's corrections into the transcript lines. Only lines that exist in the
 * transcript are kept (index-aligned, timestamps untouched); anything extra the model returns is
 * dropped, so no lyric text beyond what was sung in the clip is ever returned.
 */
export function mergeCorrections(lines, parsed, { usedWebSearch }) {
  const byIndex = new Map();
  for (const item of Array.isArray(parsed?.lines) ? parsed.lines : []) {
    const i = Number(item?.i);
    if (Number.isInteger(i) && i >= 0 && i < lines.length && !byIndex.has(i)) byIndex.set(i, item);
  }
  const merged = lines.map((l, i) => {
    const c = byIndex.get(i);
    const text = typeof c?.text === 'string' && c.text.trim() ? c.text.trim().slice(0, 300) : l.text;
    let translation = typeof c?.translation === 'string' ? c.translation.trim().slice(0, 300) : '';
    if (sameText(translation, text)) translation = ''; // never show the same line twice
    return { ...l, text, translation };
  });
  const s = parsed?.song;
  let song = null;
  if (s && typeof s === 'object' && typeof s.title === 'string' && s.title.trim()) {
    const conf = ['high', 'medium', 'low'].includes(s.confidence) ? s.confidence : 'low';
    song = {
      title: s.title.trim().slice(0, 200),
      artist: typeof s.artist === 'string' ? s.artist.trim().slice(0, 200) : '',
      url: usedWebSearch ? cleanUrl(s.url) : undefined,
      // Without web search the match comes from model knowledge alone: never "high".
      confidence: usedWebSearch ? conf : (conf === 'high' ? 'medium' : conf),
      source: usedWebSearch ? 'web_search' : 'model_knowledge',
    };
  }
  const mode = ['lyrics', 'speech'].includes(parsed?.mode) ? parsed.mode : (song ? 'lyrics' : 'speech');
  const language = typeof parsed?.language === 'string' ? normalizeLanguageCode(parsed.language, { allowAuto: false }) : null;
  return { lines: merged, song, mode, language, translatedCount: merged.filter(l => l.translation).length };
}

export function buildCorrectionPrompt({ lines, targetLanguage, sourceLanguage, mode, detectedLanguage }) {
  const system = [
    'You fix speech-recognition transcripts of short user videos and translate them for bilingual captions.',
    'Input: numbered transcript lines (with timestamps) from one clip.',
    mode === 'speech'
      ? 'The clip is speech: fix only obvious recognition errors.'
      : 'If it is a song, identify it (title, artist) from distinctive phrases'
        + (mode === 'lyrics' ? '' : ' (or decide it is speech)')
        + ', search the web for the published lyrics when you can, and correct each misheard line to what is actually sung. For speech, fix only obvious errors.',
    'Rules: return exactly one output line per input line, same index "i", same order. Never merge, split, add, or reorder lines,'
      + ' and never add lyric lines that are not in the transcript. Keep each translation short enough for one caption line.',
    'Reply with JSON only, no markdown: {"mode":"lyrics"|"speech","language":"<ISO code of the sung/spoken language>",'
      + '"song":{"title":"","artist":"","url":"<lyrics or song page you used, if any>","confidence":"high"|"medium"|"low"} or null,'
      + '"lines":[{"i":0,"text":"<corrected original>","translation":"<translation>"}]}',
    'Use confidence "high" only when a published source confirms the match.',
  ].join('\n');
  const user = [
    `Target language for translations: ${targetLanguage}.`,
    `Source language: ${sourceLanguage === 'auto' ? `auto (recognizer guessed ${detectedLanguage || 'unknown'})` : sourceLanguage}.`,
    `Mode: ${mode}.`,
    '',
    ...lines.map((l, i) => `${i} [${l.start.toFixed(2)}-${l.end.toFixed(2)}] ${l.text}`),
  ].join('\n');
  return { system, user };
}

// ── External calls (overridable in tests) ───────────────────────────────────

/** OpenAI whisper-1 with word + segment timestamps (the only OpenAI model that returns words). */
async function transcribeWordsOpenAI(wavPath, languageCode) {
  const form = new FormData();
  form.append('file', await fs.readFile(wavPath), { filename: path.basename(wavPath), contentType: 'audio/wav' });
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (languageCode) form.append('language', languageCode);
  const resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
    timeout: 300_000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  const d = resp.data || {};
  return {
    language: d.language || null,
    duration: d.duration ?? null,
    segments: (d.segments || []).map(s => ({ start: s.start ?? 0, end: s.end ?? 0, text: s.text || '' })),
    words: (d.words || []).map(w => ({ w: w.word ?? '', start: w.start, end: w.end })),
  };
}

function responsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text) return data.output_text;
  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    for (const c of Array.isArray(item?.content) ? item.content : []) {
      if ((c?.type === 'output_text' || c?.type === 'text') && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n');
}

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${XAI_API_TOKEN}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`xAI API error ${res.status}: ${data?.error?.message || data?.error || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Grok correction + translation. Lyrics/auto: Responses API with the web_search tool. If that
 * fails (model or tool unavailable), or in speech mode, chat completions without search.
 */
async function correctWithGrok({ lines, targetLanguage, sourceLanguage, mode, detectedLanguage }) {
  const { system, user } = buildCorrectionPrompt({ lines, targetLanguage, sourceLanguage, mode, detectedLanguage });
  if (mode !== 'speech') {
    try {
      const data = await postJson('https://api.x.ai/v1/responses', {
        model: SEARCH_MODEL,
        input: [{ role: 'system', content: system }, { role: 'user', content: user }],
        tools: [{ type: 'web_search' }],
        include: ['no_inline_citations'],
      }, 180_000);
      const parsed = parseModelJson(responsesText(data));
      if (parsed) return { parsed, usedWebSearch: true, model: SEARCH_MODEL };
      console.warn('[lyric_captions] web-search reply was not JSON; retrying without search');
    } catch (err) {
      console.warn(`[lyric_captions] web search unavailable (${err.message}); using model knowledge`);
    }
  }
  const data = await postJson('https://api.x.ai/v1/chat/completions', {
    model: FALLBACK_MODEL,
    temperature: 0,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, 120_000);
  const parsed = parseModelJson(data?.choices?.[0]?.message?.content);
  if (!parsed) throw new LyricCaptionsError('The model did not return usable captions', { status: 502, code: 'lyric_captions_model_error' });
  return { parsed, usedWebSearch: false, model: FALLBACK_MODEL };
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

let toolsProbe = null;
/** What this host can do: ffmpeg/ffprobe present, ffmpeg `ass` filter (libass), installed font families. */
async function probeHostTools() {
  if (!toolsProbe) {
    toolsProbe = (async () => {
      const [filters, probeVer, fonts] = await Promise.all([
        run('ffmpeg', ['-hide_banner', '-filters']),
        run('ffprobe', ['-version']),
        run('fc-list', [':', 'family']),
      ]);
      return {
        ffmpeg: filters != null,
        ffprobe: probeVer != null,
        assFilter: filters != null && /^\s*\S*\s+ass\s+V->V/m.test(filters),
        fontFamilies: new Set((fonts || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean)),
      };
    })();
  }
  return toolsProbe;
}

function probeMedia(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => (err ? reject(err) : resolve(meta)));
  });
}

async function burnAss({ inputPath, assPath, outputPath, copyAudio }) {
  const escaped = assPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoFilters(`ass='${escaped}'`)
      .outputOptions([
        '-map 0:v:0', '-map 0:a?',
        '-c:v libx264', '-preset medium', '-crf 20', '-pix_fmt yuv420p',
        copyAudio ? '-c:a copy' : '-c:a aac',
        '-movflags +faststart',
      ])
      .on('error', reject)
      .on('end', resolve)
      .save(outputPath);
  });
}

const defaultHooks = {
  hasApiKeys: () => Boolean(OPENAI_API_KEY && XAI_API_TOKEN),
  probeHostTools,
  probeMedia,
  extractAudioToWav,
  transcribe: transcribeWordsOpenAI,
  correct: correctWithGrok,
  burnAss,
};
let hooks = { ...defaultHooks };
/** Tests: replace STT, model, probes, or ffmpeg steps. Call with no argument to reset. */
export function _setLyricCaptionsHooks(overrides) {
  hooks = overrides ? { ...defaultHooks, ...overrides } : { ...defaultHooks };
  toolsProbe = null;
}

// ── Pipeline ────────────────────────────────────────────────────────────────

/** Checks before accepting work. Throws a 503 lyric_captions_unavailable naming what is missing. */
export async function assertLyricCaptionsAvailable({ forBurn = false, fontName = null } = {}) {
  const missing = [];
  if (!forBurn && !hooks.hasApiKeys()) missing.push('OPENAI_API_KEY and XAI_API_TOKEN');
  const host = await hooks.probeHostTools();
  if (!host.ffmpeg) missing.push('ffmpeg');
  if (!host.ffprobe) missing.push('ffprobe');
  if (forBurn && !host.assFilter) missing.push('an ffmpeg build with libass (the "ass" filter)');
  if (forBurn && fontName && !host.fontFamilies.has(fontName)) missing.push(`the "${fontName}" font (apt install fonts-noto-cjk)`);
  if (missing.length) {
    throw new LyricCaptionsError(`Lyric captions are unavailable on this server: missing ${missing.join(', ')}.`, { status: 503, code: UNAVAILABLE });
  }
}

/** Probe an upload: must be audio only, ≤ 10 min. Returns duration in seconds. */
export async function validateAudioUpload(filePath) {
  let meta;
  try {
    meta = await hooks.probeMedia(filePath);
  } catch {
    throw new LyricCaptionsError('Could not read the audio file. Send WAV, m4a/aac, opus/ogg, or mp3.', { code: 'unsupported_audio_format' });
  }
  const streams = meta?.streams || [];
  if (!streams.some(s => s.codec_type === 'audio')) throw new LyricCaptionsError('The file has no audio track', { code: 'no_audio' });
  if (streams.some(s => s.codec_type === 'video' && !s.disposition?.attached_pic)) {
    throw new LyricCaptionsError('Send audio only, not the video. Extract the audio track on the device first.', { code: 'audio_only' });
  }
  const duration = Number(meta?.format?.duration);
  if (Number.isFinite(duration) && duration > LYRIC_AUDIO_MAX_SECONDS) {
    throw new LyricCaptionsError(`Audio is longer than ${LYRIC_AUDIO_MAX_SECONDS / 60} minutes`, { status: 413, code: 'audio_too_long' });
  }
  return Number.isFinite(duration) ? duration : null;
}

/** Audio file → caption result. Deletes the audio and WAV as soon as transcription is done. */
export async function runLyricCaptions({ audioPath, options, onProgress = () => {} }) {
  const wavPath = path.join(JOBS_DIR, `lyric-${randomUUID()}.wav`);
  let transcript;
  try {
    await hooks.extractAudioToWav(audioPath, wavPath);
    onProgress(0.2);
    transcript = await hooks.transcribe(wavPath, options.sourceLanguage === 'auto' ? null : options.sourceLanguage);
  } finally {
    await Promise.all([fs.unlink(audioPath).catch(() => {}), fs.unlink(wavPath).catch(() => {})]);
  }
  onProgress(0.5);
  const asrLines = buildLines(transcript);
  if (!asrLines.length) throw new LyricCaptionsError('No singing or speech detected in the audio', { status: 422, code: 'no_speech' });
  const detected = normalizeLanguageCode(transcript.language || '', { allowAuto: false });
  const { parsed, usedWebSearch, model } = await hooks.correct({
    lines: asrLines,
    targetLanguage: options.targetLanguage,
    sourceLanguage: options.sourceLanguage,
    mode: options.mode,
    detectedLanguage: detected,
  });
  onProgress(0.9);
  const merged = mergeCorrections(asrLines, parsed, { usedWebSearch });
  const language = (options.sourceLanguage !== 'auto' && options.sourceLanguage) || merged.language || detected || null;
  const fontName = fontForLanguages(language, options.targetLanguage);
  const result = {
    song: merged.song,
    mode: options.mode === 'auto' ? merged.mode : options.mode,
    language,
    targetLanguage: options.targetLanguage,
    webSearch: usedWebSearch,
    model,
    style: {
      fontName,
      ...assStyleFor({ width: options.width ?? 1080, height: options.height ?? 1920, fontSize: options.fontSize, positionFromBottomPct: options.positionFromBottomPct }),
      positionFromBottomPct: options.positionFromBottomPct,
      // Scale rules for overlay clients: font = 48/1280 of the height, side margins = 48/720 of the width.
      fontSizeOfHeight: options.fontSize ? undefined : REFERENCE_SIZE.fontSize / REFERENCE_SIZE.height,
      marginLROfWidth: REFERENCE_SIZE.marginLR / REFERENCE_SIZE.width,
    },
    lines: merged.lines.map(l => ({ start: l.start, end: l.end, text: l.text, translation: l.translation, words: l.words })),
  };
  if (options.width && options.height) {
    result.ass = buildAss({ lines: result.lines, width: options.width, height: options.height, fontName, fontSize: options.fontSize, positionFromBottomPct: options.positionFromBottomPct });
  }
  return result;
}

/** Short, lyric-free summary for job polling and the chat tool result. */
export function summarizeResult(result) {
  return {
    song: result.song,
    mode: result.mode,
    language: result.language,
    targetLanguage: result.targetLanguage,
    lineCount: result.lines.length,
    translatedCount: result.lines.filter(l => l.translation).length,
    webSearch: result.webSearch,
  };
}

function videoDisplaySize(meta) {
  const v = (meta?.streams || []).find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v?.width || !v?.height) return null;
  const sideRot = (v.side_data_list || []).find(d => d.rotation != null)?.rotation;
  const rot = Math.abs(Number(sideRot ?? v.tags?.rotate ?? 0)) % 180;
  return rot === 90 ? { width: v.height, height: v.width } : { width: v.width, height: v.height };
}

// ── Routes ──────────────────────────────────────────────────────────────────

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LYRIC_AUDIO_MAX_BYTES },
});

function uploadAudio(req, res, next) {
  audioUpload.single('audio')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Audio must be ${LYRIC_AUDIO_MAX_BYTES / 1024 / 1024} MB or smaller`, code: 'audio_too_large', operation: 'lyric_captions' });
    }
    return res.status(400).json({ error: err.message || 'Upload failed', operation: 'lyric_captions' });
  });
}

function sendError(res, err, fallback) {
  if (err instanceof LyricCaptionsError) return res.status(err.status).json(err.toJSON());
  console.error(`[lyric_captions] ${fallback}:`, err?.message || err);
  return res.status(500).json({ error: fallback, operation: 'lyric_captions' });
}

/** Availability check runs before the quota middleware so a broken host never charges an edit. */
async function requireAvailable(req, res, next) {
  try {
    await assertLyricCaptionsAvailable();
    return next();
  } catch (err) {
    return sendError(res, err, 'Lyric captions are unavailable');
  }
}

function jobFor(req) {
  const job = jobs.get(req.params.jobId);
  if (!job || job.operation !== 'lyric_captions') return null;
  if (!isValidSampleModeRequest(req) && job.userId != null && req.user?.id != null && job.userId !== req.user.id) return null;
  return job;
}

const router = express.Router();

/**
 * POST /api/lyric-captions (multipart): audio (file), target_language, source_language?, mode?,
 * position_from_bottom_pct?, font_size?, width?, height?
 * → 202 { jobId, status, pollUrl, resultUrl }. Poll GET /api/jobs/:id (summary = song info);
 *   GET /api/jobs/:id/result → caption JSON.
 */
router.post('/api/lyric-captions', videoProcessLimiter, requireAuthenticatedUser, requireAvailable, uploadAudio, async (req, res, next) => {
  // Validate before charging the edit.
  try {
    if (!req.file?.buffer?.length) throw new LyricCaptionsError('No audio file provided (multipart field "audio")');
    req.lyricOptions = parseLyricOptions(req.body || {});
    return next();
  } catch (err) {
    return sendError(res, err, 'Invalid request');
  }
}, requireInferenceAccess, async (req, res) => {
  let audioPath = path.join(JOBS_DIR, `lyric-${randomUUID()}.audio`);
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    await fs.writeFile(audioPath, req.file.buffer);
    const durationSec = await validateAudioUpload(audioPath);
    const baseUrl = getBaseUrlFromRequest(req);
    const options = req.lyricOptions;
    const job = await enqueueCustomJob({
      operation: 'lyric_captions',
      mediaType: 'audio',
      userId: req.user?.id ?? null,
      sampleMode: isValidSampleModeRequest(req),
      baseUrl,
    }, async (j) => {
      const owned = audioPath;
      audioPath = null;
      try {
        const result = await runLyricCaptions({ audioPath: owned, options, onProgress: (p) => { j.progress = p; j.updatedAt = new Date().toISOString(); } });
        j.resultJson = result;
        j.lyricOptions = options;
        j.summary = summarizeResult(result);
        j.resultContentType = 'application/json';
      } finally {
        setTimeout(() => jobs.delete(j.id), LYRIC_RESULT_TTL_MS).unref?.();
      }
    });
    return res.status(202).json({
      jobId: job.id,
      status: 'queued',
      operation: 'lyric_captions',
      durationSec,
      pollUrl: `${baseUrl}/api/jobs/${job.id}`,
      resultUrl: `${baseUrl}/api/jobs/${job.id}/result`,
    });
  } catch (err) {
    if (audioPath) fs.unlink(audioPath).catch(() => {});
    return sendError(res, err, 'Failed to start lyric captions');
  }
});

/**
 * Web fallback burn-in (the web app has no client-side ffmpeg): POST /api/lyric-captions/:jobId/burn
 * multipart video (+ optional args JSON { position_from_bottom_pct, font_size }) → video/mp4.
 * Uses the finished job's lines, sized to the uploaded video. Not charged again (same edit).
 */
router.post('/api/lyric-captions/:jobId/burn', videoProcessLimiter, requireAuthenticatedUser, uploadSingle('video'), async (req, res) => {
  const job = jobFor(req);
  if (!job) return res.status(404).json({ error: 'Lyric caption job not found or expired', code: 'job_not_found', operation: 'lyric_captions' });
  if (job.status !== 'succeeded' || !job.resultJson) {
    return res.status(409).json({ error: `Lyric caption job is ${job.status}`, code: 'job_not_ready', operation: 'lyric_captions' });
  }
  if (!req.file?.buffer?.length) return res.status(400).json({ error: 'No video file provided (multipart field "video")', operation: 'lyric_captions' });
  const id = randomUUID();
  const inputPath = path.join(JOBS_DIR, `lyric-burn-${id}.in`);
  const assPath = path.join(JOBS_DIR, `lyric-burn-${id}.ass`);
  const outputPath = path.join(JOBS_DIR, `lyric-burn-${id}.mp4`);
  try {
    let args = {};
    if (req.body?.args) {
      try { args = JSON.parse(req.body.args); } catch { throw new LyricCaptionsError('args must be valid JSON'); }
    }
    const style = parseStyleOptions({ ...job.lyricOptions, ...args });
    const result = job.resultJson;
    const fontName = fontForLanguages(result.language, result.targetLanguage);
    await assertLyricCaptionsAvailable({ forBurn: true, fontName: needsCjkFont(result.lines, result.language, result.targetLanguage) ? fontName : null });
    await fs.mkdir(JOBS_DIR, { recursive: true });
    await fs.writeFile(inputPath, req.file.buffer);
    let meta;
    try { meta = await hooks.probeMedia(inputPath); } catch { meta = null; }
    const size = videoDisplaySize(meta);
    if (!size) throw new LyricCaptionsError('Lyric captions need a video', { code: 'unsupported_for_photo' });
    const audio = (meta.streams || []).find(s => s.codec_type === 'audio');
    await fs.writeFile(assPath, buildAss({ lines: result.lines, width: size.width, height: size.height, fontName, ...style }), 'utf8');
    await hooks.burnAss({ inputPath, assPath, outputPath, copyAudio: !audio || ['aac', 'mp3', 'alac'].includes(audio.codec_name) });
    const out = await fs.readFile(outputPath);
    res.set('Content-Type', 'video/mp4');
    res.set('X-Lyric-Captions-Burn', 'server');
    return res.send(out);
  } catch (err) {
    return sendError(res, err, 'Failed to burn lyric captions');
  } finally {
    await Promise.all([inputPath, assPath, outputPath].map(p => fs.unlink(p).catch(() => {})));
  }
});

export { router as lyricCaptionsRouter };
