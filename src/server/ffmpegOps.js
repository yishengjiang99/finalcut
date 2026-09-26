import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { getMimeTypeToFormat } from './utils.js';
import { IMAGE_FORMATS, MEDIA_TYPE_IMAGE, MEDIA_TYPE_VIDEO } from './mediaType.js';
import { IOS_GROUPED_TOOL_MEDIA_TYPES, isIosGroupedTool } from './iosGroupedTools.js';

const AUDIO_CONTENT_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', wma: 'audio/x-ms-wma',
};
const VIDEO_CONTENT_TYPES = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', ogv: 'video/ogg',
};

/** Stable machine-readable error codes for clients (iOS matches on these, not on text). */
export const ERROR_CODES = {
  UNSUPPORTED_FOR_PHOTO: 'unsupported_for_photo',
  INVALID_ARGUMENTS: 'invalid_arguments',
  UNSUPPORTED_IMAGE_FORMAT: 'unsupported_image_format',
  NOT_AVAILABLE_ON_SERVER: 'not_available_on_server',
};

export class OpValidationError extends Error {
  /**
   * @param {string} message human-readable message (kept for backwards compatibility)
   * @param {number} statusCode HTTP status (default 400)
   * @param {{ code?: string, details?: object }} [opts] machine-readable code + extra JSON fields
   */
  constructor(message, statusCode = 400, { code = ERROR_CODES.INVALID_ARGUMENTS, details = {} } = {}) {
    super(message);
    this.name = 'OpValidationError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  /** JSON body for HTTP responses: { error, code, ...details }. */
  toJSON() {
    return { error: this.message, code: this.code, ...this.details };
  }
}

/** Error thrown when an operation cannot run on a photo. */
export function unsupportedForPhotoError(operation, message) {
  return new OpValidationError(
    message || `Operation "${operation}" is not supported for photos. Supported photo operations: ${PHOTO_SUPPORTED_OPS.join(', ')}`,
    400,
    { code: ERROR_CODES.UNSUPPORTED_FOR_PHOTO, details: { operation, mediaType: 'image' } }
  );
}

/** Error for an on-device-only tool (the iOS grouped effect tools have no FFmpeg implementation). */
export function notAvailableOnServerError(operation) {
  return new OpValidationError(
    `Operation "${operation}" runs only on the FinalCap iOS device and is not available on the server`,
    400,
    { code: ERROR_CODES.NOT_AVAILABLE_ON_SERVER, details: { operation } }
  );
}

/**
 * Throw for iOS-only grouped tools: unsupported_for_photo when the tool is video-only and the
 * input is a photo (audio_effect), otherwise not_available_on_server. No-op for other operations.
 */
export function assertServerCanRun(operation, mediaType) {
  if (!isIosGroupedTool(operation)) return;
  if (mediaType === MEDIA_TYPE_IMAGE && !IOS_GROUPED_TOOL_MEDIA_TYPES[operation].includes('image')) {
    throw unsupportedForPhotoError(operation);
  }
  throw notAvailableOnServerError(operation);
}

// ─── Time parsing / trim (guards against `-ss undefined`) ────────────────────

/**
 * Parse a time value (seconds number, numeric string, or [[HH:]MM:]SS[.ms]) to seconds.
 * Returns null when the value is absent (undefined/null/empty string).
 * Throws OpValidationError for anything that is present but not a valid non-negative time.
 */
export function parseTimeToSeconds(value, field = 'time') {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new OpValidationError(`${field} must be a non-negative number of seconds`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new OpValidationError(`${field} must be seconds or HH:MM:SS`);
  }
  const str = value.trim();
  if (!str || str === 'undefined' || str === 'null') return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(str);
  if (!m) throw new OpValidationError(`${field} must be seconds or HH:MM:SS (got "${str}")`);
  const [, h = '0', mm, ss] = m;
  return Number(h) * 3600 + Number(mm) * 60 + Number(ss);
}

/**
 * Apply trim_video safely: `-ss` is only emitted when a start time is present,
 * `-t` only when an end time is present, and both are validated numbers.
 */
export function applyTrim(command, parsedArgs = {}) {
  const start = parseTimeToSeconds(parsedArgs.start, 'start');
  const end = parseTimeToSeconds(parsedArgs.end, 'end');
  if (start === null && end === null) {
    throw new OpValidationError('trim_video requires a start and/or end time (seconds or HH:MM:SS)');
  }
  if (start !== null && end !== null && end <= start) {
    throw new OpValidationError('trim_video end must be greater than start');
  }
  let next = command;
  if (start !== null) next = next.setStartTime(start);
  if (end !== null) next = next.setDuration(end - (start ?? 0));
  return next.outputOptions('-c copy');
}

// ─── Visual filters shared by photos and videos ──────────────────────────────

export const COLOR_FILTER_PRESETS = [
  'red', 'green', 'blue', 'yellow', 'cyan', 'magenta',
  'sepia', 'grayscale', 'black_and_white', 'invert', 'warm', 'cool', 'vintage',
];

const IDENTITY_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const SEPIA_MATRIX = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
const GRAY_MATRIX = [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114];

function tintMatrix(keep) {
  // keep: [r, g, b] booleans — channels not kept are attenuated.
  return [keep[0] ? 1 : 0.4, 0, 0, 0, keep[1] ? 1 : 0.4, 0, 0, 0, keep[2] ? 1 : 0.4];
}

const COLOR_MATRICES = {
  red: tintMatrix([true, false, false]),
  green: tintMatrix([false, true, false]),
  blue: tintMatrix([false, false, true]),
  yellow: tintMatrix([true, true, false]),
  cyan: tintMatrix([false, true, true]),
  magenta: tintMatrix([true, false, true]),
  sepia: SEPIA_MATRIX,
  grayscale: GRAY_MATRIX,
  black_and_white: GRAY_MATRIX,
};

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function requireFiniteNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new OpValidationError(`${field} must be a number`);
  }
  if (n < min || n > max) {
    throw new OpValidationError(`${field} must be between ${min} and ${max}`);
  }
  return n;
}

