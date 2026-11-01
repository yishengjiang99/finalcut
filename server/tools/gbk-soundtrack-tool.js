// add_soundtrack: generates an original music track with GBK's hosted MCP
// (create → edit → render → poll status → get artifacts) and returns the WAV to the
// editor, which mixes it in as the soundtrack (web: ffmpeg.wasm, iOS: on device).
// Off switch: SOUNDTRACK_ENABLED=0. Auth: GBK_MCP_TOKEN, a Bearer token for FinalCap's
// GBK service principal (gbk:compositions.write, gbk:renders.create, gbk:artifacts.read).
import express from 'express';
import { createHash, randomUUID } from 'crypto';
import { soundtrackEnabled, SOUNDTRACK_MIN_SECONDS, SOUNDTRACK_MAX_SECONDS, SOUNDTRACK_STYLES } from '../../src/server/soundtrackTool.js';
import { videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess } from '../../src/server/middleware.js';

export const GBK_MCP_URL = process.env.GBK_MCP_URL || 'https://compose.grepawk.com/mcp';
const POLL_DEADLINE_MS = 150_000;
const CACHE_MAX = 50;

export class SoundtrackError extends Error {
  constructor(code, status, message) { super(message); this.name = 'SoundtrackError'; this.code = code; this.status = status; }
}

/** Validate the body of POST /api/soundtrack/generate. Throws SoundtrackError. */
export function parseSoundtrackRequest(body = {}) {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 500) : '';
  if (!prompt) throw new SoundtrackError('invalid_request', 400, 'A soundtrack prompt is required');
  const d = Number(body.duration_seconds);
  if (!Number.isFinite(d) || d <= 0) throw new SoundtrackError('invalid_request', 400, 'duration_seconds is required');
  const style = SOUNDTRACK_STYLES.includes(body.style) ? body.style : 'pop';
  const tempo = Number.isFinite(body.tempo) ? Math.min(200, Math.max(40, body.tempo)) : undefined;
  const instrumentation = Array.isArray(body.instrumentation)
    ? body.instrumentation.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 32)).slice(0, 12) : undefined;
  return {
    prompt, style, tempo,
    mood: typeof body.mood === 'string' && body.mood.trim() ? body.mood.trim().slice(0, 120) : undefined,
    instrumentation: instrumentation?.length ? instrumentation : undefined,
    durationSeconds: Math.round(Math.min(SOUNDTRACK_MAX_SECONDS, Math.max(SOUNDTRACK_MIN_SECONDS, d))),
  };
}

