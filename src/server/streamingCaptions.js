// Streaming captions (web): the browser streams the video's audio straight to ElevenLabs realtime
// STT (Scribe v2 Realtime) and burns the captions itself. This server's part is small and stateless:
//
//   GET  /api/streaming-captions/status      → { available }              (is the flow configured?)
//   POST /api/streaming-captions/token       → { token, wsUrl, query, … } (mint a single-use token; not charged)
//   POST /api/streaming-captions/translate   → { lines:[{i,text,translation}] } (Grok, text only; the
//                                              edit is charged here, once per captions job, after the
//                                              first batch that produced a translated line)
//   POST /api/streaming-captions/burn        → video/mp4                  (consented server fallback)
//
// The ElevenLabs key never leaves this process: only the 15-minute single-use token goes to the
// browser. No audio and no video pass through here, except in the explicit burn fallback. No job
// state is kept, so a restart cannot lose anything (the client just repeats a failed call).
// See docs/api/STREAMING_CAPTIONS.md.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { ELEVENLABS_API_KEY } from './config.js';
import {
  apiLimiter,
  videoProcessLimiter,
  requireAuthenticatedUser,
  requireActiveSubscription,
  requireInferenceAccess,
  uploadSingle,
} from './middleware.js';
import {
  LyricCaptionsError,
  parseTranslateRequest,
  assertTranslateAvailable,
  translateSpeechSegments,
  parseBurnLines,
  parseStyleOptions,
  parseTargetLanguage,
  burnLinesOnServer,
  refuseIosBurn,
  sendError,
} from './lyricCaptions.js';
import { normalizeLanguageCode } from './captionHelpers.js';

export const STREAMING_UNAVAILABLE = 'streaming_captions_unavailable';
export const SCRIBE_MODEL_ID = 'scribe_v2_realtime';
export const SCRIBE_TOKEN_TTL_SEC = 15 * 60; // documented ElevenLabs single-use token lifetime
export const STREAMING_MAX_AUDIO_SECONDS = 10 * 60;
const SESSION_TTL_MS = 30 * 60 * 1000;

function elevenLabsBase(env = process.env) {
  const raw = String(env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+$/i.test(raw) ? raw : 'https://api.elevenlabs.io';
}

/** wss:// URL of the realtime endpoint for the configured base. */
export function scribeWsUrl(env = process.env) {
  return `${elevenLabsBase(env).replace(/^https:/, 'wss:')}/v1/speech-to-text/realtime`;
}

async function mintScribeToken() {
  let res;
  try {
    res = await fetch(`${elevenLabsBase()}/v1/single-use-token/realtime_scribe`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.error(`[streaming_captions] token request failed: ${err?.name || 'error'}`);
    throw new LyricCaptionsError('Streaming captions are unavailable right now.', { status: 503, code: STREAMING_UNAVAILABLE });
  }
  if (!res.ok) {
    // Status only: never the response body or any header, which could echo credentials.
    console.error(`[streaming_captions] token request answered ${res.status}`);
    const busy = res.status === 429;
    throw new LyricCaptionsError(busy ? 'The transcription service is busy. Try again in a moment.' : 'Streaming captions are unavailable right now.',
      { status: 503, code: busy ? 'streaming_captions_busy' : STREAMING_UNAVAILABLE });
  }
  const data = await res.json().catch(() => ({}));
  if (typeof data?.token !== 'string' || !data.token) {
    throw new LyricCaptionsError('Streaming captions are unavailable right now.', { status: 502, code: STREAMING_UNAVAILABLE });
  }
  return data.token;
}

export const _mintScribeTokenForTests = mintScribeToken;

const defaultHooks = {
  isConfigured: () => Boolean(ELEVENLABS_API_KEY),
  mintToken: mintScribeToken,
  charge: requireInferenceAccess,
};
let hooks = { ...defaultHooks };
/** Tests: replace the ElevenLabs call, the key check, or the quota step. No argument resets. */
export function _setStreamingCaptionsHooks(overrides) {
  hooks = overrides ? { ...defaultHooks, ...overrides } : { ...defaultHooks };
}

// sessionId → { userId, at, charged, charging }: one captions job. A resumed session (a new token after a
// dropped connection, same sessionId) is the same job, so the edit is counted once however many tokens it uses.
const sessions = new Map();
function pruneSessions(now = Date.now()) {
  for (const [id, s] of sessions) if (now - s.at > SESSION_TTL_MS) sessions.delete(id);
}
export function _clearStreamingSessionsForTests() { sessions.clear(); }

const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many caption sessions, please try again later.', code: 'rate_limited', operation: 'streaming_captions' },
});
const translateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // about 40 batches for a 10-minute clip, with room for retries and a few clips
  message: { error: 'Too many translation requests, please try again later.', code: 'rate_limited', operation: 'streaming_captions' },
});
export const _limitersForTests = { tokenLimiter, translateLimiter };

function sendStreamingError(res, err, fallback) {
  if (err instanceof LyricCaptionsError) return res.status(err.status).json({ ...err.toJSON(), operation: 'streaming_captions' });
  console.error(`[streaming_captions] ${fallback}:`, err?.message || err);
  return res.status(500).json({ error: fallback, operation: 'streaming_captions' });
}

/** 503 before anything is minted or charged when the key is not configured. */
function requireConfigured(req, res, next) {
  if (hooks.isConfigured()) return next();
  return res.status(503).json({
    error: 'Streaming captions are unavailable on this server: ELEVENLABS_API_KEY is not set.',
    code: STREAMING_UNAVAILABLE,
    operation: 'streaming_captions',
  });
}

async function mintStep(req, res, next) {
  try {
    req.scribeToken = await hooks.mintToken();
    return next();
  } catch (err) {
    return sendStreamingError(res, err, 'Failed to start streaming captions');
  }
}

