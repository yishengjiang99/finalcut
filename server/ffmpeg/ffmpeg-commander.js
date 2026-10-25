// Builds and validates FFmpeg argument lists. Output is an args array (never a shell string to execute).
import { discovery as defaultDiscovery } from './ffmpeg-discovery.js';

const FILTER_NAME = /^[A-Za-z0-9_]+$/;
const CODEC_NAME = /^[A-Za-z0-9_]+$/;
// Allow-list: the filters the app's own tools and prompts emit (src/tools.js handlers, iOS/web export
// pipelines, the CLI-fallback tests), all of which only transform the streams they are given.
// Anything that can open another file or device (movie, amovie, subtitles, ass, drawtext, lut3d,
// sendcmd, zmq, …) is absent, so it is rejected even if the local FFmpeg build has it.
export const ALLOWED_FILTERS = new Set([
  // video geometry / timing
  'scale', 'crop', 'pad', 'rotate', 'transpose', 'hflip', 'vflip', 'setsar', 'setdar', 'setpts', 'fps', 'format', 'trim', 'reverse', 'tpad', 'thumbnail', 'null', 'split',
  // video look
  'eq', 'hue', 'curves', 'colorbalance', 'colorchannelmixer', 'vibrance', 'negate', 'vignette', 'gblur', 'boxblur', 'unsharp', 'fade', 'xfade', 'overlay', 'concat',
  // audio
  'anull', 'asplit', 'atrim', 'asetpts', 'areverse', 'apad', 'afade', 'acrossfade', 'volume', 'atempo', 'aresample', 'amix', 'pan', 'loudnorm', 'dynaudnorm',
  'acompressor', 'alimiter', 'agate', 'silenceremove', 'equalizer', 'highpass', 'lowpass', 'bass', 'treble', 'aecho', 'chorus', 'flanger', 'aphaser', 'vibrato', 'tremolo',
]);
const FORBIDDEN_PARAM_KEYS = /^(file|filename|textfile|fontfile|f|path|url|commands|filename_or_url)$/i;
// A filter value that names a file: absolute/home path, any "..", a URL/protocol, or "dir/name.ext".
// (Plain expressions such as "iw/2" stay valid.)
export const PATH_LIKE_VALUE = /^(\/|~)|\.\.|^[a-z][a-z0-9+.-]*:\/\/|^(file|https?|tcp|udp|rtp|rtmp|ftp|pipe|concat|subfile|data|unix|crypto|cache|tee|fd):|[A-Za-z0-9_-]\/[A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,5}$/i;
const MAX_FILTER_LEN = 2000;
const MAX_OPTION_VALUE = 64;

export class CommandValidationError extends Error {
  constructor(errors, suggestions = {}) {
    super(errors.join('; '));
    this.errors = errors;
    this.suggestions = suggestions;
  }
}

/** Split a filter chain on top-level commas ("a=1,b=2" → ["a=1","b=2"]), honouring quotes and [] . */
function splitChain(chain) {
  const parts = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (const ch of chain) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

/** Parse "scale=1280:720" / "[0:v]scale=w=1280:h=720[out]" into { name, params[] } */
export function parseFilter(segment) {
  const stripped = segment.replace(/^(\[[^\]]*\])+/, '').replace(/(\[[^\]]*\])+$/, '');
  const eq = stripped.indexOf('=');
  const name = (eq === -1 ? stripped : stripped.slice(0, eq)).split('@')[0].trim();
  const params = eq === -1 ? [] : stripped.slice(eq + 1).split(':');
  return { name, params };
}

