// Pure argv builders for the operations with more than one input or a side file: joining clips,
// adding an audio track, burning subtitles, extracting speech audio, and the generic run_ffmpeg
// command. Isomorphic: no DOM, no Node APIs.
import { OpArgsError } from './process.js';

const HEAD = ['-hide_banner', '-nostdin', '-y'];
const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
const threadCap = (threads) => (Number.isInteger(threads) && threads > 0 ? ['-threads', String(threads)] : []);

export const TRANSITIONS = [
  'crossfade', 'dissolve', 'fade', 'wipe_left', 'wipe_right', 'wipe_up', 'wipe_down',
  'slide_left', 'slide_right', 'slide_up', 'slide_down',
];
// xfade names for the transitions that overlap two clips.
const XFADE = {
  crossfade: 'fade', dissolve: 'dissolve', wipe_left: 'wipeleft', wipe_right: 'wiperight', wipe_up: 'wipeup',
  wipe_down: 'wipedown', slide_left: 'slideleft', slide_right: 'slideright', slide_up: 'slideup', slide_down: 'slidedown',
};

/**
 * Join clips with a transition. Every clip is first brought to the first clip's frame size and
 * 30 fps so clips from different cameras can be joined.
 * @param {{transition:string, duration?:number}} args
 * @param {{path:string, duration:number|null, width:number, height:number, hasAudio:boolean}[]} clips
 */
