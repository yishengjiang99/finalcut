// /api/v2: the web app's in-browser FFmpeg editor. Grok plans on the server; the browser runs
// the tool calls in ffmpeg.wasm and posts back small results (durations, probe info). No route
// here accepts video. These routes are additions: nothing under /api/* that the FinalCap iOS app
// calls is changed.
import express from 'express';
import vm from 'vm';
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
import { runProcess, FFMPEG_BIN } from '../../server/ffmpeg/ffmpeg-executor.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const WASM_CATALOG_PATH = path.join(DIR, '..', '..', 'server', 'ffmpeg', 'wasm-capabilities.json');

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

// ─── FFmpeg help lookup (the model's `ffmpeg -h ... | grep`) ─────────────────

// The help commands the lookup may run on the server's FFmpeg. None of them reads media.
const HELP_LISTS = ['filters', 'encoders', 'decoders', 'codecs', 'muxers', 'demuxers', 'formats', 'bsfs', 'pix_fmts', 'sample_fmts', 'layouts', 'dispositions'];
const HELP_COMMAND = new RegExp(`^(?:-h(?: (?:long|full|(?:filter|encoder|decoder|muxer|demuxer|bsf)=[A-Za-z0-9_]{1,64}))?|-(?:${HELP_LISTS.join('|')}))$`);
const DEFAULT_HELP = '-h full';
const HELP_TIMEOUT_MS = 15_000;
const MAX_HELP_CACHE = 400;
const MAX_PATTERN_LEN = 200;
const MAX_CONTEXT_LINES = 30;
const MAX_OUTPUT_LINES = 80;
const MAX_OUTPUT_CHARS = 6000;
const GREP_TIMEOUT_MS = 250;
const GREP_SCRIPT = new vm.Script('lines.map((line, i) => (re.test(line) ? i : -1)).filter(i => i >= 0)');

const helpCache = new Map();

/** "ffmpeg -h full", "-h filter=overlay", "-filters" → the normalised help arguments, or null. */
export function normalizeHelpCommand(help) {
  const text = String(help ?? '').trim().replace(/^ffmpeg\s+/, '').replace(/^-hide_banner\s+/, '').replace(/^(?:-help|--help|-\?)(?=\s|$)/, '-h').replace(/\s+/g, ' ') || DEFAULT_HELP;
  return HELP_COMMAND.test(text) ? text : null;
}

/** Output of `ffmpeg -hide_banner <help>` on the server, kept in memory after the first call. */
async function helpText(help, { run, bin }) {
  const cacheable = run === runProcess && bin === FFMPEG_BIN;
  if (cacheable && helpCache.has(help)) return helpCache.get(help);
  const res = await run(bin, ['-hide_banner', ...help.split(' ')], { timeoutMs: HELP_TIMEOUT_MS });
  const text = (res.stdout || '').trim();
  if (!text) throw new Error(res.spawnError ? `ffmpeg could not be started (${res.spawnError})` : (res.stderr || '').trim().split('\n').pop() || `ffmpeg ${help} printed nothing`);
  if (cacheable && helpCache.size < MAX_HELP_CACHE) helpCache.set(help, text);
  return text;
}

/** The server FFmpeg's version ("4.4.2-..."), cached for the real runner; null when ffmpeg cannot run. */
let serverFfmpegVersion = null;
let serverFfmpegVersionTried = false;
async function ffmpegVersion({ run = runProcess, bin = FFMPEG_BIN } = {}) {
  const cacheable = run === runProcess && bin === FFMPEG_BIN;
  if (cacheable && serverFfmpegVersionTried) return serverFfmpegVersion;
  let version = null;
  try {
    const res = await run(bin, ['-hide_banner', '-version'], { timeoutMs: HELP_TIMEOUT_MS });
    version = /ffmpeg version (\S+)/.exec(res.stdout || '')?.[1] || null;
  } catch { version = null; }
  if (cacheable) { serverFfmpegVersion = version; serverFfmpegVersionTried = true; }
  return version;
}

