// The app's one in-browser FFmpeg engine: load (lazy, cached), run, progress, cancel and
// file-system cleanup for every edit. Nothing here uploads media; ffmpegHost.js loads the core
// (multithreaded when the page is cross-origin isolated, single-thread otherwise).
import { FFmpegHost } from './ffmpegHost.js';
import { buildProcessArgs, resolveOutput, audioFadeNeedsDuration, OpArgsError } from './ops/process.js';
import {
  buildTransitionArgs, buildAddAudioTrackArgs, buildBurnSubtitlesArgs, buildBurnAssArgs, buildSpeechAudioArgs,
  buildThumbnailArgs, parseCliCommand,
} from './ops/multi.js';
import { getFetchAbortSignal } from '../abortableFetch.js';
import fontUrl from '../../scripts/asc/fonts/Inter-Bold.ttf?url';

export const FONT_FILE = 'Inter-Bold.ttf';
export const FONT_FAMILY = 'Inter';

const EXT_BY_MIME = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv', 'video/x-flv': 'flv', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/x-ms-wma': 'wma',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heic',
};
const IMAGE_FORMAT_BY_EXT = { jpg: 'jpeg', png: 'png', webp: 'webp', gif: 'gif', bmp: 'bmp', tiff: 'tiff', heic: 'heic' };

// ─── Engine state (what the UI shows) ────────────────────────────────────────

/** @typedef {{ phase: 'idle'|'loading'|'ready'|'running'|'error', mode: 'mt'|'st'|null, progress: number|null, etaSeconds: number|null, error: string|null }} EngineState */
let state = { phase: 'idle', mode: null, progress: null, etaSeconds: null, error: null };
const listeners = new Set();

