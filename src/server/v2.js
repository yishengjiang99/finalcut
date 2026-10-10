// /api/v2: the web app's in-browser FFmpeg editor. Grok plans on the server; the browser runs
// the tool calls in ffmpeg.wasm and posts back small results (durations, probe info). No route
// here accepts video. These routes are additions: nothing under /api/* that the FinalCap iOS app
// calls is changed.
import express from 'express';
import multer from 'multer';
import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { OPENAI_API_KEY, TMP_DIR } from './config.js';
import { apiLimiter, videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess } from './middleware.js';
import { handleClientExecution } from './chat.js';
import { toolsForMediaType } from './toolsSchema.js';
import { splitAudioIfNeeded, transcribeWithOpenAI, mergeDiarizedSegmentsWithOffsets } from './captions.js';
import { buildSrtAndVtt } from './utils.js';
import { normalizeLanguageCode, srtHasSpeech } from './captionHelpers.js';
import { DEFAULT_CLIP_LIMITS } from '../wasm/clipLimits.js';
import { CLI_OUTPUT_FORMATS } from '../wasm/ops/multi.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const WASM_CATALOG_PATH = path.join(DIR, '..', '..', 'server', 'ffmpeg', 'wasm-capabilities.json');

// ─── Feature flag ────────────────────────────────────────────────────────────

/**
 * CLIENT_FFMPEG = "on" (default) | "off" | a percentage ("25" or "25%").
 * The browser applies it: "percent" enables in-browser editing for that share of visitors.
 */
export function clientFFmpegFlag(raw = process.env.CLIENT_FFMPEG) {
  const value = String(raw ?? 'on').trim().toLowerCase();
  if (value === 'off' || value === 'false' || value === '0') return { mode: 'off', percent: 0 };
  const percent = /^\d{1,3}%?$/.test(value) ? Number(value.replace('%', '')) : null;
  if (percent !== null && percent < 100) return { mode: 'percent', percent };
  return { mode: 'on', percent: 100 };
}

// ─── Capability catalog of the wasm FFmpeg build ─────────────────────────────

// Commands known to work in the browser core, for requests the typed tools do not cover.
export const RECIPES = [
  { task: 'make a GIF', command: 'ffmpeg -i input -vf "fps=10,scale=480:-2:flags=lanczos" output.gif' },
  { task: 'grab one frame as an image', command: 'ffmpeg -ss 1 -i input -frames:v 1 output.png' },
  { task: 'remove the audio', command: 'ffmpeg -i input -c:v copy -an output.mp4' },
  { task: 'reverse the video and audio', command: 'ffmpeg -i input -vf reverse -af areverse output.mp4' },
  { task: 'blur', command: 'ffmpeg -i input -vf "gblur=sigma=8" -c:a copy output.mp4' },
  { task: 'sharpen', command: 'ffmpeg -i input -vf "unsharp=5:5:1.0" -c:a copy output.mp4' },
  { task: 'vignette', command: 'ffmpeg -i input -vf vignette -c:a copy output.mp4' },
  { task: 'change the frame rate', command: 'ffmpeg -i input -r 24 -c:a copy output.mp4' },
  { task: 'compress to a smaller file', command: 'ffmpeg -i input -c:v libx264 -preset veryfast -crf 30 -c:a aac -b:a 96k output.mp4' },
  { task: 'pad to a square with black bars', command: 'ffmpeg -i input -vf "pad=max(iw\\,ih):max(iw\\,ih):(ow-iw)/2:(oh-ih)/2" -c:a copy output.mp4' },
  { task: 'loop the clip twice', command: 'ffmpeg -stream_loop 1 -i input -c copy output.mp4' },
  { task: 'picture-in-picture of the same clip', command: 'ffmpeg -i input -i input -filter_complex "[1:v]scale=iw/4:-2[pip];[0:v][pip]overlay=W-w-20:H-h-20" -c:a copy output.mp4' },
];

const EMPTY_CATALOG = { generated: null, ffmpeg: null, core: null, filters: [], encoders: [], decoders: [], muxers: [], demuxers: [] };
let catalogCache = null;