/** The session a request belongs to: same user and still fresh, otherwise none. */
function sessionFor(req, id) {
  if (typeof id !== 'string' || !id) return null;
  const s = sessions.get(id);
  if (!s || s.userId !== (req.user?.id ?? null) || Date.now() - s.at >= SESSION_TTL_MS) return null;
  return s;
}

/** Run the quota/charge middleware outside the request pipeline: resolves { ok } or the refusal it would have sent. */
function runCharge(req) {
  return new Promise((resolve) => {
    const headers = {};
    const fake = {
      statusCode: 200,
      set(k, v) { if (typeof k === 'string') headers[k] = v; else Object.assign(headers, k); return this; },
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ ok: false, status: this.statusCode, body, headers }); return this; },
    };
    Promise.resolve(hooks.charge(req, fake, () => resolve({ ok: true, headers })))
      .catch(() => resolve({ ok: false, status: 500, body: { error: 'Unable to check daily inference limit' }, headers }));
  });
}

/**
 * Charge the edit for this captions job, once. Called only after a batch produced a translated line,
 * so a job that never gets one is never counted and a resume (same sessionId) never re-charges. A request
 * without a known session is its own job. Returns { ok:true, headers } or the refusal to send.
 */
async function chargeJobOnce(req, session) {
  if (session?.charged) return { ok: true, headers: {} };
  if (!session) return runCharge(req);
  if (!session.charging) {
    session.charging = runCharge(req).then((r) => { if (r.ok) session.charged = true; session.charging = null; return r; });
  }
  return session.charging;
}

const router = express.Router();

router.get('/api/streaming-captions/status', apiLimiter, requireAuthenticatedUser, (req, res) => {
  res.set('Cache-Control', 'no-store');
  let translate = true;
  try { assertTranslateAvailable(); } catch { translate = false; }
  return res.json({ available: Boolean(hooks.isConfigured() && translate), provider: 'elevenlabs', model: SCRIBE_MODEL_ID });
});

router.post('/api/streaming-captions/token', tokenLimiter, requireAuthenticatedUser, requireActiveSubscription, requireConfigured, mintStep, (req, res) => {
  pruneSessions();
  // The same sessionId continues the same job: it keeps its charged flag, and its token costs no new edit.
  const prior = sessionFor(req, req.body?.resumeSessionId);
  const sessionId = prior ? req.body.resumeSessionId : randomUUID();
  sessions.set(sessionId, { userId: req.user?.id ?? null, at: Date.now(), charged: Boolean(prior?.charged), charging: prior?.charging || null });
  const source = req.body?.source_language ?? req.body?.sourceLanguage;
  const language = source == null || source === '' ? 'auto' : normalizeLanguageCode(source, { allowAuto: true });
  const query = {
    model_id: SCRIBE_MODEL_ID,
    audio_format: 'pcm_16000',
    include_timestamps: 'true',
    commit_strategy: 'manual',
    ...(language && language !== 'auto' ? { language_code: language } : {}),
  };
  res.set('Cache-Control', 'no-store');
  // The token is the only credential here and is never logged.
  return res.json({
    token: req.scribeToken,
    expiresInSec: SCRIBE_TOKEN_TTL_SEC,
    sessionId,
    wsUrl: scribeWsUrl(),
    query,
    sampleRate: 16000,
    maxAudioSeconds: STREAMING_MAX_AUDIO_SECONDS,
    operation: 'streaming_captions',
  });
});

router.post('/api/streaming-captions/translate', translateLimiter, requireAuthenticatedUser, requireActiveSubscription, async (req, res) => {
  try {
    assertTranslateAvailable();
    const parsed = parseTranslateRequest(req.body || {});
    const out = await translateSpeechSegments(parsed);
    if ((out.lines || []).some(l => String(l?.translation || '').trim())) {
      const session = sessionFor(req, req.body?.sessionId);
      if (session) session.at = Date.now();
      const charge = await chargeJobOnce(req, session);
      for (const [k, v] of Object.entries(charge.headers || {})) res.set(k, v);
      if (!charge.ok) return res.status(charge.status).json(charge.body);
    }
    return res.json({ ...out, targetLanguage: parsed.targetLanguage, operation: 'streaming_captions' });
  } catch (err) {
    if (err instanceof LyricCaptionsError) return sendStreamingError(res, err);
    console.error('[streaming_captions] translate failed:', err?.message || err);
    // Retryable: the model call failed, the client repeats the batch.
    return res.status(502).json({ error: 'Translation failed', code: 'translation_failed', retryable: true, operation: 'streaming_captions' });
  }
});

router.post('/api/streaming-captions/burn', videoProcessLimiter, requireAuthenticatedUser, refuseIosBurn, uploadSingle('video'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) throw new LyricCaptionsError('No video file provided (multipart field "video")');
    const lines = parseBurnLines(req.body?.lines);
    const targetLanguage = parseTargetLanguage(req.body?.target_language ?? req.body?.targetLanguage) || null;
    const language = req.body?.language ? normalizeLanguageCode(req.body.language, { allowAuto: false }) : null;
    let args = {};
    if (req.body?.args) {
      try { args = JSON.parse(req.body.args); } catch { throw new LyricCaptionsError('args must be valid JSON'); }
    }
    const style = parseStyleOptions(args);
    const out = await burnLinesOnServer({ videoBuffer: req.file.buffer, lines, language, targetLanguage, style });
    res.set('Content-Type', 'video/mp4');
    res.set('X-Lyric-Captions-Burn', 'server');
    return res.send(out);
  } catch (err) {
    return sendError(res, err, 'Failed to burn captions');
  }
});

export { router as streamingCaptionsRouter };