export function buildTransitionArgs({ transition, duration = 1 } = {}, clips = [], { output, threads } = {}) {
  if (!TRANSITIONS.includes(transition)) throw new OpArgsError(`Unknown transition type: ${transition}`);
  if (clips.length < 2) throw new OpArgsError('At least two video clips are required for transitions');
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0 || d > 30) throw new OpArgsError('duration must be between 0 and 30 seconds');
  const width = clips[0].width - (clips[0].width % 2);
  const height = clips[0].height - (clips[0].height % 2);
  const anyAudio = clips.some(c => c.hasAudio);
  const filters = [];

  clips.forEach((clip, i) => {
    const fade = transition === 'fade' && i > 0 ? `,fade=t=in:st=0:d=${d}` : '';
    filters.push(`[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p${fade}[v${i}]`);
    if (!anyAudio) return;
    const afade = transition === 'fade' && i > 0 ? `,afade=t=in:st=0:d=${d}` : '';
    if (clip.hasAudio) {
      filters.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo${afade}[a${i}]`);
    } else {
      // A silent clip gets silence of its own length so the audio stays in step.
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${clip.duration || 1}[a${i}]`);
    }
  });

  // xfade needs every clip to be longer than the overlap; otherwise the clips are just joined.
  const canOverlap = XFADE[transition] && clips.every(c => Number.isFinite(c.duration) && c.duration > d * 2);
  if (canOverlap) {
    let video = '[v0]';
    let audio = '[a0]';
    let offset = 0;
    clips.slice(1).forEach((clip, k) => {
      const i = k + 1;
      offset += clips[k].duration - d;
      const last = i === clips.length - 1;
      filters.push(`${video}[v${i}]xfade=transition=${XFADE[transition]}:duration=${d}:offset=${Math.round(offset * 1000) / 1000}${last ? '[v]' : `[x${i}]`}`);
      video = `[x${i}]`;
      if (anyAudio) {
        filters.push(`${audio}[a${i}]acrossfade=d=${d}${last ? '[a]' : `[y${i}]`}`);
        audio = `[y${i}]`;
      }
    });
  } else {
    filters.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[v]`);
    if (anyAudio) filters.push(`${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1[a]`);
  }

  return [
    ...HEAD, ...clips.flatMap(c => ['-i', c.path]),
    '-filter_complex', filters.join(';'), '-map', '[v]', ...(anyAudio ? ['-map', '[a]', '-c:a', 'aac'] : []),
    ...threadCap(threads), ...X264, '-movflags', '+faststart', output,
  ];
}

/** Replace the clip's audio with a new track, or mix the new track into it. */
export function buildAddAudioTrackArgs({ mode = 'replace', volume = 1 } = {}, { video, audio, output, sourceHasAudio }) {
  if (mode !== 'replace' && mode !== 'mix') throw new OpArgsError('Mode must be either "replace" or "mix"');
  if (typeof volume !== 'number' || Number.isNaN(volume) || volume < 0 || volume > 2) throw new OpArgsError('Volume must be between 0.0 and 2.0');
  const mix = mode === 'mix' && sourceHasAudio;
  const graph = mix
    ? `[1:a]volume=${volume}[newaudio];[0:a][newaudio]amix=inputs=2:duration=first:dropout_transition=2[outaudio]`
    : `[1:a]volume=${volume}[outaudio]`;
  return [...HEAD, '-i', video, '-i', audio, '-filter_complex', graph, '-map', '0:v:0', '-map', '[outaudio]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', output];
}

// ASS colour format is &HAABBGGRR. Alignment 2 = bottom centre, 8 = top centre.
function subtitleStyle(style, alignment, fontSize, fontName) {
  const base = `FontName=${fontName},FontSize=${fontSize},Alignment=${alignment},MarginV=28,Outline=1,Shadow=0,WrapStyle=2`;
  if (style === 'white_on_black') return `${base},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,Outline=0,Shadow=0`;
  if (style === 'yellow') return `${base},PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,Bold=1`;
  return `${base},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Bold=0`;
}

/**
 * Burn one SRT track, or two (the translation goes at the opposite edge). The wasm core has no
 * system fonts, so libass is pointed at `fontsDir`, which holds the bundled font `fontName`.
 */
export function buildBurnSubtitlesArgs({ style = 'default', position = 'bottom' } = {}, { input, output, threads, srtPath, translatedSrtPath, fontsDir, fontName }) {
  const main = position === 'top' ? 8 : 2;
  const sub = (file, align, size) => `subtitles=filename=${file}:fontsdir=${fontsDir}:force_style='${subtitleStyle(style, align, size, fontName)}'`;
  const filter = [sub(srtPath, main, 14), ...(translatedSrtPath ? [sub(translatedSrtPath, main === 2 ? 8 : 2, 12)] : [])].join(',');
  return [...HEAD, '-i', input, '-vf', filter, '-map', '0:v:0', '-map', '0:a?', ...threadCap(threads), ...X264, '-c:a', 'aac', '-movflags', '+faststart', output];
}

/** Burn a ready-made ASS script (lyric captions). */
export function buildBurnAssArgs({ input, output, threads, assPath, fontsDir }) {
  return [...HEAD, '-i', input, '-vf', `ass=filename=${assPath}:fontsdir=${fontsDir}`, '-map', '0:v:0', '-map', '0:a?', ...threadCap(threads), ...X264, '-c:a', 'copy', '-movflags', '+faststart', output];
}

/** Mono 16 kHz 16-bit WAV of the clip's audio: what speech recognition reads. */
export function buildSpeechAudioArgs({ input, output }) {
  return [...HEAD, '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', output];
}

/** One small JPEG frame at `at` seconds (a thumbnail for the model, opt-in). */
export function buildThumbnailArgs({ input, output, at = 0, width = 320 }) {
  return [...HEAD, '-ss', String(Math.max(0, Number(at) || 0)), '-i', input, '-frames:v', '1', '-update', '1', '-vf', `scale=${width}:-2`, '-q:v', '6', '-f', 'image2', output];
}

// ─── run_ffmpeg: a model-written command, validated before it runs ───────────

const MAX_COMMAND_LEN = 4000;
const INPUT_NAME = /^input(\.[A-Za-z0-9]{1,5})?$/;
const OUTPUT_NAME = /^output\.([A-Za-z0-9]{1,5})$/;
export const CLI_OUTPUT_FORMATS = ['mp4', 'mov', 'webm', 'mkv', 'gif', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'jpg', 'png'];
export const CLI_MIME_TYPES = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  jpg: 'image/jpeg', png: 'image/png',
};
// Muxers that write exactly the one output file (no tee/segment/hls).
const MUXERS = new Set(['mp4', 'mov', 'matroska', 'webm', 'gif', 'mp3', 'wav', 'ipod', 'adts', 'ogg', 'flac', 'image2', 'mjpeg', 'apng']);
const FORBIDDEN_VALUE = /^(\/|~|(file|https?|tcp|udp|rtp|rtmp|ftp|pipe|concat|subfile|data|unix|crypto|cache|tee|fd):)|\.\.\//i;
// Filters that read or write other files, or take commands from outside the command line.
const FORBIDDEN_FILTERS = new Set(['movie', 'amovie', 'subtitles', 'ass', 'drawtext', 'sendcmd', 'asendcmd', 'zmq', 'azmq', 'lut3d', 'haldclutsrc', 'frei0r', 'ladspa', 'lv2', 'coreimage', 'coreimagesrc']);
const STREAM_SPECIFIER = /^(:[A-Za-z0-9_?#]+)*$/;
const MAP_VALUE = /^(-?\d+(:[A-Za-z0-9_?#:]+)?\??|\[[A-Za-z0-9_]+\])$/;
const MAX_INPUTS = 4;
const FLAG = 0;
const VALUE = 1;
const FILTER = 2;
const CODEC = 3;
// Options the command may use, keyed by name without the stream specifier ("-c:v:1" is "c").
const OPTIONS = {
  y: FLAG, n: FLAG, hide_banner: FLAG, nostdin: FLAG, an: FLAG, vn: FLAG, sn: FLAG, dn: FLAG, shortest: FLAG, copyts: FLAG, start_at_zero: FLAG,
  ss: VALUE, t: VALUE, to: VALUE, sseof: VALUE, itsoffset: VALUE, stream_loop: VALUE, loop: VALUE,
  map: VALUE, map_metadata: VALUE, map_chapters: VALUE, disposition: VALUE, metadata: VALUE, tag: VALUE,
  frames: VALUE, vframes: VALUE, aframes: VALUE, r: VALUE, s: VALUE, aspect: VALUE, pix_fmt: VALUE, fps_mode: VALUE, vsync: VALUE,
  crf: VALUE, preset: VALUE, tune: VALUE, profile: VALUE, level: VALUE, b: VALUE, maxrate: VALUE, bufsize: VALUE, g: VALUE,
  q: VALUE, qscale: VALUE, ar: VALUE, ac: VALUE, movflags: VALUE, avoid_negative_ts: VALUE, compression_level: VALUE,
  id3v2_version: VALUE, write_id3v1: VALUE, update: VALUE,
  f: VALUE, i: VALUE,
  vf: FILTER, af: FILTER, filter: FILTER, filter_complex: FILTER, lavfi: FILTER,
  c: CODEC, codec: CODEC, vcodec: CODEC, acodec: CODEC,
};

export class CommandError extends OpArgsError {
  constructor(errors) {
    super(errors.join('; '), 'invalid_command');
    this.name = 'CommandError';
    this.errors = errors;
  }
}

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
    if (/[|&;<>`$()]/.test(ch)) throw new CommandError([`Shell syntax "${ch}" is not allowed; give a single ffmpeg command`]);
    cur += ch;
  }
  if (quote) throw new CommandError(['Unterminated quote']);
  if (started || cur) tokens.push(cur);
  return tokens;
}

