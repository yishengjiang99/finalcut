// First-party, anonymous product telemetry for the FinalCap web app: POST /api/telemetry.
//
// Same pattern as photo.grepawk.com's in-house telemetry (yishengjiang99/photo-recipes
// docs/telemetry.md), in this app's own MySQL database (table finalcut_telemetry_events,
// docs/migrations/finalcut_telemetry_events.sql). Privacy rules (see public/legal/privacy.html):
//   - mounted BEFORE the session middleware, so it never sets or reads a cookie;
//   - stores no IP address and no IP hash (the IP is used only in memory by the rate limiter);
//   - events and prop keys are allowlisted; prop values are short tokens (tool names, buckets,
//     formats). No prompt text, file names, media, frames, emails or account ids are accepted;
//   - a random install id that the browser keeps in localStorage, and a per-tab session id.
// Optional summary: GET /api/telemetry/summary?days=7 with header X-Telemetry-Read-Key equal to
// TELEMETRY_READ_KEY (the route answers 404 while that variable is unset).
import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { getPool } from '../db.js';

export const TELEMETRY_TABLE = 'finalcut_telemetry_events';

export const TELEMETRY_EVENTS = Object.freeze(new Set([
  'landing_view',     // landing page shown
  'cta_click',        // landing CTA (start / sample / sign in)
  'video_loaded',     // a file was opened in the editor, or the sample was loaded
  'first_prompt',     // first chat prompt of the session
  'tool_executed',    // one editing tool finished (tool name only)
  'upload_consent',   // the "this step uploads" question was answered
  'export',           // the user downloaded/exported a result
  'app_store_click',  // click on an App Store link/badge
  'signup',           // returned from Google sign-in
  'upgrade',          // checkout started / subscription confirmed
]));

// Allowed prop keys and the shape of their values. Anything else is dropped.
const TOKEN = /^[A-Za-z0-9_.:\-/+ ]{1,64}$/;   // short machine tokens: tool names, buckets, formats
const PROP_RULES = Object.freeze({
  path: (v) => typeof v === 'string' && /^\/[A-Za-z0-9_\-./]{0,63}$/.test(v),
  ref: (v) => typeof v === 'string' && /^[a-z0-9.-]{1,64}$/.test(v),          // referrer host only
  utm_source: (v) => typeof v === 'string' && TOKEN.test(v),
  utm_medium: (v) => typeof v === 'string' && TOKEN.test(v),
  utm_campaign: (v) => typeof v === 'string' && TOKEN.test(v),
  cta: (v) => typeof v === 'string' && TOKEN.test(v),
  source: (v) => typeof v === 'string' && TOKEN.test(v),
  kind: (v) => typeof v === 'string' && TOKEN.test(v),
  container: (v) => typeof v === 'string' && TOKEN.test(v),
  size_bucket: (v) => typeof v === 'string' && TOKEN.test(v),
  dur_bucket: (v) => typeof v === 'string' && TOKEN.test(v),
  files: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  tool: (v) => typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v),
  ok: (v) => typeof v === 'boolean',
  ms_bucket: (v) => typeof v === 'string' && TOKEN.test(v),
  engine: (v) => typeof v === 'string' && TOKEN.test(v),
  input: (v) => typeof v === 'string' && TOKEN.test(v),
  prompt_len_bucket: (v) => typeof v === 'string' && TOKEN.test(v),
  allowed: (v) => typeof v === 'boolean',
  uploads: (v) => typeof v === 'string' && TOKEN.test(v),
  format: (v) => typeof v === 'string' && TOKEN.test(v),
  placement: (v) => typeof v === 'string' && TOKEN.test(v),
  method: (v) => typeof v === 'string' && TOKEN.test(v),
  step: (v) => typeof v === 'string' && TOKEN.test(v),
  is_mobile: (v) => typeof v === 'boolean',
  lang: (v) => typeof v === 'string' && /^[A-Za-z-]{2,16}$/.test(v),
  app_version: (v) => typeof v === 'string' && TOKEN.test(v),
});
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const PLATFORMS = new Set(['web', 'ios']);
export const MAX_BODY_BYTES = 2048;

