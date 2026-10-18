// Turns a model-written FFmpeg CLI string into a validated args array (never executed through a shell).
import { discovery as defaultDiscovery } from './ffmpeg-discovery.js';
import { validateFilterChain, CommandValidationError } from './ffmpeg-commander.js';

const MAX_COMMAND_LEN = 4000;
export const INPUT_PLACEHOLDER = 'input';
// The model may write the input as "input" or "input.<ext>"; either means the uploaded file.
const INPUT_NAME = /^input(\.[A-Za-z0-9]{1,5})?$/;
const OUTPUT_NAME = /^output\.([A-Za-z0-9]{1,5})$/;
export const CLI_OUTPUT_FORMATS = new Set(['mp4', 'mov', 'webm', 'mkv', 'gif', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'jpg', 'png']);
// Muxers that write exactly the one output file (no tee/segment/hls, no lavfi input device).
const MUXERS = new Set(['mp4', 'mov', 'matroska', 'webm', 'gif', 'mp3', 'wav', 'ipod', 'adts', 'ogg', 'flac', 'image2', 'mjpeg', 'apng']);
const FORBIDDEN_VALUE = /^(\/|~|(file|https?|tcp|udp|rtp|rtmp|ftp|pipe|concat|subfile|data|unix|crypto|cache|tee|fd):)|\.\.\//i;
const STREAM_SPECIFIER = /^(:[A-Za-z0-9_?#]+)*$/;
const MAP_VALUE = /^(-?\d+(:[A-Za-z0-9_?#:]+)?\??|\[[A-Za-z0-9_]+\])$/;
const MAX_INPUTS = 4;

const FLAG = 0;
const VALUE = 1;
const FILTER = 2;
const CODEC = 3;
// Options the fallback may use, keyed by name without the stream specifier ("-c:v:1" → "c").
const OPTIONS = {
  y: FLAG, n: FLAG, hide_banner: FLAG, nostdin: FLAG, an: FLAG, vn: FLAG, sn: FLAG, dn: FLAG, shortest: FLAG, copyts: FLAG, start_at_zero: FLAG,
  ss: VALUE, t: VALUE, to: VALUE, sseof: VALUE, itsoffset: VALUE, stream_loop: VALUE, loop: VALUE,
  map: VALUE, map_metadata: VALUE, map_chapters: VALUE, disposition: VALUE, metadata: VALUE, tag: VALUE,
  frames: VALUE, vframes: VALUE, aframes: VALUE, r: VALUE, s: VALUE, aspect: VALUE, pix_fmt: VALUE, fps_mode: VALUE, vsync: VALUE,
  crf: VALUE, preset: VALUE, tune: VALUE, profile: VALUE, level: VALUE, b: VALUE, maxrate: VALUE, bufsize: VALUE, g: VALUE,
  q: VALUE, qscale: VALUE, ar: VALUE, ac: VALUE, movflags: VALUE, avoid_negative_ts: VALUE, compression_level: VALUE,
  id3v2_version: VALUE, write_id3v1: VALUE, threads: VALUE, update: VALUE,
  f: VALUE, i: VALUE,
  vf: FILTER, af: FILTER, filter: FILTER, filter_complex: FILTER, lavfi: FILTER,
  c: CODEC, codec: CODEC, vcodec: CODEC, acodec: CODEC,
};

/** Shell-style split honouring quotes; unquoted shell syntax (pipes, redirects, substitution) is an error. */
export function tokenize(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && /["\\$`]/.test(command[i + 1] || '')) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { cur += command[++i]; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || cur) tokens.push(cur);
      cur = '';
      started = false;
      continue;
    }
    if (/[|&;<>`$()]/.test(ch)) throw new CommandValidationError([`Shell syntax "${ch}" is not allowed; reply with a single ffmpeg command`]);
    cur += ch;
  }
  if (quote) throw new CommandValidationError(['Unterminated quote']);
  if (started || cur) tokens.push(cur);
  return tokens;
}

/** Pull the command out of a model reply (code fences, a leading "$", prose around a single ffmpeg line). */
export function extractCommand(reply) {
  const text = String(reply || '').replace(/```[a-z]*\n?/gi, '').replace(/\\\r?\n/g, ' ');
  const lines = text.split(/\r?\n/).map(l => l.trim().replace(/^\$\s*/, '').replace(/^`|`$/g, '')).filter(Boolean);
  if (!lines.length || lines.every(l => /^none\b/i.test(l))) return null;
  return lines.find(l => /^ffmpeg\s/.test(l)) || null;
}

/**
 * Validate a CLI string whose only files are the placeholders "input" and "output.<ext>",
 * and swap in the real paths. Returns { args, command, outputPath, outputFormat };
 * throws CommandValidationError with messages the model can correct from.
 */
export async function parseCliString(command, { inputPath, outputPathFor }, discovery = defaultDiscovery) {
  if (typeof command !== 'string' || !command.trim()) throw new CommandValidationError(['Empty command']);
  if (command.length > MAX_COMMAND_LEN || /[\n\r\0]/.test(command)) throw new CommandValidationError(['Command must be a single line']);
  const tokens = tokenize(command.trim());
  if (tokens[0] === 'ffmpeg') tokens.shift();

  const errors = [];
  let suggestions = {};
  const args = ['-hide_banner', '-y', '-nostdin'];
  let inputs = 0;
  let outputFormat = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-') || token === '-') {
      const m = token.match(OUTPUT_NAME);
      if (!m || !CLI_OUTPUT_FORMATS.has(m[1].toLowerCase())) errors.push(`Unexpected "${token.slice(0, 40)}": the only output is output.<ext> (${[...CLI_OUTPUT_FORMATS].join(', ')})`);
      else if (i !== tokens.length - 1) errors.push('output.<ext> must be the last argument');
      else outputFormat = m[1].toLowerCase();
      continue;
    }
    const [name, ...spec] = token.slice(1).split(':');
    const kind = Object.hasOwn(OPTIONS, name) ? OPTIONS[name] : undefined;
    if (kind === undefined || !STREAM_SPECIFIER.test(spec.length ? `:${spec.join(':')}` : '')) { errors.push(`Option "${token.slice(0, 40)}" is not allowed`); continue; }
    if (['y', 'n', 'hide_banner', 'nostdin'].includes(name)) continue;
    if (kind === FLAG) { args.push(token); continue; }

    const value = tokens[++i];
    if (value === undefined) { errors.push(`Option "${token}" needs a value`); continue; }
    if (name === 'i') {
      if (!INPUT_NAME.test(value)) errors.push(`Input "${value.slice(0, 40)}" is not available: the only input file is "${INPUT_PLACEHOLDER}" (it may be given to -i more than once)`);
      else if (++inputs > MAX_INPUTS) errors.push(`At most ${MAX_INPUTS} inputs`);
      args.push('-i', inputPath);
      continue;
    }
    if (kind === FILTER) {
      // A filter graph is chains separated by ";"; each chain is checked against the installed filters.
      for (const chain of value.split(';').filter(c => c.trim())) {
        const r = await validateFilterChain(chain, discovery);
        errors.push(...r.errors);
        suggestions = { ...suggestions, ...r.suggestions };
      }
    } else if (kind === CODEC) {
      if (value !== 'copy' && !(/^[A-Za-z0-9_]{1,64}$/.test(value) && await discovery.hasEncoder(value))) {
        errors.push(`Unknown encoder "${value.slice(0, 40)}"`);
        if (/^[A-Za-z0-9_]+$/.test(value)) suggestions[value] = (await discovery.getEncodersMatching(value, 5)).map(e => e.name);
      }
    } else if (name === 'f') {
      if (!MUXERS.has(value)) errors.push(`Format "${value.slice(0, 40)}" is not allowed`);
    } else if (name === 'map') {
      if (!MAP_VALUE.test(value)) errors.push(`Invalid -map value "${value.slice(0, 40)}"`);
    } else if (value.length > 200 || /[\0\n\r]/.test(value) || (name !== 'metadata' && FORBIDDEN_VALUE.test(value))) {
      errors.push(`Value "${value.slice(0, 40)}" of "${token}" is not allowed`);
    }
    args.push(token, value);
  }

  if (!inputs) errors.push(`The command must read "-i ${INPUT_PLACEHOLDER}"`);
  if (!outputFormat && !errors.some(e => e.includes('output.<ext>'))) errors.push('The command must end with output.<ext>');
  if (errors.length) throw new CommandValidationError(errors, suggestions);

  const outputPath = outputPathFor(outputFormat);
  args.push(outputPath);
  return { args, command: command.trim(), outputPath, outputFormat };
}

// ─── Asking inference for the command ────────────────────────────────────────

const MAX_REQUEST_LEN = 1000;
const MAX_ATTEMPTS = 3;
const MAX_ERROR_LEN = 1500;

export const CLI_STRING_SYSTEM_PROMPT =
  'You translate a media-editing request into ONE FFmpeg command for the file the user is editing. ' +
  `The only input file is named "${INPUT_PLACEHOLDER}" (pass it to -i more than once if the command needs it twice, e.g. to grab a frame from it). ` +
  `Write exactly one output, named output.<ext>, as the last argument; <ext> is one of ${[...CLI_OUTPUT_FORMATS].join(', ')}. ` +
  'No other files, URLs, fonts or devices exist, and no shell syntax (pipes, &&, redirects, variables) is available. ' +
  'Reply with only the command on a single line: no explanation and no code fence. ' +
  'If the message is not a request to edit or convert the media, or it cannot be done with FFmpeg and this one file, reply with exactly NONE.';

/**
 * Messages for "what is the ffmpeg CLI string for <request>?". `attempts` are earlier commands
 * with the validation error or FFmpeg stderr they produced, so the model can correct itself.
 */
export function buildCliStringMessages(request, attempts = []) {
  const messages = [
    { role: 'system', content: CLI_STRING_SYSTEM_PROMPT },
    { role: 'user', content: `What is the ffmpeg CLI string for: "${String(request).slice(0, MAX_REQUEST_LEN)}"` },
  ];
  for (const attempt of (Array.isArray(attempts) ? attempts : []).slice(-MAX_ATTEMPTS)) {
    if (typeof attempt?.command !== 'string' || !attempt.command.trim()) continue;
    messages.push({ role: 'assistant', content: attempt.command.slice(0, MAX_COMMAND_LEN) });
    messages.push({ role: 'user', content: `That command failed:\n${String(attempt.error || 'unknown error').slice(-MAX_ERROR_LEN)}\nReply with a corrected command, or NONE if it cannot be done.` });
  }
  return messages;
}
