// Media-type detection helpers (photo vs video).
// Pure helpers are side-effect free so they can be unit tested without ffmpeg.
import path from 'path';

export const MEDIA_TYPE_IMAGE = 'image';
export const MEDIA_TYPE_VIDEO = 'video';

/** Canonical image formats we understand → output metadata. */
export const IMAGE_FORMATS = {
  jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
  png: { ext: 'png', contentType: 'image/png' },
  webp: { ext: 'webp', contentType: 'image/webp' },
  heic: { ext: 'heic', contentType: 'image/heic' },
  gif: { ext: 'gif', contentType: 'image/gif' },
  bmp: { ext: 'bmp', contentType: 'image/bmp' },
  tiff: { ext: 'tiff', contentType: 'image/tiff' },
};

const IMAGE_MIME_TO_FORMAT = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/pjpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/heic-sequence': 'heic',
  'image/heif-sequence': 'heic',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/tiff': 'tiff',
};

const IMAGE_EXT_TO_FORMAT = {
  jpg: 'jpeg', jpeg: 'jpeg', jpe: 'jpeg', jfif: 'jpeg',
  png: 'png',
  webp: 'webp',
  heic: 'heic', heif: 'heic', hif: 'heic',
  gif: 'gif',
  bmp: 'bmp',
  tif: 'tiff', tiff: 'tiff',
};

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'ogv', '3gp', 'mpg', 'mpeg', 'ts', 'mts']);

// ISO-BMFF brands that identify HEIF/HEIC still images (as opposed to mp4/mov video).
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'mif2']);

// ffprobe codec names that are still-image codecs.
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'webp', 'bmp', 'tiff', 'gif', 'jpeg2000', 'jpegls', 'apng']);
// ffprobe demuxers that only ever produce still images.
const IMAGE_DEMUXERS = /(^|,)(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|gif_pipe|heif)(,|$)/;

function normalizeMime(mimetype) {
  return String(mimetype || '').split(';')[0].trim().toLowerCase();
}

function extOf(filename) {
  return path.extname(String(filename || '')).slice(1).toLowerCase();
}

/**
 * Identify an image format from magic bytes. Returns a key of IMAGE_FORMATS,
 * 'video' when the bytes are clearly a video container, or null when unknown.
 * @param {Buffer|Uint8Array|null|undefined} buf
 */
export function sniffMediaFormat(buf) {
  if (!buf || buf.length < 4) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF') {
    const kind = b.toString('ascii', 8, 12);
    if (kind === 'WEBP') return 'webp';
    if (kind === 'AVI ') return 'video';
    return null;
  }
  if (b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26) return 'bmp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00)
    || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return 'tiff';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video'; // EBML (webm/mkv)
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const boxSize = Math.min(b.readUInt32BE(0) || 0, b.length);
    const brands = [b.toString('ascii', 8, 12)];
    for (let off = 16; off + 4 <= boxSize; off += 4) brands.push(b.toString('ascii', off, off + 4));
    if (HEIF_BRANDS.has(brands[0])) return 'heic';
    // mp4/mov major brand but HEIF compatible brand only (rare) → still treat as video
    return 'video';
  }
  if (b.length >= 3 && b.toString('ascii', 0, 3) === 'FLV') return 'video';
  return null;
}

/**
 * Detect image format from upload hints (mimetype / filename). Returns an
 * IMAGE_FORMATS key, 'video' when the hints clearly indicate video, or null.
 */
export function imageFormatFromHints({ mimetype, filename } = {}) {
  const ext = extOf(filename);
  if (IMAGE_EXT_TO_FORMAT[ext]) return IMAGE_EXT_TO_FORMAT[ext];
  if (VIDEO_EXTS.has(ext)) return 'video';
  const mime = normalizeMime(mimetype);
  if (IMAGE_MIME_TO_FORMAT[mime]) return IMAGE_MIME_TO_FORMAT[mime];
  if (mime.startsWith('image/')) return 'jpeg';
  return null;
}