/** Minimal streamable-HTTP MCP client (GBK requires a session: initialize first). */
export function createMcpClient({ url = GBK_MCP_URL, token, fetchImpl = fetch } = {}) {
  let sessionId = null;
  let nextId = 1;
  async function post(message) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`, ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
    if (res.status === 401 || res.status === 403) throw new SoundtrackError('soundtrack_unavailable', 503, 'Music generation is not configured on the server');
    if (!res.ok) throw new SoundtrackError('soundtrack_failed', 502, `Music service error (${res.status})`);
    sessionId = res.headers.get('mcp-session-id') || sessionId;
    if (message.id === undefined) return null;
    const text = await res.text();
    const payloads = /^\s*[{[]/.test(text) ? [text] : text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5));
    for (const p of payloads) {
      const msg = JSON.parse(p);
      if (msg.id === message.id) return msg;
    }
    throw new SoundtrackError('soundtrack_failed', 502, 'Music service returned no response');
  }
  async function rpc(method, params) {
    const msg = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    if (msg.error) throw new SoundtrackError('soundtrack_failed', 502, msg.error.message || 'Music service error');
    return msg.result;
  }
  return {
    async initialize() {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'finalcap', version: '1' } });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    /** tools/call → structured result; GBK tool errors become SoundtrackError. */
    async call(name, args) {
      const result = await rpc('tools/call', { name, arguments: args });
      let data = result?.structuredContent;
      if (!data) { try { data = JSON.parse(result?.content?.[0]?.text || '{}'); } catch { data = {}; } }
      if (result?.isError || data.ok === false) {
        const code = data.error?.code;
        if (code === 'QUOTA_EXCEEDED') throw new SoundtrackError('soundtrack_limit', 429, `Music generation limit reached: ${data.error.message}`);
        throw new SoundtrackError('soundtrack_failed', 502, data.error?.message || `${name} failed`);
      }
      return data;
    },
  };
}

const cache = new Map(); // sha256(request) → result; renders are deterministic per inputs + seed

export function soundtrackCacheKey(req) {
  const { prompt, ...inputs } = req; // the structured inputs drive generation; prompt wording does not
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

/** Run the GBK flow. Resolves { bytes, mimeType, durationSeconds, compositionId, sha256, cached }. */
export async function generateSoundtrack(req, deps = {}) {
  const env = deps.env ?? process.env;
  const token = deps.token ?? env.GBK_MCP_TOKEN;
  if (!token) throw new SoundtrackError('soundtrack_unavailable', 503, 'Music generation is not configured on the server');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const key = soundtrackCacheKey(req);
  if (cache.has(key)) return { ...cache.get(key), cached: true };

  const mcp = createMcpClient({ url: deps.url ?? env.GBK_MCP_URL ?? GBK_MCP_URL, token, fetchImpl });
  await mcp.initialize();
  const seed = parseInt(key.slice(0, 7), 16);
  const created = await mcp.call('gbk_create_composition', {
    title: `FinalCap soundtrack ${key.slice(0, 8)}`, style: req.style, durationSeconds: req.durationSeconds, seed,
    ...(req.mood ? { mood: req.mood } : {}), ...(req.tempo ? { tempo: req.tempo } : {}),
    idempotencyKey: `fc-create-${key.slice(0, 40)}`,
  });
  const compositionId = created.compositionId;
  const edited = await mcp.call('gbk_edit_composition', {
    compositionId, expectedRevision: created.revision ?? 0,
    operations: [{ type: 'generate_arrangement', style: req.style, seed, ...(Number.isInteger(created.bars) ? { bars: created.bars } : {}),
      ...(req.tempo ? { tempo: req.tempo } : {}), ...(req.instrumentation ? { instrumentation: req.instrumentation } : {}) }],
  });
  let job = await mcp.call('gbk_render_composition', {
    compositionId, ...(Number.isInteger(edited.revision) ? { revision: edited.revision } : {}), headless: true, includeMidi: false, tailSeconds: 1, waitSeconds: 50,
  });
  const deadline = now() + POLL_DEADLINE_MS;
  while (!['completed', 'failed', 'cancelled'].includes(job.status)) {
    if (!job.jobId || now() > deadline) throw new SoundtrackError('soundtrack_timeout', 504, 'The music is taking too long to render; please ask again');
    job = await mcp.call('gbk_get_render_status', { jobId: job.jobId, waitSeconds: 30 });
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) await sleep(1000);
  }
  if (job.status !== 'completed') throw new SoundtrackError('soundtrack_failed', 502, job.error?.message || 'Music render failed');
  const arts = await mcp.call('gbk_get_artifacts', { compositionId });
  const wav = arts.latest?.wav;
  if (!wav?.downloadUrl) throw new SoundtrackError('soundtrack_failed', 502, 'Music render produced no audio');
  const dl = await fetchImpl(wav.downloadUrl);
  if (!dl.ok) throw new SoundtrackError('soundtrack_failed', 502, 'Could not download the rendered music');
  const bytes = Buffer.from(await dl.arrayBuffer());
  const result = { bytes, mimeType: wav.mimeType || 'audio/wav', durationSeconds: req.durationSeconds, compositionId, sha256: wav.sha256 || '' };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return { ...result, cached: false };
}

export const _clearSoundtrackCache = () => cache.clear();

export const soundtrackRouter = express.Router();

// Same access chain as youtube-audio: a generation counts as one AI edit for free-tier installs.
soundtrackRouter.post('/api/soundtrack/generate', express.json({ limit: '10kb' }),
  (req, res, next) => soundtrackEnabled() ? next() : res.status(404).json({ error: 'Soundtrack generation is off', code: 'soundtrack_disabled' }),
  videoProcessLimiter, requireAuthenticatedUser, requireInferenceAccess, async (req, res) => {
    const started = Date.now();
    try {
      const out = await generateSoundtrack(parseSoundtrackRequest(req.body || {}));
      console.log(JSON.stringify({ event: 'soundtrack_generation_completed', ms: Date.now() - started, cached: out.cached, id: randomUUID() }));
      res.set('Content-Type', out.mimeType);
      res.set('X-Audio-Duration', String(out.durationSeconds));
      res.set('X-Audio-Cached', out.cached ? 'true' : 'false');
      return res.send(out.bytes);
    } catch (e) {
      const known = e instanceof SoundtrackError;
      console.log(JSON.stringify({ event: 'soundtrack_generation_failed', ms: Date.now() - started, code: known ? e.code : 'internal' }));
      if (!known) console.error('soundtrack error:', e);
      return res.status(known ? e.status : 500).json({ error: known ? e.message : 'Soundtrack generation failed', code: known ? e.code : 'soundtrack_failed' });
    }
  });