/** The catalog written by scripts/generate-wasm-capabilities.mjs (empty when the file is missing). */
export function loadWasmCatalog(file = WASM_CATALOG_PATH) {
  if (catalogCache && file === WASM_CATALOG_PATH) return catalogCache;
  let catalog = EMPTY_CATALOG;
  try {
    catalog = { ...EMPTY_CATALOG, ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    console.warn('WARNING: wasm FFmpeg capability catalog is missing or unreadable:', error.message);
  }
  if (file === WASM_CATALOG_PATH) catalogCache = catalog;
  return catalog;
}

function matching(list, words, limit) {
  const scored = [];
  for (const item of list) {
    const name = item.name.toLowerCase();
    const hay = `${name} ${String(item.description || '').toLowerCase()}`;
    // Any word may match; items matching more words (and by name) rank first.
    const score = words.reduce((s, w) => s + (name === w ? 3 : name.includes(w) ? 2 : hay.includes(w) ? 1 : 0), 0);
    if (score > 0) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.item);
}

/** Search the catalog for filters, encoders, formats and recipes matching any word of `query`. */
export function searchCapabilities(query, catalog = loadWasmCatalog()) {
  const words = String(query || '').toLowerCase().split(/[^a-z0-9_]+/).filter(w => w.length > 1).slice(0, 8);
  if (!words.length) return { ok: false, error: 'query is required (one or two keywords such as "blur" or "gif")' };
  const recipes = RECIPES.filter(r => words.some(w => r.task.includes(w) || r.command.includes(w))).slice(0, 4);
  return {
    ok: true,
    ffmpeg: catalog.ffmpeg,
    filters: matching(catalog.filters, words, 12),
    encoders: matching(catalog.encoders, words, 8),
    muxers: matching(catalog.muxers, words, 6),
    recipes,
  };
}

// ─── Web toolset for the model ───────────────────────────────────────────────

export const RUN_FFMPEG_TOOL_NAME = 'run_ffmpeg';
export const SEARCH_CAPABILITIES_TOOL_NAME = 'search_ffmpeg_capabilities';

export const runFfmpegToolDefinition = {
  type: 'function',
  function: {
    name: RUN_FFMPEG_TOOL_NAME,
    description: 'FALLBACK ONLY. Runs one FFmpeg command on the current file in the user\'s browser. Use it when none of the other tools can do what the user asks, ' +
      `after ${SEARCH_CAPABILITIES_TOOL_NAME} has shown the filters or encoders exist. The only input file is named "input" (it may be passed to -i more than once). ` +
      `Write exactly one output, named output.<ext>, as the last argument; <ext> is one of ${CLI_OUTPUT_FORMATS.join(', ')}. ` +
      'No other files, URLs, fonts or devices exist and no shell syntax is available.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'A single ffmpeg command line, e.g. ffmpeg -i input -vf "gblur=sigma=8" -c:a copy output.mp4' },
        explanation: { type: 'string', description: 'One short sentence telling the user what the command does.' },
      },
      required: ['command'],
    },
  },
};

export const searchCapabilitiesToolDefinition = {
  type: 'function',
  function: {
    name: SEARCH_CAPABILITIES_TOOL_NAME,
    description: `Looks up what the FFmpeg build in the user\'s browser can do: matching filters, encoders, output formats and ready-made commands. Call it before ${RUN_FFMPEG_TOOL_NAME}.`,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'One or two keywords such as "blur", "reverb" or "gif". Any keyword may match.' } },
      required: ['query'],
    },
  },
};

export const WEB_EXECUTION_INSTRUCTIONS =
  'Tool calls in this conversation run in the user\'s browser with FFmpeg (WebAssembly); the media never leaves their device. ' +
  'Each tool result arrives as a role "tool" message whose content is JSON: ' +
  '{ ok, error?, message?, executedOn: "browser"|"server", output?: { type, duration, width, height, fps, hasAudio, sizeBytes } }. ' +
  'If ok is false, explain the error or try an alternative; do not repeat the same failing call. ' +
  'error "skipped_by_user" means the user declined a step that would have uploaded their file: it is not a failure, ' +
  'do not call that tool again in this turn, and continue to the final answer. ' +
  'Use the output metadata (duration, width, height) from earlier results when planning later edits.';

const WEB_FALLBACK_GUIDANCE =
  `Routing: always prefer the dedicated editing tools. Only if NONE of them can fulfil the request, call ${SEARCH_CAPABILITIES_TOOL_NAME} to find how FFmpeg can do it, ` +
  `then ${RUN_FFMPEG_TOOL_NAME} with the command. Never answer that an edit is unsupported before that search shows FFmpeg cannot do it here.`;