/** Validate one event body. Returns { row } or { error }. Never throws. */
export function sanitizeTelemetryEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid body' };
  const { event, anon_id: anonId, session_id: sessionId, platform = 'web', props } = body;
  if (typeof event !== 'string' || !TELEMETRY_EVENTS.has(event)) return { error: 'unknown event' };
  if (typeof anonId !== 'string' || !ID_RE.test(anonId)) return { error: 'invalid anon_id' };
  if (sessionId != null && (typeof sessionId !== 'string' || !ID_RE.test(sessionId))) return { error: 'invalid session_id' };
  if (typeof platform !== 'string' || !PLATFORMS.has(platform)) return { error: 'invalid platform' };
  let cleanProps = null;
  if (props != null) {
    if (typeof props !== 'object' || Array.isArray(props)) return { error: 'invalid props' };
    cleanProps = {};
    for (const [key, value] of Object.entries(props)) {
      const rule = PROP_RULES[key];
      if (rule && rule(value)) cleanProps[key] = value;
    }
    if (!Object.keys(cleanProps).length) cleanProps = null;
  }
  return {
    row: {
      event,
      anon_id: anonId,
      session_id: sessionId || null,
      platform,
      app_version: cleanProps && typeof cleanProps.app_version === 'string' ? cleanProps.app_version.slice(0, 32) : null,
      props: cleanProps,
    },
  };
}

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${TELEMETRY_TABLE} (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  app VARCHAR(32) NOT NULL DEFAULT 'finalcut',
  platform VARCHAR(16) NOT NULL,
  event VARCHAR(64) NOT NULL,
  anon_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(64) NULL,
  app_version VARCHAR(32) NULL,
  props_json JSON NULL,
  KEY idx_fc_tel_created (created_at),
  KEY idx_fc_tel_event_time (event, created_at),
  KEY idx_fc_tel_anon_time (anon_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

let tableReady = null;
function ensureTable(pool) {
  if (!tableReady) {
    tableReady = pool.query(CREATE_TABLE_SQL).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

export async function insertTelemetryEvent(row, { pool = getPool() } = {}) {
  await ensureTable(pool);
  await pool.execute(
    `INSERT INTO ${TELEMETRY_TABLE} (platform, event, anon_id, session_id, app_version, props_json) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.platform, row.event, row.anon_id, row.session_id, row.app_version, row.props ? JSON.stringify(row.props) : null],
  );
}

export const RETENTION_DAYS = 395; // ~13 months, as stated in public/legal/privacy.html

/** Delete events older than the retention window. Safe to call repeatedly. */
export async function purgeOldTelemetry({ pool = getPool() } = {}) {
  await ensureTable(pool);
  const [result] = await pool.query(`DELETE FROM ${TELEMETRY_TABLE} WHERE created_at < (NOW(3) - INTERVAL ? DAY)`, [RETENTION_DAYS]);
  return result?.affectedRows ?? 0;
}

/** Run the purge shortly after start and then daily (timer does not keep the process alive). */
export function scheduleTelemetryPurge() {
  const run = () => purgeOldTelemetry().catch((err) => console.warn('[telemetry] purge failed:', err?.message || err));
  const first = setTimeout(run, 60 * 1000);
  const daily = setInterval(run, 24 * 60 * 60 * 1000);
  first.unref?.();
  daily.unref?.();
}

function readKeyOk(req) {
  const key = (process.env.TELEMETRY_READ_KEY || '').trim();
  const given = req.get('x-telemetry-read-key') || '';
  if (!key || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many telemetry events' },
});

export function createTelemetryRouter({ insert = insertTelemetryEvent, limiter = telemetryLimiter, summary } = {}) {
  const router = express.Router();
  // sendBeacon posts a Blob; accept JSON sent as application/json or text/plain.
  const parse = express.json({ limit: MAX_BODY_BYTES, type: ['application/json', 'text/plain'] });

  router.post('/api/telemetry', limiter, parse, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { row, error } = sanitizeTelemetryEvent(req.body);
    if (error) return res.status(400).json({ error });
    try {
      await insert(row);
      return res.status(204).end();
    } catch (err) {
      console.warn('[telemetry] insert failed:', err?.message || err);
      return res.status(202).json({ stored: false });
    }
  });

  router.get('/api/telemetry/summary', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(process.env.TELEMETRY_READ_KEY || '').trim()) return res.status(404).json({ error: 'Not found' });
    if (!readKeyOk(req)) return res.status(401).json({ error: 'Unauthorized' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    try {
      const run = summary || (async (d) => {
        const pool = getPool();
        await ensureTable(pool);
        const [events] = await pool.query(
          `SELECT event, COUNT(*) AS events, COUNT(DISTINCT anon_id) AS installs
             FROM ${TELEMETRY_TABLE} WHERE created_at >= (NOW(3) - INTERVAL ? DAY)
            GROUP BY event ORDER BY events DESC`, [d]);
        const [tools] = await pool.query(
          `SELECT JSON_UNQUOTE(JSON_EXTRACT(props_json, '$.tool')) AS tool, COUNT(*) AS runs,
                  SUM(JSON_EXTRACT(props_json, '$.ok') = true) AS ok
             FROM ${TELEMETRY_TABLE} WHERE event = 'tool_executed' AND created_at >= (NOW(3) - INTERVAL ? DAY)
            GROUP BY tool ORDER BY runs DESC LIMIT 50`, [d]);
        return { events, tools };
      });
      return res.json({ days, ...(await run(days)) });
    } catch (err) {
      return res.status(500).json({ error: 'summary failed' });
    }
  });

  return router;
}

export const telemetryRouter = createTelemetryRouter();