function setState(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function getEngineState() {
  return state;
}

/** Call `listener(state)` on every change. Returns the unsubscribe function. */
export function subscribeEngine(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let jobStartedAt = 0;
function onProgress({ progress }) {
  // FFmpeg reports nonsense (negative or huge) values for some inputs; those show as "unknown".
  if (!Number.isFinite(progress) || progress < 0 || progress > 1.05) return;
  const p = Math.min(1, progress);
  const elapsed = (performance.now() - jobStartedAt) / 1000;
  const etaSeconds = p > 0.02 && elapsed > 1 ? Math.max(0, Math.round((elapsed * (1 - p)) / p)) : null;
  // Far more reports arrive than the percentage changes.
  if (Math.round(p * 100) === Math.round((state.progress ?? -1) * 100) && etaSeconds === state.etaSeconds) return;
  setState({ progress: p, etaSeconds });
}

let host = null;
/** The shared host. `?wasm=st|mt` in the page URL overrides the core choice (debugging). */
export function getHost() {
  if (!host) {
    const override = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('wasm') : null;
    host = new FFmpegHost({ override, onProgress, selfHostedWorker: true });
  }
  return host;
}

/** Download and start the core. Called on the first edit; the result is cached for later ones. */
export async function loadEngine() {
  const h = getHost();
  if (h.ffmpeg) return { mode: h.mode, loadMs: h.loadMs };
  if (state.phase !== 'running') setState({ phase: 'loading', error: null });
  try {
    const loaded = await h.load();
    if (state.phase === 'loading') setState({ phase: 'ready', mode: loaded.mode });
    else setState({ mode: loaded.mode });
    return loaded;
  } catch (error) {
    setState({ phase: 'error', error: String(error?.message || error) });
    throw Object.assign(new Error(`The video engine could not be loaded: ${error?.message || error}`), { code: 'wasm_load_failed', cause: error });
  }
}

/** Stop the running job, if any. The worker is terminated and reloads on the next edit. */
export function cancelEngine() {
  if (state.phase !== 'running') return;
  host?.terminate();
  setState({ phase: 'idle', progress: null, etaSeconds: null });
}

const OOM = /out of memory|cannot enlarge memory|memory access out of bounds|allocation failed|invalid array (buffer )?length|aborted\(\s*oom|\boom\b/i;

/** True when the error means the tab ran out of memory for this clip. */
export function isOutOfMemory(error) {
  return error?.code === 'wasm_oom' || error instanceof RangeError || OOM.test(`${error?.message || ''}\n${error?.stderr || ''}`);
}

// Turn a raw failure into one the UI can explain: out of memory, or ffmpeg's own last words.
function describe(error) {
  if (error?.code === 'cancelled' || error instanceof OpArgsError) return error;
  if (isOutOfMemory(error)) {
    return Object.assign(new Error('This clip is too large for the browser\'s memory. Try a shorter clip or a lower resolution.'), { code: 'wasm_oom', cause: error });
  }
  // The last lines of ffmpeg's log usually name the real problem ("Invalid argument", codec…).
  const tail = String(error?.stderr || '').split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' | ');
  if (tail && error.code === 'wasm_exec_failed') error.message = `${error.message}: ${tail}`;
  return error;
}

async function run(job) {
  await loadEngine();
  jobStartedAt = performance.now();
  setState({ phase: 'running', progress: null, etaSeconds: null, error: null });
  try {
    const result = await getHost().runJob({ signal: getFetchAbortSignal() || undefined, ...job });
    if (!result.data?.length) throw Object.assign(new Error('FFmpeg produced an empty file'), { code: 'wasm_exec_failed' });
    setState({ phase: 'ready', progress: 1, etaSeconds: 0 });
    return result;
  } catch (error) {
    const described = describe(error);
    setState({ phase: described.code === 'cancelled' ? 'idle' : 'error', progress: null, etaSeconds: null, error: described.code === 'cancelled' ? null : described.message });
    throw described;
  }
}

async function probeFile(file) {
  await loadEngine();
  return getHost().probe(file, { signal: getFetchAbortSignal() || undefined });
}

const baseMime = (mime) => String(mime || '').split(';')[0].trim().toLowerCase();

function toFile(bytes, mime, stem = 'input') {
  const type = baseMime(mime) || 'video/mp4';
  return new File([bytes], `${stem}.${EXT_BY_MIME[type] || 'mp4'}`, { type });
}

let fontPromise = null;
function loadFont() {
  if (!fontPromise) {
    fontPromise = fetch(fontUrl)
      .then((res) => { if (!res.ok) throw new Error(`Could not load the caption font (${res.status})`); return res.arrayBuffer(); })
      .then((buf) => new Uint8Array(buf))
      .catch((e) => { fontPromise = null; throw e; });
  }
  return fontPromise;
}

/** True when every character of `text` can be drawn with the bundled (Latin, Greek, Cyrillic) font. */
export function fontCovers(text) {
  // eslint-disable-next-line no-control-regex
  return !/[^\u0000-ԯḀ-ỿ -⁯₠-₿℀-⅏←-⇿∀-⋿]/.test(String(text || ''));
}

/** Summary of an ffprobe result: the small facts the model is told about a clip. */
export function summarizeProbe(metadata) {
  const streams = metadata?.streams || [];
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');
  const formatDuration = Number(metadata?.format?.duration);
  const durations = streams.map(s => Number(s.duration)).filter(n => Number.isFinite(n) && n > 0);
  const [fpsNum, fpsDen] = String(video?.avg_frame_rate || video?.r_frame_rate || '').split('/').map(Number);
  const fps = fpsNum > 0 && fpsDen > 0 ? Math.round((fpsNum / fpsDen) * 100) / 100 : null;
  return {
    duration: Number.isFinite(formatDuration) && formatDuration > 0 ? formatDuration : (durations.length ? Math.max(...durations) : null),
    width: Number(video?.width) || null,
    height: Number(video?.height) || null,
    fps,
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
  };
}

/** ffprobe JSON (`format` + `streams`) for media bytes. */
export function probeMedia(bytes, mime) {
  return probeFile(toFile(bytes, mime));
}

// FFmpeg 5.1 (the wasm core) has no HEIF demuxer. Browsers that can decode HEIC (Safari) turn it
// into a PNG first; elsewhere the photo cannot be edited in the browser.
async function heicToPng(bytes) {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/heic' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  } catch {
    throw new OpArgsError('This browser cannot read HEIC photos.', 'unsupported_in_browser');
  }
}

/**
 * Run one single-input operation (the old POST /api/process-video) in the browser.
 * @returns {Promise<{ data: Uint8Array, contentType: string }>}
 */
export async function processMedia(operation, args, bytes, mime) {
  const type = baseMime(mime) || 'video/mp4';
  const isPhoto = type.startsWith('image/');
  const imageFormat = isPhoto ? (IMAGE_FORMAT_BY_EXT[EXT_BY_MIME[type]] || 'png') : undefined;
  // Validates the operation for this media type before any work starts.
  const { outName, contentType } = resolveOutput(operation, args, { isPhoto, imageFormat });
  if (operation === 'add_text' && !fontCovers(args?.text)) {
    throw new OpArgsError('This text uses characters the in-browser font cannot draw.', 'unsupported_in_browser');
  }

  let file = toFile(bytes, type);
  if (imageFormat === 'heic') file = toFile(await heicToPng(bytes), 'image/png');
  const files = operation === 'add_text' ? [{ name: FONT_FILE, data: await loadFont() }] : [];
  // A fade without `start` is placed from the clip's length.
  const needsDuration = (operation === 'audio_fade' && audioFadeNeedsDuration(args)) || operation === 'fade_transition';
  const duration = needsDuration ? summarizeProbe(await probeFile(file)).duration : undefined;

  const { data } = await run({
    inputs: [file],
    files,
    outName,
    buildArgv: ({ inputs, output, dir, threads }) => buildProcessArgs(operation, args, {
      input: inputs[0], output, threads, isPhoto, imageFormat, duration, fontFile: `${dir}/${FONT_FILE}`,
    }),
  });
  return { data, contentType };
}

/** Join clips (the old POST /api/transition-videos). `clips` are Uint8Arrays of video bytes. */
export async function joinClips({ transition, duration }, clips) {
  const files = clips.map((bytes, i) => toFile(bytes, 'video/mp4', `clip${i}`));
  const info = [];
  for (const file of files) info.push(summarizeProbe(await probeFile(file)));
  if (info.some(i => !i.width)) throw new OpArgsError('Video transitions are not supported for photos or audio files');
  const { data } = await run({
    inputs: files,
    buildArgv: ({ inputs, output, threads }) => buildTransitionArgs({ transition, duration }, inputs.map((path, i) => ({ path, ...info[i] })), { output, threads }),
  });
  return data;
}

/** Replace or mix the audio track. `audio` is { bytes, extension }. */
export async function addAudioTrack({ mode, volume }, videoBytes, mime, audio) {
  const video = toFile(videoBytes, mime);
  const sourceHasAudio = mode === 'mix' ? summarizeProbe(await probeFile(video)).hasAudio : false;
  const { data } = await run({
    inputs: [video, new File([audio.bytes], `track.${audio.extension || 'mp3'}`)],
    buildArgv: ({ inputs, output }) => buildAddAudioTrackArgs({ mode, volume }, { video: inputs[0], audio: inputs[1], output, sourceHasAudio }),
  });
  return data;
}

/** Burn one or two SRT tracks into the video with the bundled font. */
export async function burnSubtitles({ srt, translatedSrt, style, position }, videoBytes, mime) {
  if (!fontCovers(`${srt}\n${translatedSrt || ''}`)) {
    throw new OpArgsError('These captions use characters the in-browser font cannot draw.', 'unsupported_in_browser');
  }
  const encoder = new TextEncoder();
  const files = [{ name: FONT_FILE, data: await loadFont() }, { name: 'subs.srt', data: encoder.encode(srt) }];
  if (translatedSrt) files.push({ name: 'translated.srt', data: encoder.encode(translatedSrt) });
  const { data } = await run({
    inputs: [toFile(videoBytes, mime)],
    files,
    buildArgv: ({ inputs, output, dir, threads }) => buildBurnSubtitlesArgs({ style, position }, {
      input: inputs[0], output, threads, fontsDir: dir, fontName: FONT_FAMILY,
      srtPath: `${dir}/subs.srt`, translatedSrtPath: translatedSrt ? `${dir}/translated.srt` : null,
    }),
  });
  return data;
}

/** Burn an ASS script (lyric captions) with the bundled font. */
export async function burnAss(ass, videoBytes, mime) {
  if (!fontCovers(ass)) throw new OpArgsError('These captions use characters the in-browser font cannot draw.', 'unsupported_in_browser');
  const { data } = await run({
    inputs: [toFile(videoBytes, mime)],
    files: [{ name: FONT_FILE, data: await loadFont() }, { name: 'lyrics.ass', data: new TextEncoder().encode(ass) }],
    buildArgv: ({ inputs, output, dir, threads }) => buildBurnAssArgs({ input: inputs[0], output, threads, assPath: `${dir}/lyrics.ass`, fontsDir: dir }),
  });
  return data;
}

/** Mono 16 kHz WAV of the clip's audio, for speech recognition. */
export async function extractSpeechAudio(videoBytes, mime) {
  const { data } = await run({
    inputs: [toFile(videoBytes, mime)],
    outName: 'speech.wav',
    buildArgv: ({ inputs, output }) => buildSpeechAudioArgs({ input: inputs[0], output }),
  });
  return data;
}

/** A small JPEG frame of the clip (kept in the browser unless the user opts in to share it). */
export async function thumbnail(videoBytes, mime, { at = 0, width = 320 } = {}) {
  const { data } = await run({
    inputs: [toFile(videoBytes, mime)],
    outName: 'thumb.jpg',
    buildArgv: ({ inputs, output }) => buildThumbnailArgs({ input: inputs[0], output, at, width }),
  });
  return data;
}

/** Run a model-written `ffmpeg -i input … output.<ext>` command. Errors carry `stderr`. */
export async function runCliCommand(command, bytes, mime, catalog = null) {
  const parsed = parseCliCommand(command, catalog);
  const { data } = await run({
    inputs: [toFile(bytes, mime)],
    outName: parsed.outName,
    buildArgv: ({ inputs, output, threads }) => parsed.argv({ input: inputs[0], output, threads }),
  });
  return { data, format: parsed.format };
}
