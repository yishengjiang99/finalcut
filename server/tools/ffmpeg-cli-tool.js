// Fallback agent tool: uses the FFmpeg CLI itself when no built-in tool matches the request.
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { tools as builtinTools } from '../../src/tools.js';
import { FFMPEG_CLI_TOOL_NAME, ffmpegCliToolDefinition, FFMPEG_FALLBACK_GUIDANCE, withFfmpegFallback } from '../../src/ffmpegFallback.js';
import { TMP_DIR, XAI_API_TOKEN } from '../../src/server/config.js';
import { XAI_UTILITY_MODEL, XAI_CHAT_COMPLETIONS_URL } from '../../src/server/xai.js';
import { videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess, upload } from '../../src/server/middleware.js';
import { discovery as defaultDiscovery } from '../ffmpeg/ffmpeg-discovery.js';
import { buildCommand, CommandValidationError } from '../ffmpeg/ffmpeg-commander.js';
import { executeCommand } from '../ffmpeg/ffmpeg-executor.js';
import { parseCliString, buildCliStringMessages, extractCommand } from '../ffmpeg/ffmpeg-cli-string.js';

const OUTPUT_FORMATS = new Set(['mp4', 'mov', 'webm', 'mkv', 'gif', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'jpg', 'png']);

export { FFMPEG_CLI_TOOL_NAME, ffmpegCliToolDefinition, FFMPEG_FALLBACK_GUIDANCE, withFfmpegFallback };

/** Routing decision with human-readable reasoning. */
export function routeToolRequest(toolName, tools = builtinTools) {
  if (toolName && toolName !== FFMPEG_CLI_TOOL_NAME && tools.some(t => t.function.name === toolName)) {
    return { route: 'builtin', tool: toolName, reasoning: `"${toolName}" is a built-in tool and takes precedence.` };
  }
  return { route: 'ffmpeg_cli', tool: FFMPEG_CLI_TOOL_NAME, reasoning: `No built-in tool matches${toolName ? ` "${toolName}"` : ''}; falling back to the FFmpeg CLI.` };
}

function intentFromArgs(a) {
  return {
    videoFilters: a.video_filters, audioFilters: a.audio_filters, videoCodec: a.video_codec, audioCodec: a.audio_codec,
    format: a.output_format, startTime: a.start_time, duration: a.duration, noAudio: a.no_audio, noVideo: a.no_video,
    crf: a.crf, videoBitrate: a.video_bitrate, audioBitrate: a.audio_bitrate, frameRate: a.frame_rate,
  };
}

/** Discover step of the agentic loop: search capabilities and optionally fetch a filter's help. */
export async function discoverCapabilities({ query, help_topic }, discovery = defaultDiscovery) {
  const result = {
    filters: await discovery.getFiltersMatching(query, 10),
    encoders: await discovery.getEncodersMatching(query, 10),
    codecs: await discovery.getCodecsMatching(query, 10),
  };
  if (help_topic) result.help = await discovery.getHelp('filter', help_topic);
  return { ok: true, ...result };
}

/** Plan step: build + validate; on failure returns errors and suggestions so the agent can retry. */
export async function planCommand({ args = {}, inputPath = 'input.mp4', outputPath }, { discovery = defaultDiscovery } = {}) {
  const fmt = String(args.output_format || 'mp4').toLowerCase();
  if (!OUTPUT_FORMATS.has(fmt)) return { ok: false, errors: [`Unsupported output format "${fmt.slice(0, 16)}"`], suggestions: {} };
  try {
    const cmd = await buildCommand({ inputPath, outputPath: outputPath || `output.${fmt}`, intent: { ...intentFromArgs(args), format: undefined } }, discovery);
    return { ok: true, command: cmd.command, explanation: cmd.explanation, args: cmd.args, outputFormat: fmt };
  } catch (e) {
    if (e instanceof CommandValidationError) return { ok: false, errors: e.errors, suggestions: e.suggestions };
    throw e;
  }
}

/**
 * No built-in tool matched: ask inference for the FFmpeg CLI string for the user's request.
 * Returns { ok, command } with command null when the model answers NONE (not an edit, or not doable).
 */
export async function askForCliString({ request, attempts }, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(XAI_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_TOKEN}` },
    body: JSON.stringify({ model: XAI_UTILITY_MODEL, messages: buildCliStringMessages(request, attempts), stream: false, temperature: 0 }),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const detail = errorBody.error?.message || (typeof errorBody.error === 'string' ? errorBody.error : '') || response.statusText;
    throw new Error(`xAI API request failed with status ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await response.json();
  return { ok: true, command: extractCommand(data.choices?.[0]?.message?.content) };
}