/** Tools offered to the web app: every tool in src/tools.js for the media type, then the FFmpeg fallback pair. */
export function webToolsFor({ mediaType } = {}) {
  const typed = toolsForMediaType(mediaType);
  return mediaType === 'image' ? typed : [...typed, searchCapabilitiesToolDefinition, runFfmpegToolDefinition];
}

export const WEB_PROFILE = {
  tools: webToolsFor,
  instructions: WEB_EXECUTION_INSTRUCTIONS,
  guidance: [WEB_FALLBACK_GUIDANCE],
  serverTools: { [SEARCH_CAPABILITIES_TOOL_NAME]: async (args) => searchCapabilities(args?.query) },
};

// ─── Routes ──────────────────────────────────────────────────────────────────

const router = express.Router();

// What the browser needs before the first edit: the feature flag and the clip limits.
router.get('/api/v2/config', apiLimiter, (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    clientFFmpeg: clientFFmpegFlag(),
    limits: { clip: DEFAULT_CLIP_LIMITS },
    captions: { onDevice: true, cloud: Boolean(OPENAI_API_KEY) },
    tools: { fallback: RUN_FFMPEG_TOOL_NAME },
  });
});

// The full catalog (static); the browser validates run_ffmpeg commands against it.
router.get('/api/v2/capabilities', apiLimiter, (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  const catalog = loadWasmCatalog();
  res.json({ ...catalog, recipes: RECIPES, outputFormats: CLI_OUTPUT_FORMATS });
});

router.get('/api/v2/capabilities/search', apiLimiter, (req, res) => {
  const found = searchCapabilities(req.query.q);
  res.status(found.ok ? 200 : 400).json(found);
});

// The quota middleware treats a turn's continuations as free only in client-execution mode.
function asClientExecution(req, res, next) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid request body' });
  req.body.execution = 'client';
  return next();
}

// Same contract as POST /api/chat with execution "client", with the web toolset.
router.post('/api/v2/chat', apiLimiter, requireAuthenticatedUser, asClientExecution, requireInferenceAccess, async (req, res) => {
  try {
    return await handleClientExecution(req, res, req.user?.id ?? null, WEB_PROFILE);
  } catch (error) {
    console.error('Error in /api/v2/chat:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    return undefined;
  }
});

// Cloud transcription, opt-in only. Takes the audio the browser extracted (WAV), never video.
export const TRANSCRIBE_MAX_BYTES = 200 * 1024 * 1024;
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TRANSCRIBE_MAX_BYTES, files: 1 } });

/** True for a RIFF/WAVE file: the only upload this route accepts. */
export function isWav(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 44 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE';
}

function uploadAudio(req, res, next) {
  audioUpload.single('audio')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Audio is too long for cloud transcription', code: 'audio_too_large' });
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}

router.post('/api/v2/transcribe-audio', videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess, uploadAudio, async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(503).json({ error: 'Cloud transcription is not configured on this server.', code: 'cloud_transcription_unavailable' });
  if (!isWav(req.file?.buffer)) return res.status(400).json({ error: 'audio must be a WAV file (audio only; video is never accepted here)', code: 'invalid_audio' });
  const language = normalizeLanguageCode(req.body?.language || 'auto', { allowAuto: true });
  if (!language) return res.status(400).json({ error: 'language must be "auto" or a language code/name' });

  const wavPath = path.join(TMP_DIR, `v2-audio-${randomUUID()}.wav`);
  const tmpFiles = [wavPath];
  try {
    await fs.writeFile(wavPath, req.file.buffer);
    const chunks = await splitAudioIfNeeded(wavPath);
    for (const chunk of chunks) if (chunk.path !== wavPath) tmpFiles.push(chunk.path);
    const perChunk = await Promise.all(chunks.map(c => transcribeWithOpenAI(c.path, c.startSec, language === 'auto' ? null : language, { preferDiarization: false })));
    const { srt, vtt } = buildSrtAndVtt(mergeDiarizedSegmentsWithOffsets(perChunk));
    if (!srtHasSpeech(srt)) return res.status(422).json({ error: 'No speech detected in the audio.', code: 'no_speech' });
    return res.json({ srt, vtt, language });
  } catch (error) {
    console.error('Error in /api/v2/transcribe-audio:', error?.message || error);
    return res.status(500).json({ error: 'Cloud transcription failed' });
  } finally {
    for (const file of tmpFiles) fs.unlink(file).catch(() => {});
  }
});

export { router as v2Router };
