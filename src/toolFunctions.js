// Video, photo and audio editing tool functions.
// In "client" engine mode FFmpeg runs in the browser (ffmpeg.wasm, src/wasm/ffmpegEngine.js) and
// the media is not uploaded; a step the browser cannot do may run on the server, but only after
// the user agrees to the upload. In "server" engine mode every edit goes to the server API.

import { captionSourceFor, recordCaptionBurn } from './captionLineage.js';
import { runLyricCaptionsWeb, describeSong } from './lyricCaptionsClient.js';
import { abortableFetch as fetch } from './abortableFetch.js';
import * as engine from './wasm/ffmpegEngine.js';
import { SUPPORTED_VIDEO_CODECS, SUPPORTED_AUDIO_BITRATES, PHOTO_OUTPUT_FORMATS } from './wasm/ops/process.js';
import { CLI_MIME_TYPES } from './wasm/ops/multi.js';
import { getEngineMode, ENGINE_CLIENT, requestUploadConsent, UploadDeclinedError, getCloudCaptions } from './engineMode.js';
import { dedupeSrtCues, translatedTrackWithoutDuplicates } from './server/captionHelpers.js';

// Aspect ratio presets for social media platforms
const ASPECT_RATIO_PRESETS = {
  '9:16': { width: 1080, height: 1920, description: 'Stories, Reels, & TikToks' },
  '16:9': { width: 1920, height: 1080, description: 'YT thumbnails & Cinematic widescreen' },
  '1:1': { width: 1080, height: 1080, description: 'X feed posts & Profile pics' },
  '2:3': { width: 1080, height: 1620, description: 'Posters, Pinterest & Tall Portraits' },
  '3:2': { width: 1620, height: 1080, description: 'Classic photography, Landscape' }
};

// Supported conversion formats (kept in sync with tools.js enums and server.js)
const SUPPORTED_VIDEO_FORMATS = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'];
const SUPPORTED_AUDIO_FORMATS = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'];
const SUPPORTED_EXTRACT_FORMATS = ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a'];

const VIDEO_MIME_TYPES = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', flv: 'video/x-flv', ogv: 'video/ogg'
};
const AUDIO_MIME_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', wma: 'audio/x-ms-wma'
};

let sampleModeEnabled = false;
let sampleModeAccessToken = null;
let currentFileMimeType = 'video/mp4';

export function setSampleModeEnabled(enabled) {
  sampleModeEnabled = Boolean(enabled);
}

export function setSampleModeAccessToken(token) {
  sampleModeAccessToken = typeof token === 'string' && token ? token : null;
}

export function setCurrentFileMimeType(mimeType) {
  currentFileMimeType = (typeof mimeType === 'string' && mimeType) ? mimeType : 'video/mp4';
}

export function getCurrentFileMimeType() {
  return currentFileMimeType;
}

function normalizeAudioFileInput(audioFile) {
  if (typeof audioFile === 'string') {
    const trimmed = audioFile.trim();
    if (!trimmed) {
      throw new Error('audioFile cannot be empty');
    }
    return trimmed;
  }

  if (audioFile instanceof Uint8Array) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < audioFile.length; i += chunkSize) {
      binary += String.fromCharCode(...audioFile.subarray(i, i + chunkSize));
    }
    return `data:audio/mpeg;base64,${btoa(binary)}`;
  }

  if (audioFile instanceof ArrayBuffer) {
    return normalizeAudioFileInput(new Uint8Array(audioFile));
  }

  throw new Error('audioFile must be a base64 string, Uint8Array, or ArrayBuffer');
}

// Collect all chunks from a ReadableStreamDefaultReader into a single Uint8Array
async function collectStreamChunks(reader) {
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.length;
  }
  if (totalBytes === 0) {
    throw new Error('Server returned an empty media file');
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// Helper function to call server API using streaming:
// video data is sent as the raw request body; operation, args, and file type go in headers.
// Response is streamed via ReadableStream and accumulated into a Uint8Array.
async function processVideoOnServer(operation, args, videoFileData) {
  const fileMimeType = currentFileMimeType || 'video/mp4';

  const response = await fetch('/api/process-video', {
    method: 'POST',
    headers: {
      'Content-Type': fileMimeType,
      'x-operation': operation,
      'x-args': JSON.stringify(args),
      ...(sampleModeEnabled && sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {})
    },
    body: videoFileData
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || 'Server processing failed');
  }

  lastResultContentType = response.headers?.get?.('content-type') || null;
  return collectStreamChunks(response.body.getReader());
}

// ─── Where the last tool ran ─────────────────────────────────────────────────
// The chat loop reports this to the model with each tool result.

let lastExecution = { executedOn: null, errorCode: null };

/** Reset before a tool call; read after it: { executedOn: 'browser'|'server'|null, errorCode }. */
export function resetLastExecution() {
  lastExecution = { executedOn: null, errorCode: null };
}

export function getLastExecution() {
  return lastExecution;
}

let toolStatusListener = null;
/** `listener({ text, progress? })` gets progress of slow steps inside a tool (model download…). */
export function setToolStatusListener(listener) {
  toolStatusListener = typeof listener === 'function' ? listener : null;
}
const toolStatus = (text, progress) => toolStatusListener?.({ text, ...(Number.isFinite(progress) ? { progress } : {}) });

const sampleAuthHeaders = () => (sampleModeEnabled && sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {});
const clientEngine = () => getEngineMode() === ENGINE_CLIENT;

// Failures that mean "this browser cannot do it", as opposed to a bad request or a bad file.
const CAN_FALL_BACK = new Set(['unsupported_in_browser', 'wasm_load_failed', 'wasm_timeout']);

/**
 * Run `inBrowser`; if the browser cannot do the step, ask before running `onServer` (which
 * uploads `uploads`: "video", "photo" or "audio"). Declining throws UploadDeclinedError.
 */
async function browserFirst(tool, inBrowser, onServer, uploads = 'video') {
  try {
    const result = await inBrowser();
    lastExecution.executedOn = 'browser';
    return result;
  } catch (error) {
    lastExecution.errorCode = error?.code || null;
    if (!CAN_FALL_BACK.has(error?.code) || !onServer) throw error;
    if (!(await requestUploadConsent({ tool, reason: error.message, uploads }))) {
      lastExecution.errorCode = 'skipped_by_user';
      throw new UploadDeclinedError(tool);
    }
    const result = await onServer();
    lastExecution = { executedOn: 'server', errorCode: null };
    return result;
  }
}

// One single-input edit: in the browser in client mode, otherwise (or as the agreed fallback) on the server.
async function processMedia(operation, args, videoFileData) {
  if (!clientEngine()) {
    const data = await processVideoOnServer(operation, args, videoFileData);
    lastExecution.executedOn = 'server';
    return data;
  }
  const isPhoto = (currentFileMimeType || '').startsWith('image/');
  return browserFirst(operation, async () => {
    const { data, contentType } = await engine.processMedia(operation, args, videoFileData, currentFileMimeType);
    lastResultContentType = contentType;
    return data;
  }, () => processVideoOnServer(operation, args, videoFileData), isPhoto ? 'photo' : 'video');
}

const AUDIO_EXT_BY_SUBTYPE = { mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', aac: 'aac', ogg: 'ogg', flac: 'flac', mp4: 'm4a', 'x-m4a': 'm4a', webm: 'webm' };

// The audio for add_audio_track as bytes: a data URL, bare base64, or binary.
function decodeAudioInput(audioFile) {
  if (audioFile instanceof ArrayBuffer) return { bytes: new Uint8Array(audioFile), extension: 'mp3' };
  if (audioFile instanceof Uint8Array) return { bytes: audioFile, extension: 'mp3' };
  if (typeof audioFile !== 'string' || !audioFile.trim()) throw new Error('audioFile must be a base64 string, Uint8Array, or ArrayBuffer');
  const match = /^data:audio\/([a-z0-9.+-]+)[^,]*;base64,(.*)$/is.exec(audioFile.trim());
  const base64 = (match ? match[2] : audioFile.trim()).replace(/\s+/g, '');
  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('audioFile is not valid base64 audio');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, extension: AUDIO_EXT_BY_SUBTYPE[match?.[1]?.toLowerCase()] || 'mp3' };
}

const FFMPEG_CLI_MIME_TYPES = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', gif: 'image/gif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac',
  jpg: 'image/jpeg', png: 'image/png'
};