/** Validate a filter chain against discovered filters. Returns { errors, suggestions }. */
export async function validateFilterChain(chain, discovery = defaultDiscovery) {
  const errors = [];
  const suggestions = {};
  if (typeof chain !== 'string' || !chain.trim()) return { errors: ['Empty filter chain'], suggestions };
  if (chain.length > MAX_FILTER_LEN) return { errors: ['Filter chain too long'], suggestions };
  if (/[\n\r\0;]/.test(chain)) return { errors: ['Filter chain contains illegal characters'], suggestions };
  for (const segment of splitChain(chain)) {
    const { name, params } = parseFilter(segment);
    if (!FILTER_NAME.test(name)) { errors.push(`Invalid filter name "${name}"`); continue; }
    const installed = await discovery.hasFilter(name);
    if (!ALLOWED_FILTERS.has(name) || !installed) {
      // Known-but-unlisted filters (movie, drawtext, lut3d, …) are refused outright; typos get allowed suggestions.
      const known = installed || /^(a?movie|subtitles|ass|drawtext|lut3d|lut1d|haldclut|sendcmd|asendcmd|a?zmq|readeia608|a?metadata|frei0r|ocr)$/.test(name);
      errors.push(known && !ALLOWED_FILTERS.has(name) ? `Filter "${name}" is not allowed` : `Unknown filter "${name}"`);
      suggestions[name] = (await discovery.suggestFilters(name, 20)).filter(f => ALLOWED_FILTERS.has(f)).slice(0, 5);
      continue;
    }
    for (const p of params) {
      const [k, ...rest] = p.split('=');
      if (rest.length && FORBIDDEN_PARAM_KEYS.test(k.trim())) { errors.push(`Parameter "${k.trim()}" of filter "${name}" is not allowed`); continue; }
      const value = (rest.length ? rest.join('=') : k).trim().replace(/^['"]|['"]$/g, '');
      if (PATH_LIKE_VALUE.test(value)) errors.push(`Parameter value "${value.slice(0, 40)}" of filter "${name}" is not allowed`);
    }
  }
  return { errors, suggestions };
}

function isSafeInputPath(p) {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('-') && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !/[\0\n\r]/.test(p);
}

/**
 * Build a command from structured intent.
 * intent: { videoFilters?, audioFilters?, videoCodec?, audioCodec?, format?, startTime?, duration?,
 *           noAudio?, noVideo?, crf?, videoBitrate?, audioBitrate?, frameRate? }
 * Returns { args, command, outputPath, explanation, warnings }.
 */
export async function buildCommand({ inputPath, outputPath, intent = {} }, discovery = defaultDiscovery) {
  const errors = [];
  let suggestions = {};
  if (!isSafeInputPath(inputPath)) errors.push('Invalid input path');
  if (!isSafeInputPath(outputPath)) errors.push('Invalid output path');

  const num = (v, label) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) { errors.push(`${label} must be a non-negative number`); return undefined; }
    return String(n);
  };
  const bitrate = (v, label) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (!/^\d+(\.\d+)?[kKmM]?$/.test(String(v))) { errors.push(`${label} must look like 128k or 2M`); return undefined; }
    return String(v);
  };
  const codec = async (v, label) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (v !== 'copy' && (!CODEC_NAME.test(v) || v.length > MAX_OPTION_VALUE || !(await discovery.hasEncoder(v)))) {
      errors.push(`Unknown ${label} "${String(v).slice(0, 40)}"`);
      if (CODEC_NAME.test(v)) suggestions[v] = (await discovery.getEncodersMatching(v, 5)).map(e => e.name);
      return undefined;
    }
    return v;
  };

  const start = num(intent.startTime, 'startTime');
  const duration = num(intent.duration, 'duration');
  const crf = num(intent.crf, 'crf');
  const frameRate = num(intent.frameRate, 'frameRate');
  const vb = bitrate(intent.videoBitrate, 'videoBitrate');
  const ab = bitrate(intent.audioBitrate, 'audioBitrate');
  const vcodec = await codec(intent.videoCodec, 'video codec');
  const acodec = await codec(intent.audioCodec, 'audio codec');
  if (intent.format !== undefined && !/^[A-Za-z0-9_]{1,16}$/.test(String(intent.format))) errors.push('Invalid format');

  for (const [key, label] of [['videoFilters', 'video'], ['audioFilters', 'audio']]) {
    if (intent[key]) {
      const r = await validateFilterChain(intent[key], discovery);
      errors.push(...r.errors.map(e => `${label}: ${e}`));
      suggestions = { ...suggestions, ...r.suggestions };
    }
  }
  if (intent.noAudio && intent.noVideo) errors.push('Cannot disable both audio and video');
  if (errors.length) throw new CommandValidationError(errors, suggestions);

  const args = ['-hide_banner', '-y', '-nostdin'];
  const notes = [];
  if (start) { args.push('-ss', start); notes.push(`start at ${start}s`); }
  args.push('-i', inputPath);
  if (duration) { args.push('-t', duration); notes.push(`keep ${duration}s`); }
  if (intent.noVideo) { args.push('-vn'); notes.push('remove video'); }
  if (intent.noAudio) { args.push('-an'); notes.push('remove audio'); }
  if (intent.videoFilters) { args.push('-vf', intent.videoFilters); notes.push(`video filters: ${intent.videoFilters}`); }
  if (intent.audioFilters) { args.push('-af', intent.audioFilters); notes.push(`audio filters: ${intent.audioFilters}`); }
  if (vcodec) args.push('-c:v', vcodec);
  if (acodec) args.push('-c:a', acodec);
  if (crf) args.push('-crf', crf);
  if (vb) args.push('-b:v', vb);
  if (ab) args.push('-b:a', ab);
  if (frameRate) args.push('-r', frameRate);
  if (intent.format) args.push('-f', String(intent.format));
  args.push(outputPath);

  const quote = (a) => (/^[A-Za-z0-9_\-./:=,+]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
  return {
    args,
    command: `ffmpeg ${args.map(quote).join(' ')}`,
    outputPath,
    explanation: notes.length ? `This will ${notes.join(', ')}.` : 'This will re-encode the media with FFmpeg defaults.',
    warnings: [],
  };
}
