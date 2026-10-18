// POST /api/client-log: a small, authenticated, rate-limited, size-capped sink for technical stage
// events from the browser (streaming captions debugging). Each event becomes one structured stdout
// line, so `journalctl -u finalcut | grep 'client-log'` shows them. Only technical fields are kept:
// never audio, transcript or caption text, tokens, keys or headers. Anything that looks like one is dropped.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuthenticatedUser } from './middleware.js';

export const CLIENT_LOG_MAX_BYTES = 16 * 1024;
export const CLIENT_LOG_MAX_EVENTS = 60;
const MAX_KEYS = 14;
const MAX_STRING = 120;
const STAGE_RE = /^[a-z0-9_.:-]{1,48}$/;
const SID_RE = /^[A-Za-z0-9_-]{6,64}$/;
// Keys that could carry content or credentials are never logged, whatever the client sends.
const BLOCKED_KEY_RE = /(token|secret|key|auth|password|cookie|text|transcript|caption|translation|audio|base64|line|word|body|header)/i;
// Values that look like credentials are replaced.
const SECRET_VALUE_RE = /(sutkn|xi-api|sk-[A-Za-z0-9]|bearer\s|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/=_-]{40,})/i;

export function sanitizeValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_STRING);
    return SECRET_VALUE_RE.test(s) ? '[redacted]' : s;
  }
  return undefined;
}

export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.ev !== 'string' || !STAGE_RE.test(raw.ev)) return null;
  const out = { ev: raw.ev };
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'ev' || n >= MAX_KEYS) continue;
    if (!/^[A-Za-z0-9_]{1,24}$/.test(k) || BLOCKED_KEY_RE.test(k)) continue;
    const clean = sanitizeValue(v);
    if (clean === undefined) continue;
    out[k] = clean;
    n++;
  }
  return out;
}

let sink = (line) => console.log(line);
/** Tests: capture the lines instead of writing them to stdout. No argument resets. */
export function _setClientLogSink(fn) { sink = fn || ((line) => console.log(line)); }

const clientLogLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 200,
  message: { error: 'Too many log requests.', code: 'rate_limited' },
});
export const _clientLogLimiterForTests = clientLogLimiter;

const router = express.Router();
router.post('/api/client-log', clientLogLimiter, requireAuthenticatedUser, express.json({ limit: CLIENT_LOG_MAX_BYTES }), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const sid = typeof body.sid === 'string' && SID_RE.test(body.sid) ? body.sid : null;
  const events = Array.isArray(body.events) ? body.events.slice(0, CLIENT_LOG_MAX_EVENTS) : [];
  if (!sid || !events.length) return res.status(400).json({ error: 'sid and events are required' });
  const ua = String(req.get('user-agent') || '').replace(/[\r\n]+/g, ' ').slice(0, 160);
  const user = req.user?.id ?? null;
  let kept = 0;
  events.forEach((raw, i) => {
    const ev = sanitizeEvent(raw);
    if (!ev) return;
    kept++;
    sink(`client-log ${JSON.stringify({ sid, u: user, i, ua: i === 0 ? ua : undefined, ...ev })}`);
  });
  return res.status(204).end();
});
// An oversized body is answered, not logged and not allowed to reach the large global parser.
router.use('/api/client-log', (err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Log batch too large' });
  return res.status(400).json({ error: 'Bad log request' });
});

export { router as clientLogRouter };
