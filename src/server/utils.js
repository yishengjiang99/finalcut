// Pure utility functions with no external dependencies.
// These can be safely imported in tests without side effects.

// Helper: convert SRT subtitle content to WebVTT format
export function srtToVtt(srt) {
  const vtt = 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
}

// Map MIME type to ffmpeg input format string
export function getMimeTypeToFormat(mimeType) {
  const map = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'matroska',
    'video/x-flv': 'flv',
    'video/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
  };
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  return map[base] || 'mp4';
}

// Map MIME type to file extension
export function getExtFromMimeType(mimeType) {
  const map = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/x-flv': 'flv',
    'video/ogg': 'ogv',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
  };
  const base = (mimeType || '').split(';')[0].trim().toLowerCase();
  return map[base] || 'mp4';
}

export function parseAudioDataUri(audioFile) {
  const match = audioFile.match(/^data:audio\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;

  const [, mimeSubtype, base64Data] = match;
  return {
    extension: mimeSubtype.split('+')[0].replace(/^x-/, '').replace(/[^a-zA-Z0-9]/g, '') || 'audio',
    buffer: Buffer.from(base64Data.replace(/\s+/g, ''), 'base64')
  };
}

export function parseAudioInput(audioFile) {
  if (typeof audioFile !== 'string') {
    throw new Error('audioFile must be a base64-encoded string');
  }

  const trimmed = audioFile.trim();
  if (!trimmed) {
    throw new Error('audioFile cannot be empty');
  }

  const parsedDataUri = parseAudioDataUri(trimmed);
  if (parsedDataUri) {
    return parsedDataUri;
  }

  const sanitizedBase64 = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(sanitizedBase64)) {
    throw new Error('audioFile is not valid base64 data');
  }

  return {
    extension: 'audio',
    buffer: Buffer.from(sanitizedBase64, 'base64')
  };
}

/**
 * Convert seconds to a timestamp string.
 *   SRT:  HH:MM:SS,mmm  (vtt=false)
 *   VTT:  HH:MM:SS.mmm  (vtt=true)
 */
export function secondsToTimestamp(sec, vtt = false) {
  const ms  = Math.round((sec % 1) * 1000);
  const s   = Math.floor(sec % 60);
  const m   = Math.floor((sec / 60) % 60);
  const h   = Math.floor(sec / 3600);
  const sep = vtt ? '.' : ',';
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms).padStart(3, '0')}`;
}

/**
 * Build SRT and VTT strings from normalized segments.
 * segments: Array<{ start: number, end: number, speaker: string|null, text: string }>
 *           start/end are in seconds.
 * Speaker lines are prefixed "Speaker N: " when a speaker label is present.
 * Returns { srt: string, vtt: string }.
 */
export function buildSrtAndVtt(segments) {
  if (!segments.length) return { srt: '', vtt: 'WEBVTT\n' };

  const srtLines = [];
  const vttLines = ['WEBVTT', ''];

  segments.forEach((seg, i) => {
    const label    = seg.speaker ? `${seg.speaker}: ` : '';
    const srtStart = secondsToTimestamp(seg.start, false);
    const srtEnd   = secondsToTimestamp(seg.end,   false);
    const vttStart = secondsToTimestamp(seg.start, true);
    const vttEnd   = secondsToTimestamp(seg.end,   true);
    const text     = `${label}${seg.text}`;

    srtLines.push(`${i + 1}\n${srtStart} --> ${srtEnd}\n${text}`);
    vttLines.push(`${vttStart} --> ${vttEnd}\n${text}`);
  });

  return {
    srt: srtLines.join('\n\n'),
    vtt: vttLines.join('\n\n'),
  };
}