/** Validate and execute a model-written CLI string on a file on disk. Same result shape as runFfmpegCli. */
export async function runCliString({ command, inputPath }, deps = {}) {
  let parsed;
  try {
    parsed = await parseCliString(command, { inputPath, outputPathFor: ext => path.join(TMP_DIR, `ffcli-${randomUUID()}.${ext}`) }, deps.discovery);
  } catch (e) {
    if (e instanceof CommandValidationError) return { ok: false, errors: e.errors, suggestions: e.suggestions };
    throw e;
  }
  const result = await executeCommand({ args: parsed.args, outputPath: parsed.outputPath }, deps.exec);
  return { ...result, outputPath: parsed.outputPath, outputFormat: parsed.outputFormat, command: parsed.command, explanation: `Ran ${parsed.command}` };
}

/** Plan and execute on a file on disk. Returns { ok, outputPath, command, explanation } or errors. */
export async function runFfmpegCli({ args = {}, inputPath }, deps = {}) {
  if (typeof args.command === 'string') return runCliString({ command: args.command, inputPath }, deps);
  const fmt = String(args.output_format || 'mp4').toLowerCase();
  const outputPath = path.join(TMP_DIR, `ffcli-${randomUUID()}.${fmt}`);
  const plan = await planCommand({ args, inputPath, outputPath }, deps);
  if (!plan.ok) return plan;
  const result = await executeCommand({ args: plan.args, outputPath }, deps.exec);
  return { ...result, outputPath, outputFormat: fmt, command: plan.command, explanation: plan.explanation };
}

export const ffmpegCliRouter = express.Router();

const DEBUG_CHAT = process.env.DEBUG_CHAT === '1';
function debugCli(...args) {
  if (DEBUG_CHAT) console.log('[ffmpeg-cli]', ...args);
}

// JSON-only: discovery and planning (no media needed)
ffmpegCliRouter.post('/api/ffmpeg-cli', express.json({ limit: '50kb' }), videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess, async (req, res) => {
  const body = req.body || {};
  try {
    debugCli('request', JSON.stringify(body));
    if (body.action === 'discover') {
      const found = await discoverCapabilities(body);
      debugCli('discover', JSON.stringify({ query: body.query, filters: found.filters.map(f => f.name), encoders: found.encoders.map(e => e.name), codecs: found.codecs.map(c => c.name) }));
      return res.json(found);
    }
    if (body.action === 'plan') {
      const plan = await planCommand({ args: body });
      debugCli('plan', JSON.stringify(plan));
      if (plan.ok) delete plan.args;
      return res.status(plan.ok ? 200 : 400).json(plan);
    }
    if (body.action === 'command') {
      if (typeof body.request !== 'string' || !body.request.trim()) return res.status(400).json({ error: 'request is required' });
      const asked = await askForCliString(body);
      debugCli('command', JSON.stringify({ request: body.request, attempts: body.attempts?.length || 0, command: asked.command }));
      return res.json(asked);
    }
    return res.status(400).json({ error: 'action must be "discover", "plan" or "command" (use multipart POST /api/ffmpeg-cli/run to execute)' });
  } catch (e) {
    console.error('ffmpeg-cli error:', e);
    return res.status(500).json({ error: 'FFmpeg capability discovery failed' });
  }
});

// Multipart: video + args JSON → executes and returns the produced media
ffmpegCliRouter.post('/api/ffmpeg-cli/run', videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file provided' });
  let args;
  try { args = typeof req.body?.args === 'string' ? JSON.parse(req.body.args) : (req.body?.args || {}); } catch { return res.status(400).json({ error: 'Invalid args JSON' }); }
  const inputPath = path.join(TMP_DIR, `ffcli-in-${randomUUID()}`);
  let outputPath;
  try {
    await fs.writeFile(inputPath, req.file.buffer);
    debugCli('run request', JSON.stringify(args));
    const result = await runFfmpegCli({ args, inputPath });
    debugCli('run result', JSON.stringify({ ok: result.ok, command: result.command, error: result.error, errors: result.errors, stderr: result.stderr?.slice(-2000) }));
    outputPath = result.outputPath;
    if (!result.ok) return res.status(400).json({ error: result.error || result.errors?.join('; ') || 'FFmpeg failed', errors: result.errors, suggestions: result.suggestions, stderr: result.stderr });
    const buf = await fs.readFile(outputPath);
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-FFmpeg-Command', encodeURIComponent(result.command));
    res.set('X-FFmpeg-Explanation', encodeURIComponent(result.explanation));
    res.set('X-Output-Format', result.outputFormat);
    return res.send(buf);
  } catch (e) {
    console.error('ffmpeg-cli run error:', e);
    return res.status(500).json({ error: 'FFmpeg CLI execution failed' });
  } finally {
    fs.unlink(inputPath).catch(() => {});
    if (outputPath) fs.unlink(outputPath).catch(() => {});
  }
});
