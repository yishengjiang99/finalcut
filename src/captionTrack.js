// Captions as a live overlay, not pixels. After translation the finished lines are kept as a
// "caption track" attached to the exact video bytes they were made for. The editor draws the
// active line over the preview (timed from the lines, styled with `style`); nothing is burned in
// until the user exports. The track also survives a reload (text only, in localStorage, keyed by a
// fingerprint of the video) so a crashed or reloaded tab does not lose the work.
import { REFERENCE_SIZE, DEFAULT_POSITION_FROM_BOTTOM_PCT, LYRIC_FONT, CAPTION_FONTS, translationToShow, TOP_MARGIN_PCT } from './lyricShared.js';
import { videoHasBurnedCaptions } from './captionLineage.js';

export const DEFAULT_CAPTION_STYLE = Object.freeze({ positionFromBottomPct: DEFAULT_POSITION_FROM_BOTTOM_PCT, sizeScale: 1, font: LYRIC_FONT, alignment: 2 });
export const POSITION_RANGE = Object.freeze({ min: 0, max: 45 });
export const SIZE_SCALES = Object.freeze([
  { id: 'small', label: 'Small', scale: 0.75 },
  { id: 'default', label: 'Default', scale: 1 },
  { id: 'large', label: 'Large', scale: 1.4 },
  { id: 'xl', label: 'Extra large', scale: 1.8 },
]);
/** Default caption height as a fraction of the video height (ASS reference: 48 px on 1280). */
export const DEFAULT_FONT_RATIO = REFERENCE_SIZE.fontSize / REFERENCE_SIZE.height;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** A style with every field valid: position clamped to 0-45 %, size scale to 0.5-2.5. */
export function normalizeStyle(style = {}) {
  const pos = Number(style.positionFromBottomPct);
  const scale = Number(style.sizeScale);
  return {
    positionFromBottomPct: Number.isFinite(pos) ? clamp(Math.round(pos), POSITION_RANGE.min, POSITION_RANGE.max) : DEFAULT_CAPTION_STYLE.positionFromBottomPct,
    sizeScale: Number.isFinite(scale) ? clamp(Math.round(scale * 100) / 100, 0.5, 2.5) : DEFAULT_CAPTION_STYLE.sizeScale,
    font: CAPTION_FONTS.includes(style.font) ? style.font : DEFAULT_CAPTION_STYLE.font,
    alignment: [2, 5, 8].includes(Number(style.alignment)) ? Number(style.alignment) : 2,
  };
}

// ─── The store: video bytes → track ─────────────────────────────────────────────────────────
const tracks = new WeakMap();
const listeners = new Set();
let version = 0;
const emit = () => { version += 1; listeners.forEach(l => l()); };
const isObject = (v) => v !== null && typeof v === 'object';

export const subscribeTracks = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export const tracksVersion = () => version;
export const getTrack = (bytes) => (isObject(bytes) ? tracks.get(bytes) || null : null);