/**
 * Decide whether ffprobe metadata describes a still image:
 * a single video stream, no audio, and either an image codec/demuxer or
 * no duration with at most one frame.
 */
export function isImageProbe(metadata) {
  if (!metadata || !Array.isArray(metadata.streams)) return false;
  const videoStreams = metadata.streams.filter(s => s.codec_type === 'video');
  const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');
  if (videoStreams.length !== 1 || audioStreams.length > 0) return false;
  const stream = videoStreams[0];
  const formatName = String(metadata.format?.format_name || '');
  if (IMAGE_DEMUXERS.test(formatName)) return true;
  const durationRaw = stream.duration ?? metadata.format?.duration;
  const duration = Number(durationRaw);
  const hasDuration = durationRaw !== undefined && durationRaw !== 'N/A' && Number.isFinite(duration) && duration > 0.05;
  const nbFrames = Number(stream.nb_frames);
  const singleFrame = !Number.isFinite(nbFrames) || nbFrames <= 1;
  if (IMAGE_CODECS.has(stream.codec_name) && !hasDuration && singleFrame) return true;
  return !hasDuration && Number.isFinite(nbFrames) && nbFrames === 1;
}

/** Map an ffprobe image stream codec to an IMAGE_FORMATS key. */
export function imageFormatFromProbe(metadata) {
  const stream = (metadata?.streams || []).find(s => s.codec_type === 'video');
  switch (stream?.codec_name) {
    case 'mjpeg': return 'jpeg';
    case 'png': case 'apng': return 'png';
    case 'webp': return 'webp';
    case 'hevc': return 'heic';
    case 'gif': return 'gif';
    case 'bmp': return 'bmp';
    case 'tiff': return 'tiff';
    default: return 'png';
  }
}

function defaultProbe(inputPath) {
  return import('fluent-ffmpeg').then(({ default: ffmpeg }) => new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => resolve(err ? null : metadata));
  }));
}

/**
 * Detect whether an upload is a photo or a video.
 * Order: magic bytes → filename/mimetype hints → ffprobe (single frame, no duration).
 * Magic bytes win over hints because the iOS app historically labelled every
 * upload as video/mp4.
 *
 * @param {{ buffer?: Buffer, mimetype?: string, filename?: string, inputPath?: string, probe?: Function }} opts
 * @returns {Promise<{ mediaType: 'image'|'video', imageFormat: string|null, source: string }>}
 */
export async function detectMediaType({ buffer, mimetype, filename, inputPath, probe = defaultProbe } = {}) {
  const sniffed = sniffMediaFormat(buffer);
  if (sniffed === 'video') return { mediaType: MEDIA_TYPE_VIDEO, imageFormat: null, source: 'magic' };
  if (sniffed) return { mediaType: MEDIA_TYPE_IMAGE, imageFormat: sniffed, source: 'magic' };

  const hinted = imageFormatFromHints({ mimetype, filename });
  if (hinted && hinted !== 'video') return { mediaType: MEDIA_TYPE_IMAGE, imageFormat: hinted, source: 'hint' };
  if (hinted === 'video') return { mediaType: MEDIA_TYPE_VIDEO, imageFormat: null, source: 'hint' };

  if (inputPath && probe) {
    const metadata = await probe(inputPath);
    if (metadata && isImageProbe(metadata)) {
      return { mediaType: MEDIA_TYPE_IMAGE, imageFormat: imageFormatFromProbe(metadata), source: 'ffprobe' };
    }
  }
  return { mediaType: MEDIA_TYPE_VIDEO, imageFormat: null, source: 'default' };
}

/** True for mimetypes/filenames we accept as uploads (video, audio, image). */
export function isAcceptedUpload({ mimetype, filename } = {}) {
  const mime = normalizeMime(mimetype);
  if (!mime || mime === 'application/octet-stream') return true;
  if (mime.startsWith('video/') || mime.startsWith('audio/') || mime.startsWith('image/')) return true;
  const ext = extOf(filename);
  return Boolean(IMAGE_EXT_TO_FORMAT[ext] || VIDEO_EXTS.has(ext));
}