// Filter names used in a graph: the word that starts each filter, after any [labels].
function filterNames(graph) {
  const names = [];
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < graph.length; i++) {
    const ch = graph[i];
    if (ch === '\\') { i++; atStart = false; continue; }
    if (ch === "'") { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch === ',' || ch === ';') { atStart = true; continue; }
    if (!atStart || /\s/.test(ch)) continue;
    if (ch === '[') { i = graph.indexOf(']', i); if (i < 0) break; continue; }
    const m = /^[A-Za-z0-9_]+/.exec(graph.slice(i));
    if (m) { names.push(m[0]); i += m[0].length - 1; }
    atStart = false;
  }
  return names;
}

/**
 * Validate a command whose only files are the placeholders "input" and "output.<ext>".
 * `catalog` ({ filters: string[], encoders: string[] }, from the capability catalog) is optional;
 * with it, unknown filters and encoders are rejected before FFmpeg starts.
 * @returns {{ outName:string, format:string, argv:(io:{input:string, output:string, threads?:number}) => string[] }}
 */
export function parseCliCommand(command, catalog = null) {
  if (typeof command !== 'string' || !command.trim()) throw new CommandError(['Empty command']);
  if (command.length > MAX_COMMAND_LEN || /[\n\r\0]/.test(command)) throw new CommandError(['Command must be a single line']);
  const tokens = tokenize(command.trim());
  if (tokens[0] === 'ffmpeg') tokens.shift();
  const knownFilters = catalog?.filters?.length ? new Set(catalog.filters) : null;
  const knownEncoders = catalog?.encoders?.length ? new Set(catalog.encoders) : null;

  const errors = [];
  const parts = []; // strings, or { input: true }
  let inputs = 0;
  let format = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-') || token === '-') {
      const m = token.match(OUTPUT_NAME);
      if (!m || !CLI_OUTPUT_FORMATS.includes(m[1].toLowerCase())) errors.push(`Unexpected "${token.slice(0, 40)}": the only output is output.<ext> (${CLI_OUTPUT_FORMATS.join(', ')})`);
      else if (i !== tokens.length - 1) errors.push('output.<ext> must be the last argument');
      else format = m[1].toLowerCase();
      continue;
    }
    const [name, ...spec] = token.slice(1).split(':');
    const kind = Object.hasOwn(OPTIONS, name) ? OPTIONS[name] : undefined;
    if (kind === undefined || !STREAM_SPECIFIER.test(spec.length ? `:${spec.join(':')}` : '')) { errors.push(`Option "${token.slice(0, 40)}" is not allowed`); continue; }
    if (['y', 'n', 'hide_banner', 'nostdin'].includes(name)) continue;
    if (kind === FLAG) { parts.push(token); continue; }

    const value = tokens[++i];
    if (value === undefined) { errors.push(`Option "${token}" needs a value`); continue; }
    if (name === 'i') {
      if (!INPUT_NAME.test(value)) errors.push(`Input "${value.slice(0, 40)}" is not available: the only input file is "input" (it may be given to -i more than once)`);
      else if (++inputs > MAX_INPUTS) errors.push(`At most ${MAX_INPUTS} inputs`);
      parts.push('-i', { input: true });
      continue;
    }
    if (kind === FILTER) {
      if (value.length > 2000) errors.push('Filter graph is too long');
      for (const filter of filterNames(value)) {
        if (FORBIDDEN_FILTERS.has(filter)) errors.push(`Filter "${filter}" is not allowed here`);
        else if (knownFilters && !knownFilters.has(filter)) errors.push(`Unknown filter "${filter}" (not in this FFmpeg build)`);
      }
    } else if (kind === CODEC) {
      if (value !== 'copy' && (!/^[A-Za-z0-9_-]{1,64}$/.test(value) || (knownEncoders && !knownEncoders.has(value)))) errors.push(`Unknown encoder "${value.slice(0, 40)}"`);
    } else if (name === 'f') {
      if (!MUXERS.has(value)) errors.push(`Format "${value.slice(0, 40)}" is not allowed`);
    } else if (name === 'map') {
      if (!MAP_VALUE.test(value)) errors.push(`Invalid -map value "${value.slice(0, 40)}"`);
    } else if (value.length > 200 || /[\0\n\r]/.test(value) || (name !== 'metadata' && FORBIDDEN_VALUE.test(value))) {
      errors.push(`Value "${value.slice(0, 40)}" of "${token}" is not allowed`);
    }
    parts.push(token, value);
  }

  if (!inputs) errors.push('The command must read "-i input"');
  if (!format && !errors.some(e => e.includes('output.<ext>'))) errors.push('The command must end with output.<ext>');
  if (errors.length) throw new CommandError(errors);

  return {
    outName: `out.${format}`,
    format,
    argv: ({ input, output, threads }) => [
      ...HEAD, ...parts.map(p => (typeof p === 'string' ? p : input)),
      // The mt core deadlocks when x264 picks its own thread count, so the cap is always set.
      ...threadCap(threads), output,
    ],
  };
}