/** Attach (or replace) the caption track of `bytes`. Returns the stored track. */
export function setTrack(bytes, { lines, language = null, targetLanguage = null, style } = {}, { persist = true } = {}) {
  if (!isObject(bytes)) return null;
  const track = {
    id: `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    lines: (lines || []).map(l => ({ start: Number(l.start), end: Number(l.end), text: String(l.text ?? ''), translation: String(l.translation ?? '') })),
    language, targetLanguage, style: normalizeStyle(style),
  };
  tracks.set(bytes, track);
  if (persist) persistTrack(bytes, track);
  emit();
  return track;
}

/** Change the style of a track; the overlay and the export both read it. */
export function updateTrackStyle(bytes, patch) {
  const track = getTrack(bytes);
  if (!track) return null;
  const next = { ...track, style: normalizeStyle({ ...track.style, ...patch }) };
  tracks.set(bytes, next);
  persistTrack(bytes, next);
  emit();
  return next;
}

export function clearTrack(bytes, { forget = true } = {}) {
  if (!isObject(bytes) || !tracks.has(bytes)) return;
  tracks.delete(bytes);
  if (forget) forgetTrack(bytes);
  emit();
}

// ─── What the overlay shows ─────────────────────────────────────────────────────────────────
/** The lines to draw at time `t` (seconds): usually one, the original and its translation. */
export function activeLine(track, t) {
  if (!track || !Number.isFinite(t)) return null;
  const line = track.lines.find(l => t >= l.start && t < l.end);
  if (!line) return null;
  const text = line.text.trim();
  const translation = translationToShow(line) ? line.translation.trim() : '';
  return text || translation ? { text, translation } : null;
}

/** Inline CSS for the overlay box: bottom N %, centered, or top (ASS alignment 2, 5, 8). */
export function overlayPlacement(style = DEFAULT_CAPTION_STYLE) {
  if (style.alignment === 5) return { top: '50%', transform: 'translateY(-50%)' };
  if (style.alignment === 8) return { top: `${TOP_MARGIN_PCT}%` };
  return { bottom: `${style.positionFromBottomPct}%` };
}
/** CSS font-family for the overlay. */
export const overlayFontFamily = (style = DEFAULT_CAPTION_STYLE) => (style.font === 'Inter'
  ? 'Inter, system-ui, sans-serif'
  : '"Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif');

/** Overlay font height in px for a preview whose picture is `viewHeight` px tall. */
export const overlayFontPx = (track, viewHeight) => Math.max(10, Math.round(viewHeight * DEFAULT_FONT_RATIO * (track?.style?.sizeScale ?? 1)));

// ─── Export formats ─────────────────────────────────────────────────────────────────────────
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (sec, comma) => {
  const ms = Math.round(Math.max(0, sec) * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${comma ? ',' : '.'}${pad(ms % 1000, 3)}`;
};

// Markup in a cue (<i>…</i>) crashed Apple players when it reached a mov_text track, so it never does.
const plainCue = (t) => String(t ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export function trackToSrt(track) {
  return track.lines
    .map(l => ({ l, text: plainCue(l.text), tr: translationToShow(l) ? plainCue(l.translation) : '' }))
    .filter(e => e.text || e.tr)
    .map((e, i) => `${i + 1}\n${stamp(e.l.start, true)} --> ${stamp(e.l.end, true)}\n${[e.text, e.tr].filter(Boolean).join('\n')}\n`)
    .join('\n');
}

// ─── Edits after captioning ─────────────────────────────────────────────────────────────────
// Safe behavior: a caption track only follows an edit when the new video has the same timeline
// (or a trim, whose shift is exact). Any other edit clears the overlay and says so; the earlier
// clip keeps its captions, so Undo brings them back.
const SAME_TIMELINE = new Set([
  'resize_video', 'resize_video_preset', 'crop_video', 'rotate_video', 'flip_video_horizontal', 'flip_video_vertical',
  'add_text', 'adjust_brightness', 'adjust_hue', 'adjust_saturation', 'adjust_contrast', 'apply_color_filter',
  'adjust_audio_volume', 'convert_video_format', 'normalize_audio', 'adjust_bass', 'adjust_treble',
]);
const TIMELINE_CHANGING_AUDIO = new Set(['audio_delay', 'audio_reverse', 'audio_silence_remove']);
const keepsTimeline = (tool) => SAME_TIMELINE.has(tool) || (/^audio_/.test(tool) && !TIMELINE_CHANGING_AUDIO.has(tool));

/** "90", "1:30", "00:01:30.5" → seconds, or null. */
export function parseClock(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const s = String(value ?? '').trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(s)) return null;
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

export function shiftLines(lines, offset, keep) {
  return lines
    .map(l => ({ ...l, start: l.start - offset, end: Math.min(l.end - offset, keep) }))
    .filter(l => l.end > 0 && l.start < keep)
    .map(l => ({ ...l, start: Math.max(0, l.start) }));
}

export const CAPTIONS_CLEARED_NOTICE = 'I removed the caption overlay because that edit changes the video\'s timing, so the captions would no longer line up. The earlier clip keeps its captions (Undo brings them back), or ask me to caption this one again.';

/**
 * The edit `tool(args)` turned `previous` into `next`. Move, shift or drop the caption track.
 * Returns 'none' (no track), 'kept', 'shifted' or 'cleared'.
 */
export function carryTrackOnEdit(previous, next, tool, args = {}) {
  const track = getTrack(previous);
  if (!track || !isObject(next) || previous === next) return 'none';
  if (videoHasBurnedCaptions(next)) return 'cleared'; // a burn happened: never overlay on top of it
  if (keepsTimeline(tool)) {
    setTrack(next, track);
    return 'kept';
  }
  if (tool === 'trim_video') {
    const start = parseClock(args.start);
    const end = parseClock(args.end);
    if (start !== null && end !== null && end > start) {
      setTrack(next, { ...track, lines: shiftLines(track.lines, start, end - start) });
      return 'shifted';
    }
  }
  return 'cleared';
}

// ─── Survive a reload (text only) ───────────────────────────────────────────────────────────
const STORE_KEY = 'fc.captions.v1';
const MAX_ENTRIES = 8;
const MAX_BYTES = 900_000;

/** A cheap fingerprint of a video: its length plus a hash of 8 evenly spread 8 KB slices. */
export function videoKey(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length === 0) return null;
  let h = 0x811c9dc5;
  const slice = 8192;
  const n = bytes.length;
  const small = n <= slice * 8;
  for (let s = 0; s < (small ? 1 : 8); s += 1) {
    const from = small ? 0 : Math.floor(((n - slice) * s) / 7);
    const to = small ? n : Math.min(n, from + slice);
    for (let i = from; i < to; i += 1) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return `${n}-${h.toString(16)}`;
}

const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
function readStore() {
  try { const parsed = JSON.parse(storage()?.getItem(STORE_KEY) || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function writeStore(entries) {
  const ls = storage();
  if (!ls) return;
  let list = entries.slice(0, MAX_ENTRIES);
  while (list.length > 1 && JSON.stringify(list).length > MAX_BYTES) list = list.slice(0, -1);
  try { ls.setItem(STORE_KEY, JSON.stringify(list)); } catch { /* quota or private mode: captions just don't survive a reload */ }
}

export function persistTrack(bytes, track) {
  const key = videoKey(bytes);
  if (!key) return;
  const entry = { key, savedAt: Date.now(), language: track.language, targetLanguage: track.targetLanguage, style: track.style, lines: track.lines };
  writeStore([entry, ...readStore().filter(e => e?.key !== key)]);
}

export function forgetTrack(bytes) {
  const key = videoKey(bytes);
  if (key) writeStore(readStore().filter(e => e?.key !== key));
}

/** Put back the captions saved for this video (after a reload or a crash). Returns the track or null. */
export function restoreTrack(bytes) {
  if (!isObject(bytes) || tracks.has(bytes) || videoHasBurnedCaptions(bytes)) return getTrack(bytes);
  const key = videoKey(bytes);
  const entry = key ? readStore().find(e => e?.key === key && Array.isArray(e.lines) && e.lines.length) : null;
  return entry ? setTrack(bytes, entry, { persist: false }) : null;
}