/** Build the ffmpeg filter for apply_color_filter (red/sepia/grayscale/…). */
export function buildColorFilter(parsedArgs = {}) {
  const raw = String(parsedArgs.filter ?? parsedArgs.color ?? parsedArgs.preset ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const preset = raw === 'gray' || raw === 'greyscale' || raw === 'monochrome' ? 'grayscale'
    : raw === 'b&w' || raw === 'bw' ? 'black_and_white'
      : raw === 'negative' ? 'invert'
        : raw;
  if (!COLOR_FILTER_PRESETS.includes(preset)) {
    throw new OpValidationError(`filter must be one of: ${COLOR_FILTER_PRESETS.join(', ')}`);
  }
  const intensity = parsedArgs.intensity === undefined || parsedArgs.intensity === null
    ? 1
    : requireFiniteNumber(parsedArgs.intensity, 'intensity', { min: 0, max: 1 });

  if (preset === 'invert') return 'negate';
  if (preset === 'vintage') return 'curves=preset=vintage';
  if (preset === 'warm' || preset === 'cool') {
    const sign = preset === 'warm' ? 1 : -1;
    const s = round4(0.3 * intensity * sign);
    const m = round4(0.15 * intensity * sign);
    return `colorbalance=rs=${s}:bs=${-s}:rm=${m}:bm=${-m}`;
  }
  const target = COLOR_MATRICES[preset];
  const mixed = target.map((v, i) => round4(IDENTITY_MATRIX[i] * (1 - intensity) + v * intensity));
  const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
  return `colorchannelmixer=${names.map((n, i) => `${n}=${mixed[i]}`).join(':')}`;
}

// Two-level escaping for drawtext text (no surrounding quotes):
// 1) option-value level: \ ' :   2) filtergraph level: \ ' [ ] , ;
// Combined with expansion=none so "%" is literal.
export function escapeDrawtext(text) {
  const optionLevel = String(text).replace(/\r/g, '').replace(/[\\':]/g, '\\$&');
  return optionLevel.replace(/[\\'[\],;]/g, '\\$&');
}

function safeColor(value, fallback = 'white') {
  if (value === undefined || value === null || value === '') return fallback;
  const color = String(value).trim();
  if (!/^[#A-Za-z0-9@.]{1,32}$/.test(color)) {
    throw new OpValidationError('color must be a color name or hex value (e.g. white, #ff0000)');
  }
  return color;
}

function optionalInt(value, field, fallback, opts) {
  if (value === undefined || value === null || value === '') return fallback;
  return Math.round(requireFiniteNumber(value, field, opts));
}

/**
 * Build a validated ffmpeg video-filter string for a visual (frame-only) operation.
 * Used for photos (all photo ops) and for new video ops (color filter, contrast, vflip).
 */
export function buildVisualFilter(operation, parsedArgs = {}, mediaType = MEDIA_TYPE_IMAGE) {
  switch (operation) {
    case 'resize_video': {
      const width = Math.round(requireFiniteNumber(parsedArgs.width, 'width', { min: -2, max: 16384 }));
      const height = Math.round(requireFiniteNumber(parsedArgs.height, 'height', { min: -2, max: 16384 }));
      if (width === 0 || height === 0 || (width < 0 && height < 0)) {
        throw new OpValidationError('width and height must be positive (one of them may be -1 to keep aspect ratio)');
      }
      return `scale=${width}:${height}`;
    }
    case 'crop_video': {
      const width = Math.round(requireFiniteNumber(parsedArgs.width, 'width', { min: 1, max: 16384 }));
      const height = Math.round(requireFiniteNumber(parsedArgs.height, 'height', { min: 1, max: 16384 }));
      const x = optionalInt(parsedArgs.x, 'x', 0, { min: 0, max: 16384 });
      const y = optionalInt(parsedArgs.y, 'y', 0, { min: 0, max: 16384 });
      return `crop=${width}:${height}:${x}:${y}`;
    }
    case 'rotate_video': {
      const angle = requireFiniteNumber(parsedArgs.angle, 'angle', { min: -3600, max: 3600 });
      const normalized = ((angle % 360) + 360) % 360;
      if (mediaType === MEDIA_TYPE_IMAGE) {
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
      if (typeof parsedArgs.text !== 'string' || !parsedArgs.text.trim()) {
        throw new OpValidationError('text is required for add_text');
      }
      const x = optionalInt(parsedArgs.x, 'x', 10, { min: 0, max: 16384 });
      const y = optionalInt(parsedArgs.y, 'y', 10, { min: 0, max: 16384 });
      const fontsize = optionalInt(parsedArgs.fontsize, 'fontsize', 24, { min: 1, max: 1000 });
      const color = safeColor(parsedArgs.color, 'white');
      return `drawtext=expansion=none:text=${escapeDrawtext(parsedArgs.text)}:x=${x}:y=${y}:fontsize=${fontsize}:fontcolor=${color}`;
    }
    case 'adjust_brightness':
      return `eq=brightness=${requireFiniteNumber(parsedArgs.brightness, 'brightness', { min: -1, max: 1 })}`;
    case 'adjust_contrast':
      return `eq=contrast=${requireFiniteNumber(parsedArgs.contrast, 'contrast', { min: 0, max: 3 })}`;
    case 'adjust_hue':
      return `hue=h=${requireFiniteNumber(parsedArgs.degrees, 'degrees', { min: -360, max: 360 })}`;
    case 'adjust_saturation':
      return `eq=saturation=${requireFiniteNumber(parsedArgs.saturation, 'saturation', { min: 0, max: 3 })}`;
    case 'apply_color_filter':
      return buildColorFilter(parsedArgs);
    case 'convert_image_format':
      return 'null';
    default:
      throw new OpValidationError(`Unknown operation: ${operation}`);
  }
}

// ─── Photo pipeline ──────────────────────────────────────────────────────────

/** Operations that work on a single still frame. */
export const PHOTO_SUPPORTED_OPS = [
  'resize_video', 'crop_video', 'rotate_video', 'flip_video_horizontal', 'flip_video_vertical',
  'add_text', 'adjust_brightness', 'adjust_contrast', 'adjust_hue', 'adjust_saturation',
  'apply_color_filter', 'convert_image_format',
];

export const PHOTO_OUTPUT_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

/**
 * Throw a 400 OpValidationError when an operation cannot run on the given media type.
 */
export function assertOperationSupported(operation, mediaType) {
  assertServerCanRun(operation, mediaType);
  if (mediaType !== MEDIA_TYPE_IMAGE) return;
  if (!PHOTO_SUPPORTED_OPS.includes(operation)) {
    throw unsupportedForPhotoError(operation);
  }
}

const IMAGE_INPUT_DEMUXERS = {
  jpeg: 'jpeg_pipe', png: 'png_pipe', webp: 'webp_pipe', bmp: 'bmp_pipe', tiff: 'tiff_pipe', gif: 'gif',
};

/**
 * Resolve output extension, Content-Type and encoder options for a photo result.
 * Same format as the input for jpg/png/webp; HEIC → JPEG; gif/bmp/tiff → PNG.
 */
export function resolveImageOutputMeta(imageFormat, operation, parsedArgs = {}, { canEncodeWebp = true } = {}) {
  let target = imageFormat;
  if (operation === 'convert_image_format') {
    const requested = String(parsedArgs.format || '').toLowerCase();
    if (!PHOTO_OUTPUT_FORMATS.includes(requested)) {
      throw new OpValidationError(`format must be one of: ${PHOTO_OUTPUT_FORMATS.join(', ')}`);
    }
    target = requested === 'jpg' ? 'jpeg' : requested;
  }
  if (target === 'webp' && !canEncodeWebp) target = 'png';
  if (!['jpeg', 'png', 'webp'].includes(target)) {
    target = imageFormat === 'heic' ? 'jpeg' : 'png';
  }
  const { ext, contentType } = IMAGE_FORMATS[target];
  const codecOptions = {
    jpeg: ['-c:v mjpeg', '-q:v 2'],
    png: ['-c:v png'],
    webp: ['-c:v libwebp', '-quality 90'],
  }[target];
  return { imageFormat: target, outputExt: ext, contentType, codecOptions, mediaType: MEDIA_TYPE_IMAGE };
}

/**
 * Build (but do not run) the fluent-ffmpeg command for a photo edit.
 * Never adds -ss/-t; always -frames:v 1 and a single-image muxer.
 */
export function buildImageCommand({ inputPath, outputPath, imageFormat, operation, args, canEncodeWebp = true }) {
  const parsedArgs = args && typeof args === 'object' ? args : {};
  assertOperationSupported(operation, MEDIA_TYPE_IMAGE);
  const filter = buildVisualFilter(operation, parsedArgs, MEDIA_TYPE_IMAGE);
  const meta = resolveImageOutputMeta(imageFormat, operation, parsedArgs, { canEncodeWebp });

  let command = ffmpeg(inputPath);
  const demuxer = IMAGE_INPUT_DEMUXERS[imageFormat];
  if (demuxer) command = command.inputFormat(demuxer);
  if (filter && filter !== 'null') command = command.videoFilters(filter);
  command = command
    .outputOptions(['-map 0:v:0', '-frames:v 1', '-update 1', ...meta.codecOptions])
    .noAudio()
    .toFormat('image2')
    .output(outputPath);
  return { command, meta };
}

let webpEncoderPromise = null;
function canEncodeWebp() {
  if (!webpEncoderPromise) {
    webpEncoderPromise = new Promise((resolve) => {
      ffmpeg.getAvailableEncoders((err, encoders) => resolve(!err && Boolean(encoders?.libwebp)));
    });
  }
  return webpEncoderPromise;
}

function probeFile(inputPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => resolve(err ? null : metadata));
  });
}

function heifConvert(inputPath, outputPath) {
  return new Promise((resolve) => {
    execFile('heif-convert', ['-q', '92', inputPath, outputPath], { timeout: 60_000 }, (err) => resolve(!err));
  });
}

/**
 * Make sure ffmpeg can decode the photo. For HEIC this relies on FFmpeg's HEIF
 * demuxer (FFmpeg ≥ 7.0; iPhone tile-grid HEICs need ≥ 7.1). If ffmpeg cannot
 * read it we fall back to libheif's `heif-convert` CLI (if installed) and
 * transcode to JPEG; otherwise a clear 415 error is thrown.
 * @returns {Promise<{ path: string, imageFormat: string, cleanup: string|null }>}
 */
export async function prepareImageInput(inputPath, imageFormat, { probe = probeFile, convert = heifConvert } = {}) {
  if (imageFormat !== 'heic') return { path: inputPath, imageFormat, cleanup: null };
  const metadata = await probe(inputPath);
  const stream = metadata?.streams?.find(s => s.codec_type === 'video');
  if (stream && Number(stream.width) > 0 && Number(stream.height) > 0) {
    return { path: inputPath, imageFormat: 'heic', cleanup: null };
  }
  const jpegPath = `${inputPath}.heic-converted.jpg`;
  if (await convert(inputPath, jpegPath)) {
    return { path: jpegPath, imageFormat: 'jpeg', cleanup: jpegPath };
  }
  throw new OpValidationError(
    'HEIC photos are not supported by this server (FFmpeg lacks HEIF decoding and heif-convert is not installed). Please upload a JPEG or PNG.',
    415,
    { code: ERROR_CODES.UNSUPPORTED_IMAGE_FORMAT, details: { mediaType: 'image', format: 'heic' } }
  );
}

/**
 * Run a photo edit to an output file. Returns output metadata including mediaType "image".
 */
export async function processImageToFile({ inputPath, imageFormat, operation, args, outputPath }) {
  const prepared = await prepareImageInput(inputPath, imageFormat);
  try {
    const { command, meta } = buildImageCommand({
      inputPath: prepared.path,
      outputPath,
      imageFormat: prepared.imageFormat,
      operation,
      args,
      canEncodeWebp: await canEncodeWebp(),
    });
    await new Promise((resolve, reject) => {
      command.on('error', (err) => reject(err)).on('end', resolve).run();
    });
    return { outputExt: meta.outputExt, contentType: meta.contentType, mediaType: MEDIA_TYPE_IMAGE };
  } finally {
    if (prepared.cleanup) fs.unlink(prepared.cleanup).catch(() => {});
  }
}

// ─── audio_fade (start / duration / type) ────────────────────────────────────

/** True when audio_fade needs the clip length to place the fade (fade-out without `start`). */
export function audioFadeNeedsDuration(parsedArgs = {}) {
  return parsedArgs.type !== 'in' && (parsedArgs.start === undefined || parsedArgs.start === null);
}

/**
 * Validate audio_fade args. `duration` is required and > 0 seconds; `start` is optional and,
 * when present, a non-negative number of seconds. Throws OpValidationError (invalid_arguments).
 * Returns the numeric values ({ start: number|null, duration: number }).
 */
export function validateAudioFadeArgs(parsedArgs = {}) {
  const toNumber = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
  const duration = toNumber(parsedArgs.duration);
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new OpValidationError('audio_fade duration must be a positive number of seconds');
  }
  let start = null;
  if (parsedArgs.start !== undefined && parsedArgs.start !== null) {
    start = toNumber(parsedArgs.start);
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
      throw new OpValidationError('audio_fade start must be a non-negative number of seconds');
    }
  }
  return { start, duration };
}

/**
 * Build the afade filter. `start` (seconds from the beginning of the clip) is where the fade
 * begins. When omitted: fade-in starts at 0; fade-out starts at clipDuration - duration
 * (clamped to 0) so it ends at the end of the clip. Any type other than "in" is a fade-out.
 */
export function buildAudioFadeFilter(parsedArgs = {}, { mediaDuration } = {}) {
  const { start, duration } = validateAudioFadeArgs(parsedArgs);
  const fadeType = parsedArgs.type === 'in' ? 'in' : 'out';
  let st = start;
  if (st === null) {
    if (fadeType === 'in') {
      st = 0;
    } else if (Number.isFinite(mediaDuration) && mediaDuration > 0) {
      st = Math.max(0, Math.round((mediaDuration - duration) * 1000) / 1000);
    } else {
      throw new OpValidationError('audio_fade start is required for a fade-out when the clip duration cannot be determined');
    }
  }
  return `afade=t=${fadeType}:st=${st}:d=${duration}`;
}

/** Clip duration in seconds from ffprobe (format duration, else longest stream), or null. */
export async function probeMediaDuration(inputPath, { probe = probeFile } = {}) {
  const metadata = await probe(inputPath);
  if (!metadata) return null;
  const candidates = [metadata.format?.duration, ...(metadata.streams || []).map(st => st.duration)]
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0);
  if (!candidates.length) return null;
  const formatDuration = Number(metadata.format?.duration);
  return Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : Math.max(...candidates);
}

/**
 * Validate video op args up front (so bad input is a 400, not an ffmpeg crash).
 */
export function validateVideoOperation(operation, args = {}) {
  const parsedArgs = args && typeof args === 'object' ? args : {};
  if (operation === 'trim_video') {
    applyTrim({ setStartTime() { return this; }, setDuration() { return this; }, outputOptions() { return this; } }, parsedArgs);
  }
  if (['apply_color_filter', 'adjust_contrast', 'flip_video_vertical'].includes(operation)) {
    buildVisualFilter(operation, parsedArgs, MEDIA_TYPE_VIDEO);
  }
  if (operation === 'audio_fade') {
    validateAudioFadeArgs(parsedArgs);
  }
}

/**
 * Resolve output extension + Content-Type for a process-video operation.
 */
export function resolveOutputMeta(operation, parsedArgs = {}) {
  const conversionOps = ['convert_video_format', 'convert_audio_format', 'extract_audio'];
  let outputExt = 'mp4';
  if (conversionOps.includes(operation)) {
    outputExt = parsedArgs.format || (operation === 'extract_audio' ? 'mp3' : 'mp4');
  }
  const audioOnlyOps = ['convert_audio_format', 'extract_audio'];
  let contentType = 'video/mp4';
  if (audioOnlyOps.includes(operation)) {
    contentType = AUDIO_CONTENT_TYPES[outputExt] || 'application/octet-stream';
  } else if (operation === 'convert_video_format') {
    contentType = VIDEO_CONTENT_TYPES[outputExt] || 'video/mp4';
  }
  return { outputExt, contentType };
}

/**
 * Apply a process-video operation onto a fluent-ffmpeg command.
 * Throws OpValidationError for unknown/invalid ops.
 */
export function applyOperation(command, operation, parsedArgs = {}, { mediaDuration } = {}) {
  switch (operation) {
    case 'resize_video':
      return command.videoFilters(`scale=${parsedArgs.width}:${parsedArgs.height}`).audioCodec('copy');
    case 'crop_video':
      return command.videoFilters(`crop=${parsedArgs.width}:${parsedArgs.height}:${parsedArgs.x}:${parsedArgs.y}`).audioCodec('copy');
    case 'rotate_video':
      return command.videoFilters(`rotate=${parsedArgs.angle}*PI/180`).audioCodec('copy');
    case 'flip_video_horizontal':
      return command.videoFilters('hflip').audioCodec('copy');
    case 'add_text': {
      const escapedText = String(parsedArgs.text || '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/:/g, '\\:')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t');
      return command.videoFilters(
        `drawtext=text='${escapedText}':x=${parsedArgs.x || 10}:y=${parsedArgs.y || 10}:fontsize=${parsedArgs.fontsize || 24}:fontcolor=${parsedArgs.color || 'white'}`
      ).audioCodec('copy');
    }
    case 'trim_video':
      return applyTrim(command, parsedArgs);
    case 'speed_video': {
      let audioFilter = '';
      const speed = parsedArgs.speed;
      if (speed >= 0.5 && speed <= 2.0) {
        audioFilter = `atempo=${speed}`;
      } else if (speed < 0.5) {
        let remainingSpeed = speed;
        const filters = [];
        while (remainingSpeed < 0.5) { filters.push('atempo=0.5'); remainingSpeed *= 2; }
        if (remainingSpeed !== 1.0) filters.push(`atempo=${remainingSpeed}`);
        audioFilter = filters.join(',');
      } else {
        let remainingSpeed = speed;
        const filters = [];
        while (remainingSpeed > 2.0) { filters.push('atempo=2.0'); remainingSpeed /= 2; }
        if (remainingSpeed !== 1.0) filters.push(`atempo=${remainingSpeed}`);
        audioFilter = filters.join(',');
      }
      return command.videoFilters(`setpts=PTS/${parsedArgs.speed}`).audioFilters(audioFilter);
    }
    case 'adjust_volume':
      return command.audioFilters(`volume=${parsedArgs.volume}`).videoCodec('copy');
    case 'audio_fade':
      return command.audioFilters(buildAudioFadeFilter(parsedArgs, { mediaDuration })).videoCodec('copy');
    case 'highpass_filter':
      return command.audioFilters(`highpass=f=${parsedArgs.frequency}`).videoCodec('copy');
    case 'lowpass_filter':
      return command.audioFilters(`lowpass=f=${parsedArgs.frequency}`).videoCodec('copy');
    case 'echo_effect':
      return command.audioFilters(`aecho=1.0:0.7:${parsedArgs.delay}:${parsedArgs.decay}`).videoCodec('copy');
    case 'bass_adjustment':
      return command.audioFilters(`bass=g=${parsedArgs.gain}`).videoCodec('copy');
    case 'treble_adjustment':
      return command.audioFilters(`treble=g=${parsedArgs.gain}`).videoCodec('copy');
    case 'equalizer': {
      const eqWidth = parsedArgs.width || 200;
      return command.audioFilters(`equalizer=f=${parsedArgs.frequency}:width_type=h:width=${eqWidth}:g=${parsedArgs.gain}`).videoCodec('copy');
    }
    case 'normalize_audio': {
      const normTarget = parsedArgs.target || -16;
      return command.audioFilters(`loudnorm=I=${normTarget}:TP=-1.5:LRA=11`).videoCodec('copy');
    }
    case 'delay_audio':
      return command.audioFilters(`adelay=${parsedArgs.delay}|${parsedArgs.delay}`).videoCodec('copy');
    case 'audio_chorus': {
      const chorusInGain = parsedArgs.in_gain ?? 0.5;
      const chorusOutGain = parsedArgs.out_gain ?? 0.9;
      const chorusDelays = parsedArgs.delays ?? '40|60|80';
      const chorusDecays = parsedArgs.decays ?? '0.4|0.5|0.6';
      const chorusSpeeds = parsedArgs.speeds ?? '0.5|0.6|0.7';
      const chorusDepths = parsedArgs.depths ?? '0.25|0.4|0.35';
      return command.audioFilters(`chorus=${chorusInGain}:${chorusOutGain}:${chorusDelays}:${chorusDecays}:${chorusSpeeds}:${chorusDepths}:t`).videoCodec('copy');
    }
    case 'audio_flanger': {
      const flangerDelay = parsedArgs.delay ?? 0;
      const flangerDepth = parsedArgs.depth ?? 2;
      const flangerRegen = parsedArgs.regen ?? 0;
      const flangerWidth = parsedArgs.width ?? 71;
      const flangerSpeed = parsedArgs.speed ?? 0.5;
      return command.audioFilters(`flanger=delay=${flangerDelay}:depth=${flangerDepth}:regen=${flangerRegen}:width=${flangerWidth}:speed=${flangerSpeed}`).videoCodec('copy');
    }
    case 'audio_phaser': {
      const phaserInGain = parsedArgs.in_gain ?? 0.4;
      const phaserOutGain = parsedArgs.out_gain ?? 0.74;
      const phaserDelay = parsedArgs.delay ?? 3;
      const phaserDecay = parsedArgs.decay ?? 0.4;
      const phaserSpeed = parsedArgs.speed ?? 0.5;
      return command.audioFilters(`aphaser=in_gain=${phaserInGain}:out_gain=${phaserOutGain}:delay=${phaserDelay}:decay=${phaserDecay}:speed=${phaserSpeed}`).videoCodec('copy');
    }
    case 'audio_vibrato': {
      const vibratoFreq = parsedArgs.frequency ?? 5;
      const vibratoDepth = parsedArgs.depth ?? 0.5;
      return command.audioFilters(`vibrato=f=${vibratoFreq}:d=${vibratoDepth}`).videoCodec('copy');
    }
    case 'audio_tremolo': {
      const tremoloFreq = parsedArgs.frequency ?? 5;
      const tremoloDepth = parsedArgs.depth ?? 0.5;
      return command.audioFilters(`tremolo=f=${tremoloFreq}:d=${tremoloDepth}`).videoCodec('copy');
    }
    case 'audio_compressor': {
      const compThreshold = parsedArgs.threshold ?? 0;
      const compRatio = parsedArgs.ratio ?? 4;
      const compAttack = parsedArgs.attack ?? 20;
      const compRelease = parsedArgs.release ?? 250;
      return command.audioFilters(`acompressor=threshold=${compThreshold}dB:ratio=${compRatio}:attack=${compAttack}:release=${compRelease}`).videoCodec('copy');
    }
    case 'audio_dynamic_normalize': {
      const mode = parsedArgs.mode ?? 'dynaudnorm';
      if (mode === 'compand') {
        const attacks = parsedArgs.attacks ?? 0.3;
        const decays = parsedArgs.decays ?? 0.8;
        const points = parsedArgs.points ?? '-70/-70|-40/-30|-20/-15|0/-12';
        const gain = parsedArgs.gain ?? 3;
        return command.audioFilters(`compand=attacks=${attacks}:decays=${decays}:points=${points}:gain=${gain}`).videoCodec('copy');
      }
      const frameLength = parsedArgs.frame_length ?? 150;
      const gaussianSize = parsedArgs.gaussian_size ?? 31;
      return command.audioFilters(`dynaudnorm=f=${frameLength}:g=${gaussianSize}`).videoCodec('copy');
    }
    case 'audio_gate': {
      const gateThreshold = parsedArgs.threshold ?? -50;
      const gateRatio = parsedArgs.ratio ?? 2;
      const gateAttack = parsedArgs.attack ?? 20;
      const gateRelease = parsedArgs.release ?? 250;
      return command.audioFilters(`agate=threshold=${gateThreshold}dB:ratio=${gateRatio}:attack=${gateAttack}:release=${gateRelease}`).videoCodec('copy');
    }
    case 'audio_stereo_widen': {
      const stereoDelay = parsedArgs.delay ?? 20;
      const stereoFeedback = parsedArgs.feedback ?? 0.3;
      const stereoCrossfeed = parsedArgs.crossfeed ?? 0.3;
      return command.audioFilters(`stereowiden=delay=${stereoDelay}:feedback=${stereoFeedback}:crossfeed=${stereoCrossfeed}`).videoCodec('copy');
    }
    case 'audio_reverse':
      return command.audioFilters('areverse').videoCodec('copy');
    case 'audio_limiter': {
      const limiterLevel = parsedArgs.level ?? 1.0;
      const limiterAttack = parsedArgs.attack ?? 5;
      const limiterRelease = parsedArgs.release ?? 50;
      return command.audioFilters(`alimiter=level_in=1:level_out=1:limit=${limiterLevel}:attack=${limiterAttack}:release=${limiterRelease}`).videoCodec('copy');
    }
    case 'audio_silence_remove': {
      const startThreshold = parsedArgs.start_threshold ?? -50;
      const startDuration = parsedArgs.start_duration ?? 0.5;
      const stopThreshold = parsedArgs.stop_threshold ?? -50;
      const stopDuration = parsedArgs.stop_duration ?? 0.5;
      return command.audioFilters(`silenceremove=start_periods=1:start_threshold=${startThreshold}dB:start_duration=${startDuration}:stop_periods=-1:stop_threshold=${stopThreshold}dB:stop_duration=${stopDuration}`).videoCodec('copy');
    }
    case 'audio_pan': {
      const panValue = parsedArgs.pan;
      let leftGain, rightGain;
      if (panValue < 0) {
        leftGain = 1.0;
        rightGain = 1.0 + panValue;
      } else if (panValue > 0) {
        leftGain = 1.0 - panValue;
        rightGain = 1.0;
      } else {
        leftGain = 1.0;
        rightGain = 1.0;
      }
      return command.audioFilters(`pan=stereo|c0=${leftGain}*c0|c1=${rightGain}*c1`).videoCodec('copy');
    }
    case 'adjust_brightness':
      return command.videoFilters(`eq=brightness=${parsedArgs.brightness}`).audioCodec('copy');
    case 'adjust_hue':
      return command.videoFilters(`hue=h=${parsedArgs.degrees}`).audioCodec('copy');
    case 'adjust_saturation':
      return command.videoFilters(`eq=saturation=${parsedArgs.saturation}`).audioCodec('copy');
    case 'convert_video_format': {
      const supportedVideoFormats = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'];
      const targetFormat = parsedArgs.format;
      if (!targetFormat || !supportedVideoFormats.includes(targetFormat)) {
        throw new OpValidationError(`format must be one of: ${supportedVideoFormats.join(', ')}`);
      }
      const supportedVideoCodecs = ['libx264', 'libx265', 'libvpx-vp9', 'auto'];
      if (parsedArgs.codec && !supportedVideoCodecs.includes(parsedArgs.codec)) {
        throw new OpValidationError(`codec must be one of: ${supportedVideoCodecs.join(', ')}`);
      }
      const codec = parsedArgs.codec && parsedArgs.codec !== 'auto' ? parsedArgs.codec : null;
      let next = command;
      if (codec) {
        next = next.videoCodec(codec).audioCodec('copy');
      } else {
        next = next.outputOptions('-c copy');
      }
      return next.toFormat(targetFormat);
    }
    case 'convert_audio_format': {
      const supportedAudioFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'];
      if (!parsedArgs.format || !supportedAudioFormats.includes(parsedArgs.format)) {
        throw new OpValidationError(`format must be one of: ${supportedAudioFormats.join(', ')}`);
      }
      const audioBitrate = parsedArgs.bitrate || '192k';
      return command.noVideo().toFormat(parsedArgs.format).audioBitrate(audioBitrate);
    }
    case 'extract_audio': {
      const supportedExtractFormats = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'];
      const format = parsedArgs.format || 'mp3';
      if (!supportedExtractFormats.includes(format)) {
        throw new OpValidationError(`format must be one of: ${supportedExtractFormats.join(', ')}`);
      }
      const extractBitrate = parsedArgs.bitrate || '192k';
      return command.noVideo().toFormat(format).audioBitrate(extractBitrate);
    }
    case 'fade_transition': {
      const fadeDuration = parsedArgs.duration || 1;
      const totalDuration = Number(parsedArgs.totalDuration);
      if (!Number.isFinite(totalDuration) || totalDuration <= fadeDuration) {
        // Without a known clip length only a fade-in can be placed safely.
        return command.videoFilters(`fade=t=in:st=0:d=${fadeDuration}`).audioCodec('copy');
      }
      return command.videoFilters(`fade=t=in:st=0:d=${fadeDuration},fade=t=out:st=${totalDuration - fadeDuration}:d=${fadeDuration}`).audioCodec('copy');
    }
    case 'apply_color_filter':
    case 'adjust_contrast':
    case 'flip_video_vertical':
      return command.videoFilters(buildVisualFilter(operation, parsedArgs, MEDIA_TYPE_VIDEO)).audioCodec('copy');
    case 'convert_image_format':
      throw new OpValidationError('convert_image_format only applies to photos — use convert_video_format for videos');
    case 'crossfade_transition':
      throw new OpValidationError('crossfade_transition requires special multi-video handling — use /api/transition-videos');
    case 'get_video_info':
      throw new OpValidationError('get_video_info is sync-only — use POST /api/process-video');
    case 'add_audio_track':
    case 'burn_subtitles':
      throw new OpValidationError(`${operation} requires multipart secondary inputs — use sync POST /api/process-video for now`);
    default:
      throw new OpValidationError(`Unknown operation: ${operation}`);
  }
}

/**
 * Run a process-video operation to an output file (for async jobs).
 */
export async function processVideoToFile({ inputPath, inputMime, operation, args, outputPath }) {
  const parsedArgs = args && typeof args === 'object' ? args : {};
  const { outputExt, contentType } = resolveOutputMeta(operation, parsedArgs);
  const inputFormat = getMimeTypeToFormat(inputMime || 'video/mp4');
  // A fade-out without `start` is placed so it ends at the end of the clip.
  const mediaDuration = operation === 'audio_fade' && audioFadeNeedsDuration(parsedArgs)
    ? await probeMediaDuration(inputPath)
    : undefined;

  return new Promise((resolve, reject) => {
    let command = ffmpeg(inputPath).inputFormat(inputFormat);
    try {
      command = applyOperation(command, operation, parsedArgs, { mediaDuration });
    } catch (err) {
      reject(err);
      return;
    }

    command
      .output(outputPath)
      .toFormat(outputExt)
      .on('error', (err) => reject(err))
      .on('end', () => resolve({ outputExt, contentType, mediaType: MEDIA_TYPE_VIDEO }))
      .run();
  });
}

/**
 * Dispatch to the photo or video pipeline.
 */
export function processMediaToFile({ mediaType, imageFormat, ...rest }) {
  if (mediaType === MEDIA_TYPE_IMAGE) {
    return processImageToFile({ ...rest, imageFormat });
  }
  return processVideoToFile(rest);
}