const ffmpegCliAuthHeaders = () => (sampleModeEnabled && sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {});

// Uploads the current media to POST /api/ffmpeg-cli/run and shows the result. Throws on failure,
// with the FFmpeg stderr tail on error.stderr.
async function runFfmpegOnServer(params, videoFileData, setVideoFileData, addMessage, authHeaders, signal) {
  const formData = new FormData();
  formData.append('video', new Blob([videoFileData], { type: currentFileMimeType || 'video/mp4' }), 'input');
  formData.append('args', JSON.stringify(params));
  const response = await fetch('/api/ffmpeg-cli/run', { method: 'POST', headers: authHeaders, body: formData, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body.errors?.length ? `${body.errors.join('; ')}${body.suggestions && Object.keys(body.suggestions).length ? ` Suggestions: ${JSON.stringify(body.suggestions)}` : ''}` : (body.error || 'FFmpeg CLI failed');
    throw Object.assign(new Error(detail), { stderr: body.stderr || '' });
  }
  const format = response.headers.get('X-Output-Format') || 'mp4';
  const command = decodeURIComponent(response.headers.get('X-FFmpeg-Command') || '');
  const explanation = decodeURIComponent(response.headers.get('X-FFmpeg-Explanation') || '');
  const data = new Uint8Array(await response.arrayBuffer());
  const mimeType = FFMPEG_CLI_MIME_TYPES[format] || 'application/octet-stream';
  if (mimeType.startsWith('video/') && format !== 'gif') setVideoFileData(data);
  addMessage({ text: `Processed with FFmpeg: ${explanation}`, videoUrl: URL.createObjectURL(new Blob([data], { type: mimeType })), mimeType });
  return `FFmpeg command ran successfully (${command}). ${explanation}`;
}

export const MAX_CLI_STRING_ATTEMPTS = 3;

/**
 * No tool matched the request: ask inference for the FFmpeg CLI string and run it, sending each
 * failure (validation error or FFmpeg stderr) back for a corrected command. Returns null when
 * inference says the message is not an edit FFmpeg can do, otherwise the result string.
 */
export async function ffmpegCliStringFallback(request, videoFileData, setVideoFileData, addMessage, { signal, onRun } = {}) {
  const authHeaders = ffmpegCliAuthHeaders();
  const attempts = [];
  for (let i = 0; i < MAX_CLI_STRING_ATTEMPTS; i++) {
    const response = await fetch('/api/ffmpeg-cli', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ action: 'command', request, attempts }),
      ...(signal ? { signal } : {})
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'FFmpeg CLI request failed');
    if (!body.command) return attempts.length ? `Failed to run FFmpeg: ${attempts.at(-1).error}` : null;
    onRun?.();
    try {
      return await runFfmpegOnServer({ command: body.command }, videoFileData, setVideoFileData, addMessage, authHeaders, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      attempts.push({ command: body.command, error: [error.message, error.stderr].filter(Boolean).join('\n') });
    }
  }
  return `Failed to run FFmpeg: ${attempts.at(-1).error}`;
}

// Content-Type of the most recent /api/process-video result (image/* for photos).
let lastResultContentType = null;

// Shared runner for frame-only edits that work on both videos and photos.
async function runVisualEdit(operation, args, videoFileData, setVideoFileData, addMessage, label) {
  try {
    const data = await processMedia(operation, args || {}, videoFileData);
    setVideoFileData(data);
    const resultType = (lastResultContentType || 'video/mp4').split(';')[0].trim();
    const isPhoto = resultType.startsWith('image/');
    const url = URL.createObjectURL(new Blob([data], { type: resultType }));
    addMessage({ text: `Processed ${isPhoto ? 'photo' : 'video'} (${label}):`, videoUrl: url, mimeType: resultType });
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} applied successfully.`;
  } catch (error) {
    addMessage({ text: `Error applying ${label}: ` + error.message });
    return `Failed to apply ${label}: ` + error.message;
  }
}

// Filter and encoder names of the browser FFmpeg build, used to reject a bad run_ffmpeg command
// before it starts. Without the catalog the command still runs; FFmpeg then reports the error.
let catalogPromise = null;
function loadCapabilityCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('/api/v2/capabilities')
      .then(response => (response.ok ? response.json() : null))
      .then(catalog => (catalog ? { filters: (catalog.filters || []).map(f => f.name), encoders: (catalog.encoders || []).map(e => e.name) } : null))
      .catch(() => null);
  }
  return catalogPromise;
}

// ffprobe metadata as the text shown in the chat (and returned to the model).
function describeMediaInfo(metadata, sizeBytes) {
  const videoInfo = metadata.format || {};
  const videoStream = metadata.streams?.find(s => s.codec_type === 'video') || {};
  const size = Number(videoInfo.size) || sizeBytes;
  return `Video Information:
- Duration: ${videoInfo.duration ? Math.round(videoInfo.duration) + 's' : 'Unknown'}
- Size: ${size ? (size / 1024 / 1024).toFixed(2) + ' MB' : 'Unknown'}
- Resolution: ${videoStream.width || '?'} x ${videoStream.height || '?'}
- Codec: ${videoStream.codec_name || 'Unknown'}
- Frame Rate: ${videoStream.r_frame_rate || 'Unknown'}`;
}

// Burn SRT tracks on the server (legacy path, and the agreed fallback). Uploads the video.
async function burnSubtitlesOnServer(videoFileData, fileMimeType, burnArgs) {
  const formData = new FormData();
  formData.append('video', new Blob([videoFileData], { type: fileMimeType }), 'input.mp4');
  formData.append('operation', 'burn_subtitles');
  formData.append('args', JSON.stringify(burnArgs));
  const response = await fetch('/api/process-video', { method: 'POST', headers: sampleAuthHeaders(), body: formData });
  if (!response.ok) {
    let errorData = {};
    try { errorData = await response.json(); } catch (_) {}
    throw new Error(errorData.error || `Burn-in failed (${response.status})`);
  }
  return collectStreamChunks(response.body.getReader());
}

// Speech to SRT/VTT without uploading the video: on this device by default, or in the cloud
// (audio only) when the user turned that on. Returns { srt, vtt, how }.
async function transcribeSpeech(videoFileData, fileMimeType, language) {
  toolStatus('Extracting audio…');
  const wav = await engine.extractSpeechAudio(videoFileData, fileMimeType);
  if (getCloudCaptions()) {
    toolStatus('Transcribing in the cloud (audio only)…');
    const form = new FormData();
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('language', language);
    const response = await fetch('/api/v2/transcribe-audio', { method: 'POST', headers: sampleAuthHeaders(), body: form });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Cloud transcription failed (${response.status})`);
    return { srt: body.srt, vtt: body.vtt, how: `cloud transcription (uploaded ${Math.round(wav.length / 1024)} KB of audio, no video)` };
  }
  const { transcribeOnDevice } = await import('./whisper.js');
  const { srt, vtt, device } = await transcribeOnDevice(wav, {
    language,
    onStatus: ({ phase, progress }) => toolStatus(phase === 'downloading' ? 'Downloading the speech model (first time only)…' : 'Transcribing on your device…', progress),
  });
  return { srt, vtt, how: `transcribed on this device (${device === 'webgpu' ? 'WebGPU' : 'WebAssembly'}), nothing uploaded` };
}