/** `grep -i -E`: a pattern that is not a valid regular expression is matched literally. */
function grepRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
}

const contextLines = value => Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.trunc(Number(value)) || 0));
const shellQuote = text => `'${text.replace(/'/g, `'\\''`)}'`;

/**
 * What `ffmpeg <help> | grep -i -E <pattern> -A <after> -B <before>` prints, from the server's
 * FFmpeg. Without a pattern the start of the help text is returned. `query` (keywords) is the
 * older form of `pattern`: any keyword may match.
 */
export async function searchCapabilities({ help, pattern, after, before, query } = {}, { run = runProcess, bin = FFMPEG_BIN } = {}) {
  const topic = normalizeHelpCommand(help);
  if (!topic) {
    return { ok: false, error: `help must be one of: -h, -h long, -h full, -h filter=NAME, -h encoder=NAME, -h decoder=NAME, -h muxer=NAME, -h demuxer=NAME, -h bsf=NAME, ${HELP_LISTS.map(l => `-${l}`).join(', ')}` };
  }
  const grep = String(pattern ?? '').trim() || String(query ?? '').trim().split(/\s+/).filter(Boolean).join('|');
  if (grep.length > MAX_PATTERN_LEN) return { ok: false, error: `pattern is longer than ${MAX_PATTERN_LEN} characters` };
  const A = contextLines(after);
  const B = contextLines(before);

  let lines;
  try {
    lines = (await helpText(topic, { run, bin })).split('\n');
  } catch (error) {
    return { ok: false, error: error.message };
  }

  let command = `ffmpeg ${topic}`;
  let matches = null;
  let shown = [];
  if (grep) {
    command += ` | grep -i -E ${shellQuote(grep)}${A ? ` -A ${A}` : ''}${B ? ` -B ${B}` : ''}`;
    let hits;
    try {
      hits = GREP_SCRIPT.runInNewContext({ lines, re: grepRegex(grep) }, { timeout: GREP_TIMEOUT_MS });
    } catch {
      return { ok: false, command, error: 'pattern took too long to match; use a simpler one' };
    }
    matches = hits.length;
    // Like grep: context lines around each match, "--" between groups that are not adjacent.
    let last = -1;
    for (const hit of hits) {
      const from = Math.max(hit - B, last + 1);
      const to = Math.min(hit + A, lines.length - 1);
      if (from > to) continue;
      if (shown.length && from > last + 1) shown.push('--');
      for (let i = from; i <= to; i++) shown.push(lines[i]);
      last = to;
    }
  } else {
    shown = lines;
  }

  const total = shown.length;
  let output = shown.slice(0, MAX_OUTPUT_LINES).join('\n');
  if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, output.lastIndexOf('\n', MAX_OUTPUT_CHARS));
  const printed = output ? output.split('\n').length : 0;
  // This help comes from the server's FFmpeg, not the browser's 5.1 wasm core: a filter, encoder
  // or option named here may not exist in the browser (the browser validates run_ffmpeg against
  // its own catalog from /api/v2/capabilities and the command itself fails loudly if not).
  const version = await ffmpegVersion({ run, bin });
  const result = { ok: true, command, ...(version ? { ffmpegVersion: version } : {}), ...(matches === null ? {} : { matches }), output };
  if (printed < total) result.truncated = `showing ${printed} of ${total} lines; narrow the pattern${grep ? '' : ' (none was given)'} or pick a more specific help`;
  else if (matches === 0) result.hint = 'no lines matched; try other words (FFmpeg\'s own terms), fewer of them, or another help';
  if (grep) {
    const re = grepRegex(grep);
    const recipes = RECIPES.filter(r => re.test(r.task) || re.test(r.command)).slice(0, 4);
    if (recipes.length) result.recipes = recipes;
  }
  return result;
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
    description: 'Reads the server FFmpeg\'s own help, like running `ffmpeg <help> | grep -i -E <pattern>` in a shell, and returns the matching lines. ' +
      'The result names the server FFmpeg version: it is a different build from the browser\'s 5.1 wasm core, so a filter, encoder or option ' +
      'listed here may not exist in the browser (the browser checks run_ffmpeg against its own catalog and the command fails loudly if not). ' +
      'Use it to discover how FFmpeg does something: search broadly first, read the lines, then search again for the option or filter they name ' +
      '(for example "-h" with "thumb|cover|attach" shows -disposition; then "-h full" with "disposition" and after=20 lists its values; then "-h muxer=mp4"). ' +
      `Several calls in a row are expected. It only reads help text; ${RUN_FFMPEG_TOOL_NAME} runs the command you work out.`,
    parameters: {
      type: 'object',
      properties: {
        help: {
          type: 'string',
          description: 'Which help to read. "-h" (main options), "-h long", "-h full" (every option of every codec, format and filter; the default), ' +
            '"-h filter=NAME", "-h encoder=NAME", "-h decoder=NAME", "-h muxer=NAME", "-h demuxer=NAME", "-h bsf=NAME", ' +
            `or a list: ${HELP_LISTS.map(l => `"-${l}"`).join(', ')}.`,
        },
        pattern: { type: 'string', description: 'Case-insensitive extended regular expression matched against each line, e.g. "thumb|cover|attach" or "^ *-map". Leave out to read the start of the help.' },
        after: { type: 'integer', description: `Lines of context to print after each match (grep -A), 0-${MAX_CONTEXT_LINES}. Use it to read the values listed under an option.` },
        before: { type: 'integer', description: `Lines of context to print before each match (grep -B), 0-${MAX_CONTEXT_LINES}.` },
      },
      required: [],
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
  `Routing: always prefer the dedicated editing tools. Only if NONE of them can fulfil the request, call ${SEARCH_CAPABILITIES_TOOL_NAME} to find how FFmpeg can do it: grep its help, read what comes back and grep again until you know the options, ` +
  `then ${RUN_FFMPEG_TOOL_NAME} with the command. One empty search is not an answer: try FFmpeg's own terms before deciding. ` +
  'The help comes from the server\'s FFmpeg, which is a different version and build from the browser\'s 5.1 core: it can name filters, encoders or options the browser cannot run. ' +
  'If the command fails on an unknown filter, encoder or option, use an older or simpler equivalent. ' +
  'Never answer that an edit is unsupported before those searches show FFmpeg cannot do it here.';

/** Tools offered to the web app: every tool in src/tools.js for the media type, then the FFmpeg fallback pair. */
export function webToolsFor({ mediaType } = {}) {
  const typed = toolsForMediaType(mediaType);
  return mediaType === 'image' ? typed : [...typed, searchCapabilitiesToolDefinition, runFfmpegToolDefinition];
}

export const WEB_PROFILE = {
  tools: webToolsFor,
  instructions: WEB_EXECUTION_INSTRUCTIONS,
  guidance: [WEB_FALLBACK_GUIDANCE],
  serverTools: { [SEARCH_CAPABILITIES_TOOL_NAME]: async (args) => searchCapabilities(args) },
};

// ─── Routes ──────────────────────────────────────────────────────────────────

const router = express.Router();

// What the browser needs before the first edit: the clip limits and caption availability.
// Editing always runs in the browser (ffmpeg.wasm); there is no engine flag.
router.get('/api/v2/config', apiLimiter, (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
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

// ?help=-h full&q=<pattern>&after=<n>&before=<n>
router.get('/api/v2/capabilities/search', apiLimiter, async (req, res) => {
  const { help, q, after, before } = req.query;
  const found = await searchCapabilities({ help, pattern: typeof q === 'string' ? q : '', after, before });
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
