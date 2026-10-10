// Pure argv builders for the single-input operations (the old POST /api/process-video), ported
// from src/server/ffmpegOps.js so the browser core produces the same edits as the server.
// Isomorphic: no DOM, no Node APIs.
import { buildTrimArgs } from './trim.js';

export class OpArgsError extends Error {
  constructor(message, code = 'invalid_arguments') {
    super(message);
    this.name = 'OpArgsError';
    this.code = code;
  }
}

export const SUPPORTED_VIDEO_FORMATS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'];
export const SUPPORTED_VIDEO_CODECS = ['libx264', 'libx265', 'libvpx-vp9', 'auto'];
export const SUPPORTED_AUDIO_FORMATS = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'];
export const SUPPORTED_EXTRACT_FORMATS = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'];
export const SUPPORTED_AUDIO_BITRATES = ['64k', '128k', '192k', '256k', '320k'];
export const PHOTO_OUTPUT_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];
export const PHOTO_SUPPORTED_OPS = [
  'resize_video', 'crop_video', 'rotate_video', 'flip_video_horizontal', 'flip_video_vertical',
  'add_text', 'adjust_brightness', 'adjust_contrast', 'adjust_hue', 'adjust_saturation',
  'apply_color_filter', 'convert_image_format',
];
export const COLOR_FILTER_PRESETS = [
  'red', 'green', 'blue', 'yellow', 'cyan', 'magenta',
  'sepia', 'grayscale', 'black_and_white', 'invert', 'warm', 'cool', 'vintage',
];

const AUDIO_CONTENT_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', wma: 'audio/x-ms-wma',
};
const VIDEO_CONTENT_TYPES = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', ogv: 'video/ogg',
};
const IMAGE_OUTPUT = {
  jpeg: { ext: 'jpg', contentType: 'image/jpeg', codec: ['-c:v', 'mjpeg', '-q:v', '2'] },
  png: { ext: 'png', contentType: 'image/png', codec: ['-c:v', 'png'] },
  webp: { ext: 'webp', contentType: 'image/webp', codec: ['-c:v', 'libwebp', '-quality', '90'] },
};
// Encoders each container can hold; a stream copy into the others fails.
// WebM gets VP8: libvpx-vp9 crashes in the wasm core ("memory access out of bounds").
const CONTAINER_CODECS = {
  webm: { video: 'libvpx', audio: 'libvorbis' },
  ogv: { video: 'libtheora', audio: 'libvorbis' },
};
/** Encoders the browser core cannot run. Asking for one is reported as unsupported_in_browser. */
export const BROKEN_IN_BROWSER = { 'libvpx-vp9': 'the VP9 encoder crashes in the in-browser FFmpeg build' };
// Only x264 is safe on several threads in the multithreaded core (and only up to the host's cap).
// Measured on core-mt 0.12.10: libx265 and libtheora hang with more than one thread.
const VIDEO_ENCODER_ARGS = {
  libx264: (cap) => [...cap, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'],
  libx265: () => ['-threads', '1', '-c:v', 'libx265', '-preset', 'veryfast', '-x265-params', 'pools=none:frame-threads=1', '-pix_fmt', 'yuv420p'],
  libvpx: (cap) => [...cap, '-c:v', 'libvpx', '-crf', '20', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '5'],
  libtheora: () => ['-threads', '1', '-c:v', 'libtheora', '-q:v', '6'],
};
const AUDIO_ENCODERS = { ogg: 'libvorbis', wma: 'wmav2', m4a: 'aac', aac: 'aac', mp3: 'libmp3lame', flac: 'flac', wav: 'pcm_s16le' };

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];

function num(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new OpArgsError(`${field} must be a number`);
  if (n < min || n > max) throw new OpArgsError(`${field} must be between ${min} and ${max}`);
  return n;
}
const opt = (value, field, fallback, range) => (value === undefined || value === null || value === '' ? fallback : num(value, field, range));
const round4 = (n) => Math.round(n * 10000) / 10000;

// A "|"-separated list of numbers (chorus delays, compand points use "/" too).
function numberList(value, field, fallback) {
  const text = value === undefined || value === null || value === '' ? fallback : String(value);
  if (!/^-?[\d.]+([|/ ]-?[\d.]+)*$/.test(text)) throw new OpArgsError(`${field} must be numbers separated by "|"`);
  return text;
}