// generate_captions in the browser: transcribe locally (or cloud audio-only if opted in),
// translate as text, burn with ffmpeg.wasm.
async function generateCaptionsInBrowser(args, inputVideoFileData, setVideoFileData, addMessage) {
  const { bytes: videoFileData, replacing } = captionSourceFor(inputVideoFileData);
  const fileMimeType = currentFileMimeType || 'video/mp4';
  if (fileMimeType.startsWith('image/')) throw new Error('Captions are not supported for photos');
  const language = args.language || 'auto';
  const translateLanguage = args.translate_language || null;
  const burnIn = args.burn_in !== false;
  const langDesc = language === 'auto' ? 'auto-detected' : language;

  const { srt, vtt, how } = await transcribeSpeech(videoFileData, fileMimeType, language);
  if (!srt || !String(srt).trim()) throw new Error('No captions were generated from the audio');
  lastExecution.executedOn = 'browser';

  let translatedSrt = null;
  let translatedVtt = null;
  if (translateLanguage) {
    toolStatus(`Translating captions to ${translateLanguage}…`);
    // Text only: the caption lines go to the server for translation, never the media.
    const response = await fetch('/api/translate-captions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sampleAuthHeaders() },
      body: JSON.stringify({ srtContent: srt, targetLanguage: translateLanguage }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Failed to translate captions');
    translatedSrt = body.srt;
    translatedVtt = body.vtt;
  }

  const srtUrl = URL.createObjectURL(new Blob([srt], { type: 'text/plain' }));
  const vttUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
  const originalVideoUrl = URL.createObjectURL(new Blob([videoFileData], { type: fileMimeType }));
  const softTracks = (text) => {
    addMessage({ text, videoUrl: originalVideoUrl, mimeType: fileMimeType, vttUrl: translatedVtt ? URL.createObjectURL(new Blob([translatedVtt], { type: 'text/vtt' })) : vttUrl });
    addMessage({ text: 'SRT download:', videoUrl: srtUrl, videoType: 'subtitle-srt', mimeType: 'text/plain' });
    if (translatedSrt) addMessage({ text: `Translated SRT (${translateLanguage}):`, videoUrl: URL.createObjectURL(new Blob([translatedSrt], { type: 'text/plain' })), videoType: 'subtitle-srt', mimeType: 'text/plain' });
  };
  if (!burnIn) {
    softTracks(`Captions generated (${langDesc}): soft subtitles.`);
    return `Captions generated (${langDesc})${translatedSrt ? ` and translated to ${translateLanguage}` : ''}; ${how}. Soft subtitle track only (burn_in=false).`;
  }

  // Same clean-up the server does before burning: merge repeated lines, drop translation cues
  // that only repeat the original.
  const primary = dedupeSrtCues(srt);
  const translatedTrack = translatedSrt ? translatedTrackWithoutDuplicates(primary, dedupeSrtCues(translatedSrt)) : '';
  const style = args.style || 'default';
  const position = args.position || 'bottom';
  toolStatus('Burning captions into the video…');
  let burned;
  try {
    burned = await browserFirst(
      'generate_captions',
      () => engine.burnSubtitles({ srt: primary, translatedSrt: translatedTrack || null, style, position }, videoFileData, fileMimeType),
      () => burnSubtitlesOnServer(videoFileData, fileMimeType, { srtContent: srt, style, position, ...(translatedSrt ? { translatedSrtContent: translatedSrt } : {}) }),
    );
  } catch (error) {
    if (error.code === 'cancelled') throw error;
    // The captions exist; show them as a soft track instead of failing the whole step.
    softTracks(`Captions ready, but they were not burned into the video (${error.message}). Showing soft subtitles instead.`);
    return `Captions generated (${langDesc}); ${how}. Burn-in did not run: ${error.message} Soft subtitles shown.`;
  }
  recordCaptionBurn(videoFileData, burned);
  setVideoFileData(burned);
  const dual = translatedSrt ? ` Dual-track burn-in (translated ${translateLanguage} + original).` : '';
  // The caption text is in the video; it is not repeated in the chat bubble.
  addMessage({ text: `Captions burned in (${langDesc}).${dual}`, videoUrl: URL.createObjectURL(new Blob([burned], { type: 'video/mp4' })), mimeType: 'video/mp4' });
  addMessage({ text: 'SRT download:', videoUrl: srtUrl, videoType: 'subtitle-srt', mimeType: 'text/plain' });
  if (translatedSrt) addMessage({ text: `Translated SRT (${translateLanguage}):`, videoUrl: URL.createObjectURL(new Blob([translatedSrt], { type: 'text/plain' })), videoType: 'subtitle-srt', mimeType: 'text/plain' });
  const where = lastExecution.executedOn === 'server' ? 'burn-in ran on the server (you agreed to the upload)' : 'burned in on this device';
  return `Captions generated (${langDesc})${translatedSrt ? ` and translated to ${translateLanguage}` : ''} with burn-in; ${how}; ${where}.${replacing ? ' Replaced the captions burned earlier (re-burned from the uncaptioned video).' : ''}`;
}

// lyric_captions in the browser. Song lookup and translation need the audio on the server, so the
// audio (never the video) is uploaded, and only after the user agrees (or has turned on cloud
// captions). The burn-in runs in ffmpeg.wasm.
async function lyricCaptionsInBrowser(args, videoFileData, replacing, setVideoFileData, addMessage) {
  const fileMimeType = currentFileMimeType || 'video/mp4';
  if (!getCloudCaptions() && !(await requestUploadConsent({ tool: 'lyric_captions', uploads: 'audio', reason: 'Lyric captions identify the song and translate the lyrics on the server.' }))) {
    lastExecution.errorCode = 'skipped_by_user';
    throw new UploadDeclinedError('lyric_captions');
  }
  const headers = sampleAuthHeaders();
  const { width, height } = engine.summarizeProbe(await engine.probeMedia(videoFileData, fileMimeType));
  toolStatus('Extracting audio and transcribing lyrics…');
  const { burned, summary, result, audioBytes } = await runLyricCaptionsWeb(args, videoFileData, {
    headers,
    size: width && height ? { width, height } : null,
    extract: (bytes) => engine.extractSpeechAudio(bytes, fileMimeType),
    burn: (captions, burnOnServer) => {
      toolStatus('Burning captions into the video…');
      return browserFirst('lyric_captions', async () => {
        if (!captions.ass) throw Object.assign(new Error('The server returned no caption script to burn.'), { code: 'unsupported_in_browser' });
        return engine.burnAss(assWithFont(captions.ass, engine.FONT_FAMILY), videoFileData, fileMimeType);
      }, burnOnServer);
    },
  });
  recordCaptionBurn(videoFileData, burned);
  setVideoFileData(burned);
  const lines = result.lines?.length || 0;
  const songText = describeSong(result.song);
  // No lyric text in the bubble: it is in the video.
  addMessage({ text: `Bilingual captions burned in (${lines} lines, ${result.language || 'auto'} → ${result.targetLanguage}). ${songText}`, videoUrl: URL.createObjectURL(new Blob([burned], { type: 'video/mp4' })), mimeType: 'video/mp4' });
  const where = lastExecution.executedOn === 'server' ? 'burn-in: server (you agreed to upload the video)' : 'burn-in: on this device';
  return `lyric_captions done: ${lines} lines, ${result.language || 'auto'} → ${result.targetLanguage} (${summary?.translatedCount ?? lines} translated), mode ${result.mode}. ${songText}${replacing ? ' Replaced the captions burned earlier.' : ''} Uploaded ${Math.round(audioBytes / 1024)} KB of audio for transcription (no video); ${where}.`;
}

// Point every style of an ASS script at the font the browser engine has (it has no system fonts).
export function assWithFont(ass, fontName) {
  return String(ass).replace(/^(Style:\s*[^,]*,)[^,]*/gm, `$1${fontName}`);
}

export const toolFunctions = {
  resize_video: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.width === null || args.width === undefined || args.height === null || args.height === undefined) {
        throw new Error('Width and height are required');
      }
      if (args.width <= 0 || args.height <= 0) {
        throw new Error('Width and height must be positive numbers');
      }

      const data = await processMedia('resize_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (resized):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Video resized successfully.';
    } catch (error) {
      addMessage({ text: 'Error resizing video: ' + error.message });
      return 'Failed to resize video: ' + error.message;
    }
  },
  
  crop_video: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs - use strict equality to allow 0 values
      if (args.x === null || args.x === undefined || args.y === null || args.y === undefined || args.width === null || args.width === undefined || args.height === null || args.height === undefined) {
        throw new Error('x, y, width, and height are required for cropping');
      }
      if (args.x < 0 || args.y < 0 || args.width <= 0 || args.height <= 0) {
        throw new Error('Crop dimensions must be valid positive numbers');
      }

      const data = await processMedia('crop_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (cropped):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Video cropped successfully.';
    } catch (error) {
      addMessage({ text: 'Error cropping video: ' + error.message });
      return 'Failed to crop video: ' + error.message;
    }
  },
  
  rotate_video: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.angle === null || args.angle === undefined) {
        throw new Error('Angle is required for rotation');
      }

      const data = await processMedia('rotate_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (rotated):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Video rotated successfully.';
    } catch (error) {
      addMessage({ text: 'Error rotating video: ' + error.message });
      return 'Failed to rotate video: ' + error.message;
    }
  },
  
  flip_video_horizontal: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const data = await processMedia('flip_video_horizontal', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (flipped horizontally):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Video flipped horizontally successfully.';
    } catch (error) {
      addMessage({ text: 'Error flipping video horizontally: ' + error.message });
      return 'Failed to flip video horizontally: ' + error.message;
    }
  },
  
  add_text: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs - explicitly reject empty strings along with null/undefined
      if (typeof args.text !== 'string' || args.text === '') {
        throw new Error('Text is required and cannot be empty');
      }

      const data = await processMedia('add_text', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (text added):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Text added to video successfully.';
    } catch (error) {
      addMessage({ text: 'Error adding text to video: ' + error.message });
      return 'Failed to add text to video: ' + error.message;
    }
  },
  
  trim_video: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs - use strict equality to allow 0 as a valid start time
      if (args.start === null || args.start === undefined || args.end === null || args.end === undefined) {
        throw new Error('Start and end times are required for trimming');
      }

      const data = await processMedia('trim_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (trimmed):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Video trimmed successfully.';
    } catch (error) {
      addMessage({ text: 'Error trimming video: ' + error.message });
      return 'Failed to trim video: ' + error.message;
    }
  },
  
  adjust_speed: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.speed === null || args.speed === undefined || args.speed <= 0) {
        throw new Error('Speed must be a positive number');
      }

      const data = await processMedia('speed_video', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (speed adjusted):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Video speed adjusted successfully.';
    } catch (error) {
      addMessage({ text: 'Error adjusting video speed: ' + error.message });
      return 'Failed to adjust video speed: ' + error.message;
    }
  },
  
  adjust_volume: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.volume === null || args.volume === undefined || args.volume < 0) {
        throw new Error('Volume must be a non-negative number');
      }

      const data = await processMedia('adjust_volume', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (volume adjusted):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Audio volume adjusted successfully.';
    } catch (error) {
      addMessage({ text: 'Error adjusting volume: ' + error.message });
      return 'Failed to adjust audio volume: ' + error.message;
    }
  },
  
  audio_fade: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (!args.type || (args.type !== 'in' && args.type !== 'out')) {
        throw new Error('Type must be "in" or "out"');
      }
      if (args.duration === null || args.duration === undefined || args.duration <= 0) {
        throw new Error('Duration must be a positive number');
      }
      if (args.start !== null && args.start !== undefined
        && (typeof args.start !== 'number' || !Number.isFinite(args.start) || args.start < 0)) {
        throw new Error('Start must be a non-negative number of seconds');
      }

      const data = await processMedia('audio_fade', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (audio fade applied):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return `Audio fade ${args.type} applied successfully.`;
    } catch (error) {
      addMessage({ text: 'Error applying audio fade: ' + error.message });
      return 'Failed to apply audio fade: ' + error.message;
    }
  },
  
  highpass_filter: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.frequency === null || args.frequency === undefined || args.frequency <= 0) {
        throw new Error('Frequency must be a positive number');
      }

      const data = await processMedia('highpass_filter', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (highpass filter applied):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Highpass filter applied successfully.';
    } catch (error) {
      addMessage({ text: 'Error applying highpass filter: ' + error.message });
      return 'Failed to apply highpass filter: ' + error.message;
    }
  },
  
  lowpass_filter: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.frequency === null || args.frequency === undefined || args.frequency <= 0) {
        throw new Error('Frequency must be a positive number');
      }

      const data = await processMedia('lowpass_filter', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (lowpass filter applied):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Lowpass filter applied successfully.';
    } catch (error) {
      addMessage({ text: 'Error applying lowpass filter: ' + error.message });
      return 'Failed to apply lowpass filter: ' + error.message;
    }
  },
  
  echo_effect: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.delay === null || args.delay === undefined || args.decay === null || args.decay === undefined) {
        throw new Error('Delay and decay are required');
      }
      if (args.decay <= 0 || args.decay >= 1) {
        throw new Error('Decay must be between 0 and 1 (exclusive)');
      }

      const data = await processMedia('echo_effect', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (echo effect applied):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Echo effect applied successfully.';
    } catch (error) {
      addMessage({ text: 'Error applying echo effect: ' + error.message });
      return 'Failed to apply echo effect: ' + error.message;
    }
  },
  
  bass_adjustment: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.gain === null || args.gain === undefined) {
        throw new Error('Gain is required');
      }
      if (args.gain < -20 || args.gain > 20) {
        throw new Error('Gain must be between -20 and 20 dB');
      }

      const data = await processMedia('bass_adjustment', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (bass adjusted):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Bass adjusted successfully.';
    } catch (error) {
      addMessage({ text: 'Error adjusting bass: ' + error.message });
      return 'Failed to adjust bass: ' + error.message;
    }
  },
  
  treble_adjustment: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.gain === null || args.gain === undefined) {
        throw new Error('Gain is required');
      }

      const data = await processMedia('treble_adjustment', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (treble adjusted):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Treble adjusted successfully.';
    } catch (error) {
      addMessage({ text: 'Error adjusting treble: ' + error.message });
      return 'Failed to adjust treble: ' + error.message;
    }
  },
  
  equalizer: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.frequency === null || args.frequency === undefined || args.gain === null || args.gain === undefined) {
        throw new Error('Frequency and gain are required');
      }

      const data = await processMedia('equalizer', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (equalizer applied):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Equalizer applied successfully.';
    } catch (error) {
      addMessage({ text: 'Error applying equalizer: ' + error.message });
      return 'Failed to apply equalizer: ' + error.message;
    }
  },
  
  normalize_audio: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.target === null || args.target === undefined) {
        throw new Error('Target loudness is required');
      }
      if (args.target > 0) {
        throw new Error('Target must be a negative value (LUFS), e.g. -16');
      }
      const data = await processMedia('normalize_audio', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (audio normalized):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Audio normalized successfully.';
    } catch (error) {
      addMessage({ text: 'Error normalizing audio: ' + error.message });
      return 'Failed to normalize audio: ' + error.message;
    }
  },

  audio_compressor: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const threshold = args.threshold ?? 0;
      const ratio = args.ratio ?? 4;
      const attack = args.attack ?? 20;
      const release = args.release ?? 250;

      if (threshold < -60 || threshold > 0) {
        throw new Error('Threshold must be between -60 and 0 dB');
      }
      if (ratio < 1 || ratio > 20) {
        throw new Error('Ratio must be between 1 and 20');
      }
      if (attack < 0.01 || attack > 2000) {
        throw new Error('Attack must be between 0.01 and 2000 milliseconds');
      }
      if (release < 0.01 || release > 9000) {
        throw new Error('Release must be between 0.01 and 9000 milliseconds');
      }

      const data = await processMedia('audio_compressor', {
        threshold,
        ratio,
        attack,
        release
      }, videoFileData);
      setVideoFileData(data);
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (dynamic compression applied):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Dynamic audio compression applied successfully.';
    } catch (error) {
      addMessage({ text: 'Error applying dynamic compression: ' + error.message });
      return 'Failed to apply dynamic compression: ' + error.message;
    }
  },

  audio_dynamic_normalize: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const mode = args.mode ?? 'dynaudnorm';
      if (!['dynaudnorm', 'compand'].includes(mode)) {
        throw new Error('Mode must be either "dynaudnorm" or "compand"');
      }

      let normalizedArgs;
      if (mode === 'compand') {
        const attacks = args.attacks ?? 0.3;
        const decays = args.decays ?? 0.8;
        const points = args.points ?? '-70/-70|-40/-30|-20/-15|0/-12';
        const gain = args.gain ?? 3;

        if (attacks <= 0 || decays <= 0) {
          throw new Error('Attack and decay times must be positive');
        }
        if (typeof points !== 'string' || !/^(-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?)(\|-?\d+(?:\.\d+)?\/-?\d+(?:\.\d+)?)*$/.test(points)) {
          throw new Error('Points must use input/output dB pairs like "-70/-70|-40/-30|-20/-15|0/-12"');
        }
        if (gain < -20 || gain > 20) {
          throw new Error('Gain must be between -20 and 20 dB');
        }

        normalizedArgs = { mode, attacks, decays, points, gain };
      } else {
        const frame_length = args.frame_length ?? 150;
        const gaussian_size = args.gaussian_size ?? 31;

        if (frame_length < 10 || frame_length > 8000) {
          throw new Error('Frame length must be between 10 and 8000 milliseconds');
        }
        if (!Number.isInteger(gaussian_size) || gaussian_size < 3 || gaussian_size > 301 || gaussian_size % 2 === 0) {
          throw new Error('Gaussian size must be an odd integer between 3 and 301');
        }

        normalizedArgs = { mode, frame_length, gaussian_size };
      }

      const data = await processMedia('audio_dynamic_normalize', normalizedArgs, videoFileData);
      setVideoFileData(data);
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (dynamic audio normalized):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return mode === 'compand'
        ? 'Gentle compand dynamic control applied successfully.'
        : 'Dynamic audio normalization applied successfully.';
    } catch (error) {
      addMessage({ text: 'Error applying dynamic audio normalization: ' + error.message });
      return 'Failed to apply dynamic audio normalization: ' + error.message;
    }
  },
  
  delay_audio: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.delay === null || args.delay === undefined) {
        throw new Error('Delay is required');
      }
      if (args.delay < 0) {
        throw new Error('Delay must be a non-negative value');
      }

      const data = await processMedia('delay_audio', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (audio delayed):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Audio delayed successfully.';
    } catch (error) {
      addMessage({ text: 'Error delaying audio: ' + error.message });
      return 'Failed to delay audio: ' + error.message;
    }
  },
  
  adjust_brightness: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.brightness === null || args.brightness === undefined) {
        throw new Error('Brightness value is required');
      }
      if (args.brightness < -1 || args.brightness > 1) {
        throw new Error('Brightness must be between -1 and 1');
      }

      const data = await processMedia('adjust_brightness', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (brightness adjusted):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Brightness adjusted successfully.';
    } catch (error) {
      addMessage({ text: 'Error adjusting brightness: ' + error.message });
      return 'Failed to adjust brightness: ' + error.message;
    }
  },
  
  adjust_hue: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.degrees === null || args.degrees === undefined) {
        throw new Error('Hue degrees value is required');
      }
      if (args.degrees < -360 || args.degrees > 360) {
        throw new Error('Degrees must be between -360 and 360');
      }

      const data = await processMedia('adjust_hue', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (hue adjusted):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Hue adjusted successfully.';
    } catch (error) {
      addMessage({ text: 'Error adjusting hue: ' + error.message });
      return 'Failed to adjust hue: ' + error.message;
    }
  },
  
  adjust_saturation: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (args.saturation === null || args.saturation === undefined) {
        throw new Error('Saturation value is required');
      }
      if (args.saturation < 0 || args.saturation > 3) {
        throw new Error('Saturation must be between 0 and 3');
      }

      const data = await processMedia('adjust_saturation', args, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: 'Processed video (saturation adjusted):', videoUrl: videoUrl, mimeType: 'video/mp4' });
      return 'Saturation adjusted successfully.';
    } catch (error) {
      addMessage({ text: 'Error adjusting saturation: ' + error.message });
      return 'Failed to adjust saturation: ' + error.message;
    }
  },
  
  // Note: Some complex operations are not yet fully implemented
  // add_audio_track - needs multipart upload handling on server
  // convert_to_format - needs format-aware server handling
  
  get_video_info: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const fileMimeType = currentFileMimeType || 'video/mp4';
      if (clientEngine()) {
        const metadata = await engine.probeMedia(videoFileData, fileMimeType);
        lastExecution.executedOn = 'browser';
        const info = describeMediaInfo(metadata, videoFileData.length);
        addMessage({ text: info });
        return info;
      }
      const response = await fetch('/api/process-video', {
        method: 'POST',
        headers: {
          'Content-Type': fileMimeType,
          'x-operation': 'get_video_info',
          'x-args': JSON.stringify({}),
          ...(sampleModeEnabled && sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {})
        },
        body: videoFileData
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Server processing failed');
      }

      // Get metadata as JSON
      const metadata = await response.json();
      
      const info = describeMediaInfo(metadata);
      lastExecution.executedOn = 'server';

      addMessage({ text: info });
      return info;
    } catch (error) {
      addMessage({ text: 'Error getting video info: ' + error.message });
      return 'Failed to get video info: ' + error.message;
    }
  },
  
  add_audio_track: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (args.audioFile === null || args.audioFile === undefined) {
        throw new Error('audioFile is required');
      }

      const mode = args.mode || 'replace';
      if (mode !== 'replace' && mode !== 'mix') {
        throw new Error('Mode must be either "replace" or "mix"');
      }

      const volume = args.volume ?? 1.0;
      if (typeof volume !== 'number' || Number.isNaN(volume) || volume < 0 || volume > 2) {
        throw new Error('Volume must be between 0.0 and 2.0');
      }

      if (clientEngine()) {
        const audio = decodeAudioInput(args.audioFile);
        const data = await engine.addAudioTrack({ mode, volume }, videoFileData, currentFileMimeType, audio);
        lastExecution.executedOn = 'browser';
        setVideoFileData(data);
        addMessage({ text: `Processed video (audio track ${mode === 'mix' ? 'mixed' : 'replaced'}):`, videoUrl: URL.createObjectURL(new Blob([data], { type: 'video/mp4' })), mimeType: 'video/mp4' });
        return mode === 'mix' ? 'Audio track mixed successfully.' : 'Audio track replaced successfully.';
      }

      const normalizedAudioFile = normalizeAudioFileInput(args.audioFile);
      // add_audio_track requires secondary binary audio input; use FormData so both files are sent together
      const fileMimeType = currentFileMimeType || 'video/mp4';
      const formData = new FormData();
      const videoBlob = new Blob([videoFileData], { type: fileMimeType });
      formData.append('video', videoBlob, 'input.mp4');
      formData.append('operation', 'add_audio_track');
      formData.append('args', JSON.stringify({ audioFile: normalizedAudioFile, mode, volume }));

      const response = await fetch('/api/process-video', {
        method: 'POST',
        headers: sampleModeEnabled && sampleModeAccessToken
          ? { 'sample-access-token': sampleModeAccessToken }
          : undefined,
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Server processing failed');
      }

      // Stream the response
      const data = await collectStreamChunks(response.body.getReader());

      setVideoFileData(data);
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: `Processed video (audio track ${mode === 'mix' ? 'mixed' : 'replaced'}):`, videoUrl: videoUrl, mimeType: 'video/mp4' });
      return mode === 'mix' ? 'Audio track mixed successfully.' : 'Audio track replaced successfully.';
    } catch (error) {
      addMessage({ text: 'Error adding audio track: ' + error.message });
      return 'Failed to add audio track: ' + error.message;
    }
  },
  
  convert_to_format: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // This would need format-aware server handling
      addMessage({ text: 'Format conversion is not yet implemented on server-side' });
      return 'Feature not yet available with server-side processing';
    } catch (error) {
      addMessage({ text: 'Error converting format: ' + error.message });
      return 'Failed to convert format: ' + error.message;
    }
  },

  convert_video_format: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (!args.format) {
        throw new Error('Target format is required');
      }
      if (!SUPPORTED_VIDEO_FORMATS.includes(args.format)) {
        throw new Error(`Unsupported format: ${args.format}. Supported formats: ${SUPPORTED_VIDEO_FORMATS.join(', ')}`);
      }

      const mimeType = VIDEO_MIME_TYPES[args.format] || 'video/mp4';

      const data = await processMedia('convert_video_format', args, videoFileData);
      setVideoFileData(data);
      const videoUrl = URL.createObjectURL(new Blob([data], { type: mimeType }));
      addMessage({ text: `Converted video to ${args.format.toUpperCase()} format:`, videoUrl: videoUrl, mimeType: mimeType });
      return `Video converted to ${args.format} successfully.`;
    } catch (error) {
      addMessage({ text: 'Error converting video format: ' + error.message });
      return 'Failed to convert video format: ' + error.message;
    }
  },

  convert_audio_format: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (!args.format) {
        throw new Error('Target audio format is required');
      }
      if (!SUPPORTED_AUDIO_FORMATS.includes(args.format)) {
        throw new Error(`Unsupported format: ${args.format}. Supported formats: ${SUPPORTED_AUDIO_FORMATS.join(', ')}`);
      }

      const mimeType = AUDIO_MIME_TYPES[args.format] || 'audio/mpeg';

      const data = await processMedia('convert_audio_format', args, videoFileData);
      setVideoFileData(data);
      const audioUrl = URL.createObjectURL(new Blob([data], { type: mimeType }));
      addMessage({ text: `Converted audio to ${args.format.toUpperCase()} format:`, videoUrl: audioUrl, mimeType: mimeType });
      return `Audio converted to ${args.format} successfully.`;
    } catch (error) {
      addMessage({ text: 'Error converting audio format: ' + error.message });
      return 'Failed to convert audio format: ' + error.message;
    }
  },

  extract_audio: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const format = args.format || 'mp3';
      if (!SUPPORTED_EXTRACT_FORMATS.includes(format)) {
        throw new Error(`Unsupported format: ${format}. Supported formats: ${SUPPORTED_EXTRACT_FORMATS.join(', ')}`);
      }

      const mimeType = AUDIO_MIME_TYPES[format] || 'audio/mpeg';

      const data = await processMedia('extract_audio', { ...args, format }, videoFileData);
      setVideoFileData(data);
      const audioUrl = URL.createObjectURL(new Blob([data], { type: mimeType }));
      addMessage({ text: `Extracted audio as ${format.toUpperCase()}:`, videoUrl: audioUrl, mimeType: mimeType });
      return `Audio extracted as ${format} successfully.`;
    } catch (error) {
      addMessage({ text: 'Error extracting audio: ' + error.message });
      return 'Failed to extract audio: ' + error.message;
    }
  },

  get_supported_formats: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (clientEngine()) {
        lastExecution.executedOn = 'browser';
        const info = `Supported conversion formats:
- Video formats: ${SUPPORTED_VIDEO_FORMATS.join(', ')}
- Video codecs: ${SUPPORTED_VIDEO_CODECS.join(', ')}
- Audio formats: ${SUPPORTED_AUDIO_FORMATS.join(', ')}
- Audio bitrates: ${SUPPORTED_AUDIO_BITRATES.join(', ')}
- Extract audio formats: ${SUPPORTED_EXTRACT_FORMATS.join(', ')}
- Photo formats: ${PHOTO_OUTPUT_FORMATS.join(', ')}`;
        addMessage({ text: info });
        return info;
      }
      const response = await fetch('/api/supported-formats', {
        method: 'GET',
        headers: sampleModeEnabled && sampleModeAccessToken
          ? { 'sample-access-token': sampleModeAccessToken }
          : undefined
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch supported formats');
      }

      const formats = await response.json();
      const info = `Supported conversion formats:
- Video formats: ${formats.video.formats.join(', ')}
- Video codecs: ${formats.video.codecs.join(', ')}
- Audio formats: ${formats.audio.formats.join(', ')}
- Audio bitrates: ${formats.audio.bitrates.join(', ')}
- Extract audio formats: ${formats.extract.formats.join(', ')}`;

      addMessage({ text: info });
      return info;
    } catch (error) {
      addMessage({ text: 'Error fetching supported formats: ' + error.message });
      return 'Failed to fetch supported formats: ' + error.message;
    }
  },
  
  resize_to_aspect_ratio: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      // Validate inputs
      if (!args.ratio || !ASPECT_RATIO_PRESETS[args.ratio]) {
        throw new Error('Invalid aspect ratio. Must be one of: ' + Object.keys(ASPECT_RATIO_PRESETS).join(', '));
      }
      
      const preset = ASPECT_RATIO_PRESETS[args.ratio];
      const fitMode = args.fit || 'contain';
      
      // For now, use simple resize - more complex fitting logic would need server implementation
      const data = await processMedia('resize_video', { 
        width: preset.width, 
        height: preset.height 
      }, videoFileData);
      setVideoFileData(data); // Update video data for subsequent edits
      
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: `Processed video (resized to ${args.ratio}):\n${preset.description}`, videoUrl: videoUrl, mimeType: 'video/mp4' });
      return `Video resized to ${args.ratio} aspect ratio successfully.`;
    } catch (error) {
      addMessage({ text: 'Error resizing to aspect ratio: ' + error.message });
      return 'Failed to resize to aspect ratio: ' + error.message;
    }
  },
  
  add_video_transition: async (args, videoFileData, setVideoFileData, addMessage, uploadedVideos) => {
    try {
      // Use uploaded videos if available, otherwise expect videos in args
      let videosToProcess = [];
      
      if (uploadedVideos && uploadedVideos.length >= 2) {
        // Use the uploaded videos from the UI
        videosToProcess = uploadedVideos.map(v => v.data);
      } else if (args.videos && Array.isArray(args.videos) && args.videos.length >= 2) {
        // Fallback to videos passed in args (for testing or direct calls)
        videosToProcess = args.videos;
      } else {
        throw new Error('At least two video clips are required for transitions. Please upload multiple videos first.');
      }
      
      if (!args.transition) {
        throw new Error('Transition type is required');
      }

      if (clientEngine()) {
        const data = await engine.joinClips({ transition: args.transition, duration: args.duration || 1 }, videosToProcess);
        lastExecution.executedOn = 'browser';
        setVideoFileData(data);
        addMessage({ text: `Processed video with ${args.transition} transition between ${videosToProcess.length} clips:`, videoUrl: URL.createObjectURL(new Blob([data], { type: 'video/mp4' })), mimeType: 'video/mp4' });
        return `Video transition (${args.transition}) applied successfully to ${videosToProcess.length} clips.`;
      }

      const formData = new FormData();
      
      // Add all video files
      videosToProcess.forEach((videoData, index) => {
        const videoBlob = new Blob([videoData], { type: 'video/mp4' });
        formData.append('videos', videoBlob, `input-${index}.mp4`);
      });
      
      formData.append('transition', args.transition);
      formData.append('duration', args.duration || 1);
      
      const response = await fetch('/api/transition-videos', {
        method: 'POST',
        headers: sampleModeEnabled ? {
          ...(sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {})
        } : undefined,
        body: formData
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Server processing failed');
      }
      
      // Get the processed video as array buffer
      const arrayBuffer = await response.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      
      setVideoFileData(data); // Update video data for subsequent edits
      const videoUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      addMessage({ text: `Processed video with ${args.transition} transition between ${videosToProcess.length} clips:`, videoUrl: videoUrl, mimeType: 'video/mp4' });
      return `Video transition (${args.transition}) applied successfully to ${videosToProcess.length} clips.`;
    } catch (error) {
      addMessage({ text: 'Error applying video transition: ' + error.message });
      return 'Failed to apply video transition: ' + error.message;
    }
  },
  
  apply_color_filter: async (args, videoFileData, setVideoFileData, addMessage) => {
    if (!args || !args.filter) {
      addMessage({ text: 'Error applying color filter: filter is required' });
      return 'Failed to apply color filter: filter is required';
    }
    return runVisualEdit('apply_color_filter', args, videoFileData, setVideoFileData, addMessage, `${args.filter} color filter`);
  },

  adjust_contrast: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('adjust_contrast', args, videoFileData, setVideoFileData, addMessage, 'contrast adjustment'),

  flip_video_vertical: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('flip_video_vertical', args, videoFileData, setVideoFileData, addMessage, 'vertical flip'),

  convert_image_format: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('convert_image_format', args, videoFileData, setVideoFileData, addMessage, `conversion to ${args?.format || 'image'}`),

  // Aliases for backward compatibility with tests
  adjust_audio_volume: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.adjust_volume(args, videoFileData, setVideoFileData, addMessage),
  audio_highpass: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.highpass_filter(args, videoFileData, setVideoFileData, addMessage),
  audio_lowpass: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.lowpass_filter(args, videoFileData, setVideoFileData, addMessage),
  audio_echo: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.echo_effect(args, videoFileData, setVideoFileData, addMessage),
  adjust_bass: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.bass_adjustment(args, videoFileData, setVideoFileData, addMessage),
  adjust_treble: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.treble_adjustment(args, videoFileData, setVideoFileData, addMessage),
  audio_equalizer: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.equalizer(args, videoFileData, setVideoFileData, addMessage),
  audio_delay: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.delay_audio(args, videoFileData, setVideoFileData, addMessage),
  // The remaining audio effects: the engine runs them (and the consent fallback covers the ones
  // the browser cannot, like vibrato). They were offered to the model without an implementation.
  audio_chorus: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_chorus', args, videoFileData, setVideoFileData, addMessage, 'chorus effect'),
  audio_flanger: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_flanger', args, videoFileData, setVideoFileData, addMessage, 'flanger effect'),
  audio_phaser: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_phaser', args, videoFileData, setVideoFileData, addMessage, 'phaser effect'),
  audio_tremolo: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_tremolo', args, videoFileData, setVideoFileData, addMessage, 'tremolo effect'),
  audio_vibrato: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_vibrato', args, videoFileData, setVideoFileData, addMessage, 'vibrato effect'),
  audio_gate: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_gate', args, videoFileData, setVideoFileData, addMessage, 'noise gate'),
  audio_stereo_widen: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_stereo_widen', args, videoFileData, setVideoFileData, addMessage, 'stereo widening'),
  audio_reverse: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_reverse', args, videoFileData, setVideoFileData, addMessage, 'audio reversal'),
  audio_limiter: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_limiter', args, videoFileData, setVideoFileData, addMessage, 'limiter'),
  audio_silence_remove: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_silence_remove', args, videoFileData, setVideoFileData, addMessage, 'silence removal'),
  audio_pan: async (args, videoFileData, setVideoFileData, addMessage) =>
    runVisualEdit('audio_pan', args, videoFileData, setVideoFileData, addMessage, 'stereo pan'),
  resize_video_preset: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      if (!args.preset) {
        throw new Error('Preset is required');
      }
      if (!ASPECT_RATIO_PRESETS[args.preset]) {
        throw new Error('Invalid preset: ' + args.preset + '. Must be one of: ' + Object.keys(ASPECT_RATIO_PRESETS).join(', '));
      }
      const preset = ASPECT_RATIO_PRESETS[args.preset];
      const data = await processMedia('resize_video', {
        width: preset.width,
        height: preset.height
      }, videoFileData);
      setVideoFileData(data);
      // A photo comes back as an image, not an mp4.
      const resultType = (lastResultContentType || 'video/mp4').split(';')[0].trim();
      const isPhoto = resultType.startsWith('image/');
      const videoUrl = URL.createObjectURL(new Blob([data], { type: resultType }));
      addMessage({ text: `Processed ${isPhoto ? 'photo' : 'video'} (resized to ${args.preset}):\n${preset.description}`, videoUrl: videoUrl, mimeType: resultType });
      return `${isPhoto ? 'Photo' : 'Video'} resized to ${args.preset} aspect ratio successfully.`;
    } catch (error) {
      addMessage({ text: 'Error resizing video to preset: ' + error.message });
      return 'Failed to resize video to preset: ' + error.message;
    }
  },
  get_video_dimensions: async (args, videoFileData, setVideoFileData, addMessage) => 
    toolFunctions.get_video_info(args, videoFileData, setVideoFileData, addMessage),

  generate_captions: async (args, inputVideoFileData, setVideoFileData, addMessage) => {
    try {
      if (clientEngine()) return await generateCaptionsInBrowser(args, inputVideoFileData, setVideoFileData, addMessage);
      // Never caption on top of burned captions (that is what showed the text twice): re-burn
      // from the uncaptioned source, or refuse if other edits were applied on top since.
      const { bytes: videoFileData, replacing } = captionSourceFor(inputVideoFileData);
      const replacedNote = replacing ? ' Replaced the captions burned earlier (re-burned from the uncaptioned video).' : '';
      const language = args.language || 'auto';
      const translateLanguage = args.translate_language || null;
      const burnIn = args.burn_in !== false; // default true
      const style = args.style || 'default';
      const position = args.position || 'bottom';

      const fileMimeType = currentFileMimeType || 'video/mp4';
      const sampleHeaders = sampleModeEnabled && sampleModeAccessToken
        ? { 'sample-access-token': sampleModeAccessToken }
        : {};

      // Step 1: Generate captions via OpenAI speech-to-text (server)
      const captionResponse = await fetch('/api/generate-captions', {
        method: 'POST',
        headers: {
          'Content-Type': fileMimeType,
          'x-args': JSON.stringify({ language }),
          ...sampleHeaders,
        },
        body: videoFileData
      });

      if (!captionResponse.ok) {
        let errorData = {};
        try { errorData = await captionResponse.json(); } catch (_) {}
        throw new Error(errorData.error || 'Failed to generate captions');
      }

      const { srt, vtt } = await captionResponse.json();

      if (!srt || !String(srt).trim()) {
        throw new Error('No captions were generated from the audio');
      }

      // Step 2: Excerpt + soft-track preview URLs
      const srtBlob = new Blob([srt], { type: 'text/plain' });
      const srtUrl = URL.createObjectURL(srtBlob);
      const lines = srt.split('\n').filter(l => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes('-->'));
      const excerpt = lines.slice(0, 4).join(' ').substring(0, 200);
      const vttBlob = new Blob([vtt], { type: 'text/vtt' });
      const vttUrl = URL.createObjectURL(vttBlob);
      const originalVideoUrl = URL.createObjectURL(new Blob([videoFileData], { type: fileMimeType }));
      const langDesc = language === 'auto' ? 'auto-detected' : language;

      let translatedSrt = null;
      let translatedVtt = null;

      // Step 3: Optional translation (Grok) — server locks original timestamps
      if (translateLanguage) {
        const translateResponse = await fetch('/api/translate-captions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...sampleHeaders,
          },
          body: JSON.stringify({ srtContent: srt, targetLanguage: translateLanguage })
        });

        if (!translateResponse.ok) {
          let errorData = {};
          try { errorData = await translateResponse.json(); } catch (_) {}
          throw new Error(errorData.error || 'Failed to translate captions');
        }

        const translationResult = await translateResponse.json();
        translatedSrt = translationResult.srt;
        translatedVtt = translationResult.vtt;
      }

      // Step 4: Soft preview (always useful) or burn-in into video
      if (!burnIn) {
        addMessage({
          text: `Captions generated! Preview: "${excerpt}${lines.length > 4 ? '...' : ''}"\n\nSoft subtitles (${langDesc}). SRT: ${srtUrl}`,
          videoUrl: originalVideoUrl,
          mimeType: fileMimeType,
          vttUrl: vttUrl,
        });
        if (translatedSrt) {
          const translatedSrtBlob = new Blob([translatedSrt], { type: 'text/plain' });
          addMessage({ text: `Translated subtitles (${translateLanguage}):`, videoUrl: URL.createObjectURL(translatedSrtBlob), videoType: 'subtitle-srt', mimeType: 'text/plain' });
          const translatedVttUrl = URL.createObjectURL(new Blob([translatedVtt], { type: 'text/vtt' }));
          addMessage({ text: `Video with translated soft subtitles (${translateLanguage}):`, videoUrl: originalVideoUrl, mimeType: fileMimeType, vttUrl: translatedVttUrl });
          return `Captions generated (${langDesc}) and translated to ${translateLanguage}. Soft tracks only (burn_in=false).`;
        }
        return `Captions generated successfully (${langDesc}). Soft subtitle track only (burn_in=false).`;
      }

      // burn_in: multipart → process-video burn_subtitles (supports dual-track)
      const formData = new FormData();
      formData.append('video', new Blob([videoFileData], { type: fileMimeType }), 'input.mp4');
      formData.append('operation', 'burn_subtitles');
      const burnArgs = {
        srtContent: srt,
        style,
        position,
      };
      if (translatedSrt) {
        burnArgs.translatedSrtContent = translatedSrt;
      }
      formData.append('args', JSON.stringify(burnArgs));

      const burnResponse = await fetch('/api/process-video', {
        method: 'POST',
        headers: sampleHeaders,
        body: formData,
      });

      if (!burnResponse.ok) {
        let errorData = {};
        try { errorData = await burnResponse.json(); } catch (_) {}
        // Fall back to soft tracks rather than hard-failing the whole caption flow
        addMessage({
          text: `Captions ready but burn-in failed (${errorData.error || burnResponse.status}). Showing soft subtitles instead.`,
          videoUrl: originalVideoUrl,
          mimeType: fileMimeType,
          vttUrl: translatedVtt ? URL.createObjectURL(new Blob([translatedVtt], { type: 'text/vtt' })) : vttUrl,
        });
        return `Captions generated (${langDesc}) but burn-in failed: ${errorData.error || burnResponse.status}. Soft subtitles shown.`;
      }

      const burned = await collectStreamChunks(burnResponse.body.getReader());
      recordCaptionBurn(videoFileData, burned);
      setVideoFileData(burned);
      const burnedUrl = URL.createObjectURL(new Blob([burned], { type: 'video/mp4' }));
      const dual = translatedSrt ? ` Dual-track burn-in (translated ${translateLanguage} + original).` : '';
      addMessage({
        // Do not echo the caption text in the chat bubble above the burned
        // video; the text is already present in the rendered video.
        text: `Captions burned in (${langDesc}).${dual}`,
        videoUrl: burnedUrl,
        mimeType: 'video/mp4',
      });
      addMessage({ text: 'SRT download:', videoUrl: srtUrl, videoType: 'subtitle-srt', mimeType: 'text/plain' });
      if (translatedSrt) {
        addMessage({
          text: `Translated SRT (${translateLanguage}):`,
          videoUrl: URL.createObjectURL(new Blob([translatedSrt], { type: 'text/plain' })),
          videoType: 'subtitle-srt',
          mimeType: 'text/plain',
        });
      }
      return `Captions generated (${langDesc})${translatedSrt ? ` and translated to ${translateLanguage}` : ''} with burn-in.${replacedNote}`;
    } catch (error) {
      addMessage({ text: 'Error generating captions: ' + error.message });
      return 'Failed to generate captions: ' + error.message;
    }
  },

  // Audio-in, captions-out: only the WAV goes up for transcription. The web app has no
  // client-side ffmpeg, so the burn-in uses the server fallback (the video is uploaded for that
  // step, as for every other web edit).
  lyric_captions: async (args, inputVideoFileData, setVideoFileData, addMessage) => {
    try {
      // Same rule as generate_captions: never burn on top of burned captions.
      const { bytes: videoFileData, replacing } = captionSourceFor(inputVideoFileData);
      if ((currentFileMimeType || '').startsWith('image/')) throw new Error('Lyric captions are not supported for photos');
      if (!args?.target_language) throw new Error('target_language is required');
      const headers = sampleModeEnabled && sampleModeAccessToken ? { 'sample-access-token': sampleModeAccessToken } : {};
      if (clientEngine()) return await lyricCaptionsInBrowser(args, videoFileData, replacing, setVideoFileData, addMessage);
      addMessage({ text: 'Extracting audio and transcribing lyrics…' });
      const { burned, summary, result, audioBytes } = await runLyricCaptionsWeb(args, videoFileData, { headers });
      recordCaptionBurn(videoFileData, burned);
      setVideoFileData(burned);
      const lines = result.lines?.length || 0;
      const songText = describeSong(result.song);
      const kb = (n) => `${Math.round(n / 1024)} KB`;
      addMessage({
        // No lyric text in the bubble: it is in the video.
        text: `Bilingual captions burned in (${lines} lines, ${result.language || 'auto'} → ${result.targetLanguage}). ${songText}`,
        videoUrl: URL.createObjectURL(new Blob([burned], { type: 'video/mp4' })),
        mimeType: 'video/mp4',
      });
      return `lyric_captions done: ${lines} lines, ${result.language || 'auto'} → ${result.targetLanguage} (${summary?.translatedCount ?? lines} translated), mode ${result.mode}. ${songText}${replacing ? ' Replaced the captions burned earlier.' : ''} Uploaded ${kb(audioBytes)} of audio for transcription; burn-in: server fallback (the web app has no client-side ffmpeg).`;
    } catch (error) {
      addMessage({ text: 'Error creating lyric captions: ' + error.message });
      return `Failed to create lyric captions${error.code ? ` (${error.code})` : ''}: ${error.message}`;
    }
  },

  // The generic fallback of the in-browser editor: one validated FFmpeg command, run in ffmpeg.wasm.
  run_ffmpeg: async (args, videoFileData, setVideoFileData, addMessage) => {
    try {
      const { data, format } = await engine.runCliCommand(args?.command, videoFileData, currentFileMimeType, await loadCapabilityCatalog());
      lastExecution.executedOn = 'browser';
      const mimeType = CLI_MIME_TYPES[format] || 'application/octet-stream';
      if (mimeType.startsWith('video/')) setVideoFileData(data);
      const explanation = typeof args.explanation === 'string' && args.explanation.trim() ? args.explanation.trim() : args.command;
      addMessage({ text: `Processed with FFmpeg: ${explanation}`, videoUrl: URL.createObjectURL(new Blob([data], { type: mimeType })), mimeType });
      return `FFmpeg command ran successfully (${args.command}).`;
    } catch (error) {
      lastExecution.errorCode = lastExecution.errorCode || error?.code || null;
      addMessage({ text: 'Error running FFmpeg: ' + error.message });
      return 'Failed to run FFmpeg: ' + error.message;
    }
  },

  ffmpeg_cli: async (args, videoFileData, setVideoFileData, addMessage) => {
    const authHeaders = ffmpegCliAuthHeaders();
    try {
      const { action, ...params } = args || {};
      if (action === 'discover' || action === 'plan') {
        const response = await fetch('/api/ffmpeg-cli', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ action, ...params })
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok && !body.errors) throw new Error(body.error || 'FFmpeg CLI request failed');
        return JSON.stringify(body);
      }
      if (action !== 'run') throw new Error('action must be discover, plan or run');

      return await runFfmpegOnServer(params, videoFileData, setVideoFileData, addMessage, authHeaders);
    } catch (error) {
      addMessage({ text: 'Error running FFmpeg: ' + error.message });
      return 'Failed to run FFmpeg: ' + error.message;
    }
  },

};