function safeColor(value, fallback = 'white') {
  if (value === undefined || value === null || value === '') return fallback;
  const color = String(value).trim();
  if (!/^[#A-Za-z0-9@.]{1,32}$/.test(color)) throw new OpArgsError('color must be a color name or hex value (e.g. white, #ff0000)');
  return color;
}

// Two-level escaping for drawtext text (no surrounding quotes):
// 1) option-value level: \ ' :   2) filtergraph level: \ ' [ ] , ;
// Combined with expansion=none so "%" is literal.
export function escapeDrawtext(text) {
  const optionLevel = String(text).replace(/\r/g, '').replace(/[\\':]/g, '\\$&');
  return optionLevel.replace(/[\\'[\],;]/g, '\\$&');
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const SEPIA_MATRIX = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
const GRAY_MATRIX = [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114];
const tint = (keep) => [keep[0] ? 1 : 0.4, 0, 0, 0, keep[1] ? 1 : 0.4, 0, 0, 0, keep[2] ? 1 : 0.4];
const COLOR_MATRICES = {
  red: tint([true, false, false]), green: tint([false, true, false]), blue: tint([false, false, true]),
  yellow: tint([true, true, false]), cyan: tint([false, true, true]), magenta: tint([true, false, true]),
  sepia: SEPIA_MATRIX, grayscale: GRAY_MATRIX, black_and_white: GRAY_MATRIX,
};

export function buildColorFilter(args = {}) {
  const raw = String(args.filter ?? args.color ?? args.preset ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const preset = raw === 'gray' || raw === 'greyscale' || raw === 'monochrome' ? 'grayscale'
    : raw === 'b&w' || raw === 'bw' ? 'black_and_white'
      : raw === 'negative' ? 'invert'
        : raw;
  if (!COLOR_FILTER_PRESETS.includes(preset)) throw new OpArgsError(`filter must be one of: ${COLOR_FILTER_PRESETS.join(', ')}`);
  const intensity = opt(args.intensity, 'intensity', 1, { min: 0, max: 1 });
  if (preset === 'invert') return 'negate';
  if (preset === 'vintage') return 'curves=preset=vintage';
  if (preset === 'warm' || preset === 'cool') {
    const sign = preset === 'warm' ? 1 : -1;
    const s = round4(0.3 * intensity * sign);
    const m = round4(0.15 * intensity * sign);
    return `colorbalance=rs=${s}:bs=${-s}:rm=${m}:bm=${-m}`;
  }
  const mixed = COLOR_MATRICES[preset].map((v, i) => round4(IDENTITY_MATRIX[i] * (1 - intensity) + v * intensity));
  const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
  return `colorchannelmixer=${names.map((n, i) => `${n}=${mixed[i]}`).join(':')}`;
}

/** The video filter for a frame-only operation, or null when the operation is not one. */
export function buildVisualFilter(operation, args = {}, { isPhoto = false, fontFile } = {}) {
  switch (operation) {
    case 'resize_video': {
      const width = Math.round(num(args.width, 'width', { min: -2, max: 16384 }));
      const height = Math.round(num(args.height, 'height', { min: -2, max: 16384 }));
      if (width === 0 || height === 0 || (width < 0 && height < 0)) {
        throw new OpArgsError('width and height must be positive (one of them may be -1 to keep aspect ratio)');
      }
      // libx264 needs even dimensions; a photo keeps the exact size asked for.
      const even = (n) => (n > 0 && !isPhoto ? n - (n % 2) : n === -1 && !isPhoto ? -2 : n);
      return `scale=${even(width)}:${even(height)}`;
    }
    case 'crop_video': {
      const width = Math.round(num(args.width, 'width', { min: 1, max: 16384 }));
      const height = Math.round(num(args.height, 'height', { min: 1, max: 16384 }));
      const x = Math.round(opt(args.x, 'x', 0, { min: 0, max: 16384 }));
      const y = Math.round(opt(args.y, 'y', 0, { min: 0, max: 16384 }));
      const crop = `crop=${width}:${height}:${x}:${y}`;
      return isPhoto ? crop : `${crop},scale=trunc(iw/2)*2:trunc(ih/2)*2`;
    }
    case 'rotate_video': {
      const angle = num(args.angle, 'angle', { min: -3600, max: 3600 });
      const normalized = ((angle % 360) + 360) % 360;
      if (isPhoto) {
        // Lossless-looking quarter turns for photos (canvas swaps width/height).
        if (normalized === 0) return 'null';
        if (normalized === 90) return 'transpose=clock';
        if (normalized === 180) return 'hflip,vflip';
        if (normalized === 270) return 'transpose=cclock';
        const rad = `${round4(angle)}*PI/180`;
        return `rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=black`;
      }
      return `rotate=${angle}*PI/180`;
    }
    case 'flip_video_horizontal':
      return 'hflip';
    case 'flip_video_vertical':
      return 'vflip';
    case 'add_text': {
      if (typeof args.text !== 'string' || !args.text.trim()) throw new OpArgsError('text is required for add_text');
      if (!fontFile) throw new OpArgsError('add_text needs a font file');
      const x = Math.round(opt(args.x, 'x', 10, { min: 0, max: 16384 }));
      const y = Math.round(opt(args.y, 'y', 10, { min: 0, max: 16384 }));
      const fontsize = Math.round(opt(args.fontsize, 'fontsize', 24, { min: 1, max: 1000 }));
      // The wasm core has no fontconfig, so drawtext is given the bundled font file.
      return `drawtext=fontfile=${fontFile}:expansion=none:text=${escapeDrawtext(args.text)}:x=${x}:y=${y}:fontsize=${fontsize}:fontcolor=${safeColor(args.color)}`;
    }
    case 'adjust_brightness':
      return `eq=brightness=${num(args.brightness, 'brightness', { min: -1, max: 1 })}`;
    case 'adjust_contrast':
      return `eq=contrast=${num(args.contrast, 'contrast', { min: 0, max: 3 })}`;
    case 'adjust_hue':
      return `hue=h=${num(args.degrees, 'degrees', { min: -360, max: 360 })}`;
    case 'adjust_saturation':
      return `eq=saturation=${num(args.saturation, 'saturation', { min: 0, max: 3 })}`;
    case 'apply_color_filter':
      return buildColorFilter(args);
    case 'convert_image_format':
      return 'null';
    default:
      return null;
  }
}

// atempo accepts 0.5 to 2.0 per instance, so other speeds are chained.
function atempoChain(speed) {
  const filters = [];
  let remaining = speed;
  while (remaining < 0.5) { filters.push('atempo=0.5'); remaining *= 2; }
  while (remaining > 2.0) { filters.push('atempo=2.0'); remaining /= 2; }
  if (remaining !== 1.0 || !filters.length) filters.push(`atempo=${round4(remaining)}`);
  return filters.join(',');
}

/** True when audio_fade needs the clip length to place the fade (fade-out without `start`). */
export function audioFadeNeedsDuration(args = {}) {
  return args.type !== 'in' && (args.start === undefined || args.start === null);
}

export function buildAudioFadeFilter(args = {}, { duration: clipDuration } = {}) {
  const duration = num(args.duration, 'audio_fade duration');
  if (duration <= 0) throw new OpArgsError('audio_fade duration must be a positive number of seconds');
  const fadeType = args.type === 'in' ? 'in' : 'out';
  let start = args.start === undefined || args.start === null ? null : num(args.start, 'audio_fade start', { min: 0 });
  if (start === null) {
    if (fadeType === 'in') start = 0;
    else if (Number.isFinite(clipDuration) && clipDuration > 0) start = Math.max(0, Math.round((clipDuration - duration) * 1000) / 1000);
    else throw new OpArgsError('audio_fade start is required for a fade-out when the clip duration cannot be determined');
  }
  return `afade=t=${fadeType}:st=${start}:d=${duration}`;
}

/** The audio filter for an audio-only operation, or null when the operation is not one. */
export function buildAudioFilter(operation, a = {}, { duration, inBrowser = true } = {}) {
  switch (operation) {
    case 'adjust_volume':
      return `volume=${num(a.volume, 'volume', { min: 0, max: 100 })}`;
    case 'audio_fade':
      return buildAudioFadeFilter(a, { duration });
    case 'highpass_filter':
      return `highpass=f=${num(a.frequency, 'frequency', { min: 1, max: 96000 })}`;
    case 'lowpass_filter':
      return `lowpass=f=${num(a.frequency, 'frequency', { min: 1, max: 96000 })}`;
    case 'echo_effect':
      return `aecho=1.0:0.7:${num(a.delay, 'delay', { min: 0.1, max: 90000 })}:${num(a.decay, 'decay', { min: 0.01, max: 1 })}`;
    case 'bass_adjustment':
      return `bass=g=${num(a.gain, 'gain', { min: -30, max: 30 })}`;
    case 'treble_adjustment':
      return `treble=g=${num(a.gain, 'gain', { min: -30, max: 30 })}`;
    case 'equalizer':
      return `equalizer=f=${num(a.frequency, 'frequency', { min: 1, max: 96000 })}:width_type=h:width=${opt(a.width, 'width', 200, { min: 1, max: 96000 })}:g=${num(a.gain, 'gain', { min: -30, max: 30 })}`;
    case 'normalize_audio':
      return `loudnorm=I=${opt(a.target, 'target', -16, { min: -70, max: -5 })}:TP=-1.5:LRA=11`;
    case 'delay_audio': {
      const delay = num(a.delay, 'delay', { min: 0, max: 600000 });
      return `adelay=${delay}|${delay}`;
    }
    case 'audio_chorus':
      return `chorus=${opt(a.in_gain, 'in_gain', 0.5, { min: 0, max: 1 })}:${opt(a.out_gain, 'out_gain', 0.9, { min: 0, max: 1 })}:${numberList(a.delays, 'delays', '40|60|80')}:${numberList(a.decays, 'decays', '0.4|0.5|0.6')}:${numberList(a.speeds, 'speeds', '0.5|0.6|0.7')}:${numberList(a.depths, 'depths', '0.25|0.4|0.35')}`;
    case 'audio_flanger':
      return `flanger=delay=${opt(a.delay, 'delay', 0, { min: 0, max: 30 })}:depth=${opt(a.depth, 'depth', 2, { min: 0, max: 10 })}:regen=${opt(a.regen, 'regen', 0, { min: -95, max: 95 })}:width=${opt(a.width, 'width', 71, { min: 0, max: 100 })}:speed=${opt(a.speed, 'speed', 0.5, { min: 0.1, max: 10 })}`;
    case 'audio_phaser':
      return `aphaser=in_gain=${opt(a.in_gain, 'in_gain', 0.4, { min: 0, max: 1 })}:out_gain=${opt(a.out_gain, 'out_gain', 0.74, { min: 0, max: 1e9 })}:delay=${opt(a.delay, 'delay', 3, { min: 0, max: 5 })}:decay=${opt(a.decay, 'decay', 0.4, { min: 0, max: 0.99 })}:speed=${opt(a.speed, 'speed', 0.5, { min: 0.1, max: 2 })}`;
    case 'audio_vibrato':
      // In the wasm core the vibrato filter reads uninitialised memory and fails unpredictably
      // (NaN samples, or the encoder aborting), so the browser does not attempt it.
      if (inBrowser) throw new OpArgsError('The vibrato effect is unreliable in the in-browser FFmpeg build.', 'unsupported_in_browser');
      return `vibrato=f=${opt(a.frequency, 'frequency', 5, { min: 0.1, max: 20000 })}:d=${opt(a.depth, 'depth', 0.5, { min: 0, max: 1 })}`;
    case 'audio_tremolo':
      return `tremolo=f=${opt(a.frequency, 'frequency', 5, { min: 0.1, max: 20000 })}:d=${opt(a.depth, 'depth', 0.5, { min: 0, max: 1 })}`;
    case 'audio_compressor':
      return `acompressor=threshold=${opt(a.threshold, 'threshold', 0, { min: -60, max: 0 })}dB:ratio=${opt(a.ratio, 'ratio', 4, { min: 1, max: 20 })}:attack=${opt(a.attack, 'attack', 20, { min: 0.01, max: 2000 })}:release=${opt(a.release, 'release', 250, { min: 0.01, max: 9000 })}`;
    case 'audio_dynamic_normalize':
      if ((a.mode ?? 'dynaudnorm') === 'compand') {
        return `compand=attacks=${opt(a.attacks, 'attacks', 0.3, { min: 0, max: 100 })}:decays=${opt(a.decays, 'decays', 0.8, { min: 0, max: 100 })}:points=${numberList(a.points, 'points', '-70/-70|-40/-30|-20/-15|0/-12')}:gain=${opt(a.gain, 'gain', 3, { min: -900, max: 900 })}`;
      }
      return `dynaudnorm=f=${opt(a.frame_length, 'frame_length', 150, { min: 10, max: 8000 })}:g=${opt(a.gaussian_size, 'gaussian_size', 31, { min: 3, max: 301 })}`;
    case 'audio_gate':
      return `agate=threshold=${opt(a.threshold, 'threshold', -50, { min: -100, max: 0 })}dB:ratio=${opt(a.ratio, 'ratio', 2, { min: 1, max: 9000 })}:attack=${opt(a.attack, 'attack', 20, { min: 0.01, max: 9000 })}:release=${opt(a.release, 'release', 250, { min: 0.01, max: 9000 })}`;
    case 'audio_stereo_widen':
      return `stereowiden=delay=${opt(a.delay, 'delay', 20, { min: 1, max: 100 })}:feedback=${opt(a.feedback, 'feedback', 0.3, { min: 0, max: 0.9 })}:crossfeed=${opt(a.crossfeed, 'crossfeed', 0.3, { min: 0, max: 0.8 })}`;
    case 'audio_reverse':
      return 'areverse';
    case 'audio_limiter':
      return `alimiter=level_in=1:level_out=1:limit=${opt(a.level, 'level', 1.0, { min: 0.0625, max: 1 })}:attack=${opt(a.attack, 'attack', 5, { min: 0.1, max: 80 })}:release=${opt(a.release, 'release', 50, { min: 1, max: 8000 })}`;
    case 'audio_silence_remove':
      return `silenceremove=start_periods=1:start_threshold=${opt(a.start_threshold, 'start_threshold', -50, { min: -120, max: 0 })}dB:start_duration=${opt(a.start_duration, 'start_duration', 0.5, { min: 0, max: 3600 })}:stop_periods=-1:stop_threshold=${opt(a.stop_threshold, 'stop_threshold', -50, { min: -120, max: 0 })}dB:stop_duration=${opt(a.stop_duration, 'stop_duration', 0.5, { min: 0, max: 3600 })}`;
    case 'audio_pan': {
      const pan = num(a.pan, 'pan', { min: -1, max: 1 });
      const left = pan > 0 ? round4(1 - pan) : 1;
      const right = pan < 0 ? round4(1 + pan) : 1;
      return `pan=stereo|c0=${left}*c0|c1=${right}*c1`;
    }
    default:
      return null;
  }
}

/**
 * Output file name and Content-Type for an operation. Throws OpArgsError (unsupported_for_photo)
 * when the operation cannot run on a photo.
 */
export function resolveOutput(operation, args = {}, { isPhoto = false, imageFormat } = {}) {
  if (isPhoto) {
    if (!PHOTO_SUPPORTED_OPS.includes(operation)) {
      throw new OpArgsError(`"${operation}" is not supported for photos. Supported photo operations: ${PHOTO_SUPPORTED_OPS.join(', ')}`, 'unsupported_for_photo');
    }
    let target = imageFormat;
    if (operation === 'convert_image_format') {
      const requested = String(args.format || '').toLowerCase();
      if (!PHOTO_OUTPUT_FORMATS.includes(requested)) throw new OpArgsError(`format must be one of: ${PHOTO_OUTPUT_FORMATS.join(', ')}`);
      target = requested === 'jpg' ? 'jpeg' : requested;
    }
    if (!IMAGE_OUTPUT[target]) target = imageFormat === 'heic' ? 'jpeg' : 'png';
    return { outName: `out.${IMAGE_OUTPUT[target].ext}`, contentType: IMAGE_OUTPUT[target].contentType, imageTarget: target };
  }
  if (operation === 'convert_image_format') {
    throw new OpArgsError('convert_image_format only applies to photos; use convert_video_format for videos');
  }
  if (operation === 'convert_video_format') {
    if (!SUPPORTED_VIDEO_FORMATS.includes(args.format)) throw new OpArgsError(`format must be one of: ${SUPPORTED_VIDEO_FORMATS.join(', ')}`);
    return { outName: `out.${args.format}`, contentType: VIDEO_CONTENT_TYPES[args.format] };
  }
  if (operation === 'convert_audio_format' || operation === 'extract_audio') {
    const allowed = operation === 'extract_audio' ? SUPPORTED_EXTRACT_FORMATS : SUPPORTED_AUDIO_FORMATS;
    const format = args.format || (operation === 'extract_audio' ? 'mp3' : undefined);
    if (!allowed.includes(format)) throw new OpArgsError(`format must be one of: ${allowed.join(', ')}`);
    return { outName: `out.${format}`, contentType: AUDIO_CONTENT_TYPES[format] };
  }
  return { outName: 'out.mp4', contentType: 'video/mp4' };
}

/**
 * ffmpeg argv (no leading "ffmpeg") for one operation.
 * @param {{input:string, output:string, threads?:number, isPhoto?:boolean, imageFormat?:string,
 *   duration?:number, fontFile?:string}} io
 */
export function buildProcessArgs(operation, args = {}, io = {}) {
  const { input, output, threads, isPhoto = false, imageFormat, duration, fontFile } = io;
  if (!input || !output) throw new OpArgsError('input and output paths are required');
  const head = ['-hide_banner', '-nostdin', '-y'];
  const cap = Number.isInteger(threads) && threads > 0 ? ['-threads', String(threads)] : [];

  if (isPhoto) {
    const { imageTarget } = resolveOutput(operation, args, { isPhoto, imageFormat });
    const filter = buildVisualFilter(operation, args, { isPhoto: true, fontFile });
    return [
      ...head, '-i', input,
      ...(filter && filter !== 'null' ? ['-vf', filter] : []),
      '-map', '0:v:0', '-frames:v', '1', '-update', '1', ...IMAGE_OUTPUT[imageTarget].codec, '-an', '-f', 'image2', output,
    ];
  }
  resolveOutput(operation, args); // validates the conversion formats

  if (operation === 'trim_video') return buildTrimArgs(args, { input, output, threads });

  if (operation === 'speed_video') {
    const speed = num(args.speed, 'speed', { min: 0.05, max: 100 });
    return [...head, '-i', input, '-vf', `setpts=PTS/${speed}`, '-af', atempoChain(speed), ...cap, ...X264, '-c:a', 'aac', '-movflags', '+faststart', output];
  }
  if (operation === 'fade_transition') {
    const fade = opt(args.duration, 'duration', 1, { min: 0.01, max: 600 });
    const total = Number(args.totalDuration ?? duration);
    // Without a known clip length only a fade-in can be placed safely.
    const filter = Number.isFinite(total) && total > fade
      ? `fade=t=in:st=0:d=${fade},fade=t=out:st=${round4(total - fade)}:d=${fade}`
      : `fade=t=in:st=0:d=${fade}`;
    return [...head, '-i', input, '-vf', filter, ...cap, ...X264, '-c:a', 'copy', '-movflags', '+faststart', output];
  }
  if (operation === 'convert_video_format') {
    if (args.codec && !SUPPORTED_VIDEO_CODECS.includes(args.codec)) throw new OpArgsError(`codec must be one of: ${SUPPORTED_VIDEO_CODECS.join(', ')}`);
    const container = CONTAINER_CODECS[args.format];
    const codec = args.codec && args.codec !== 'auto' ? args.codec : container?.video;
    if (!codec) return [...head, '-i', input, '-c', 'copy', output];
    if (BROKEN_IN_BROWSER[codec]) throw new OpArgsError(`${codec} cannot be used here: ${BROKEN_IN_BROWSER[codec]}.`, 'unsupported_in_browser');
    // Apple players only open H.265 in MP4/MOV when it is tagged hvc1.
    const tag = codec === 'libx265' && (args.format === 'mp4' || args.format === 'mov') ? ['-tag:v', 'hvc1'] : [];
    return [...head, '-i', input, ...VIDEO_ENCODER_ARGS[codec](cap), ...tag, '-c:a', container?.audio || 'copy', output];
  }
  if (operation === 'convert_audio_format' || operation === 'extract_audio') {
    const format = args.format || 'mp3';
    const bitrate = args.bitrate || '192k';
    if (!SUPPORTED_AUDIO_BITRATES.includes(bitrate)) throw new OpArgsError(`bitrate must be one of: ${SUPPORTED_AUDIO_BITRATES.join(', ')}`);
    const lossless = format === 'wav' || format === 'flac';
    return [...head, '-i', input, '-vn', '-c:a', AUDIO_ENCODERS[format], ...(lossless ? [] : ['-b:a', bitrate]), output];
  }

  const audioFilter = buildAudioFilter(operation, args, { duration });
  if (audioFilter) return [...head, '-i', input, '-af', audioFilter, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output];

  const videoFilter = buildVisualFilter(operation, args, { fontFile });
  if (videoFilter) return [...head, '-i', input, '-vf', videoFilter, ...cap, ...X264, '-c:a', 'copy', '-movflags', '+faststart', output];

  throw new OpArgsError(`Unknown operation: ${operation}`, 'unknown_operation');
}
