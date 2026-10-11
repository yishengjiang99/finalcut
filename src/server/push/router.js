// FinalCap push endpoints (all new paths — additive for the iOS contract gate).
//
// App (Bearer device session from POST /api/auth/mobile/device):
//   POST   /api/push/register  {token, environment: sandbox|production, tz?, appVersion?, marketingOptIn?}
//   DELETE /api/push/register  {token?}            notifications turned off / signed out
//   GET    /api/push/prefs                          {registered, marketingOptIn}
//   PUT    /api/push/prefs     {marketingOptIn}     the "Tips & offers" toggle
//   POST   /api/push/events    {event, sendId?}     allowlisted names only
// Admin (header X-Push-Admin-Secret = PUSH_ADMIN_SECRET; 404 while unset):
//   GET  /api/push/lifecycle/report?days=7
//   POST /api/push/lifecycle/tick     {dryRun?: true}   forced dry run unless body.dryRun === false
//   POST /api/push/lifecycle/ops      {killSwitch?: 'on'|'off', mode?: <downgrade only>|null}
//   POST /api/push/lifecycle/preview  {segment, facts?}  copy generation only, sends nothing
import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { attachBearerUser } from '../middleware.js';
import { createMysqlPushStore } from './store.js';
import { runLifecycleTick, lifecycleReport, effectiveMode, MODES } from './lifecycle.js';
import { generateCopy } from './copy.js';
import { SEGMENTS } from './segments.js';

export const PUSH_EVENTS = Object.freeze(new Set(['app_open', 'export_done', 'paywall_view', 'push_opened', 'marketing_opt_in', 'marketing_opt_out']));
const TOKEN_RE = /^[0-9a-fA-F]{64,200}$/;
const SEND_ID_RE = /^[0-9a-fA-F-]{36}$/;

let storeFactory = () => createMysqlPushStore();
export function setPushStoreForTests(f) { storeFactory = f || (() => createMysqlPushStore()); }
export const getPushStore = () => storeFactory();

function validTz(tz) {
  if (typeof tz !== 'string' || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
const json = express.json({ limit: '4kb' });

async function bearer(req, res, next) {
  try {
    if (!(await attachBearerUser(req))) return res.status(401).json({ error: 'Device session required' });
    return next();
  } catch (e) {
    return res.status(e.statusCode === 401 ? 401 : 500).json({ error: e.statusCode === 401 ? 'Invalid or expired access token' : 'Authentication error' });
  }
}

function admin(req, res, next) {
  const secret = (process.env.PUSH_ADMIN_SECRET || '').trim();
  const given = String(req.get('x-push-admin-secret') || '');
  if (secret.length < 16 || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) return res.status(404).json({ error: 'Not found' });
  return next();
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error('[push]', req.path, e?.message || e); res.status(500).json({ error: 'push_error' }); }
};

const router = express.Router();
router.use('/api/push', limiter, json);

router.post('/api/push/register', bearer, wrap(async (req, res) => {
  const { token, environment, tz, appVersion, marketingOptIn } = req.body || {};
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return res.status(400).json({ error: 'invalid token' });
  if (environment !== 'sandbox' && environment !== 'production') return res.status(400).json({ error: 'environment must be sandbox or production' });
  const store = getPushStore();
  await store.upsertDevice({ userId: req.user.id, token: token.toLowerCase(), environment, tz: validTz(tz),
    appVersion: typeof appVersion === 'string' && /^[0-9A-Za-z.() -]{1,32}$/.test(appVersion) ? appVersion : null,
    marketingOptIn: typeof marketingOptIn === 'boolean' ? marketingOptIn : undefined });
  res.json({ ok: true, ...(await store.publicPrefs(req.user.id)) });
}));

router.delete('/api/push/register', bearer, wrap(async (req, res) => {
  const t = typeof req.body?.token === 'string' && TOKEN_RE.test(req.body.token) ? req.body.token.toLowerCase() : null;
  await getPushStore().disableUserDevices(req.user.id, 'app_unregistered', t);
  res.json({ ok: true });
}));

router.get('/api/push/prefs', bearer, wrap(async (req, res) => { res.json(await getPushStore().publicPrefs(req.user.id)); }));

router.put('/api/push/prefs', bearer, wrap(async (req, res) => {
  const v = req.body?.marketingOptIn;
  if (typeof v !== 'boolean') return res.status(400).json({ error: 'marketingOptIn must be boolean' });
  const store = getPushStore();
  await store.setMarketingOptIn(req.user.id, v);
  await store.recordEvent(req.user.id, v ? 'marketing_opt_in' : 'marketing_opt_out');
  res.json({ ok: true, ...(await store.publicPrefs(req.user.id)) });
}));

router.post('/api/push/events', bearer, wrap(async (req, res) => {
  const { event, sendId } = req.body || {};
  if (typeof event !== 'string' || !PUSH_EVENTS.has(event) || event.startsWith('marketing_')) return res.status(400).json({ error: 'unknown event' });
  const sid = typeof sendId === 'string' && SEND_ID_RE.test(sendId) ? sendId.toLowerCase() : null;
  await getPushStore().recordEvent(req.user.id, event, event === 'push_opened' ? sid : null);
  res.status(202).json({ ok: true });
}));

router.get('/api/push/lifecycle/report', admin, wrap(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  res.json(await lifecycleReport(getPushStore(), { days }));
}));

router.post('/api/push/lifecycle/tick', admin, wrap(async (req, res) => {
  const real = req.body?.dryRun === false;
  res.json(await runLifecycleTick({ store: getPushStore(), ...(real ? {} : { modeOverride: 'dry_run' }) }));
}));

router.post('/api/push/lifecycle/ops', admin, wrap(async (req, res) => {
  const store = getPushStore();
  const { killSwitch, mode } = req.body || {};
  if (killSwitch === 'on' || killSwitch === 'off') await store.setOp('kill_switch', killSwitch === 'on' ? 'on' : null);
  if (mode === null) await store.setOp('mode', null);
  else if (typeof mode === 'string') {
    if (!MODES.includes(mode)) return res.status(400).json({ error: 'invalid mode' });
    await store.setOp('mode', mode); // effectiveMode() only lets this downgrade the env mode
  }
  res.json(await effectiveMode(store));
}));

router.post('/api/push/lifecycle/preview', admin, wrap(async (req, res) => {
  const seg = SEGMENTS[req.body?.segment];
  if (!seg) return res.status(400).json({ error: 'unknown segment' });
  const f = req.body?.facts || {};
  const facts = { tier: f.tier === 'pro' ? 'pro' : 'free', editsLastWeek: ['0', '1-3', '4+'].includes(f.editsLastWeek) ? f.editsLastWeek : '1-3', hasExported: Boolean(f.hasExported) };
  res.json(await generateCopy(seg.id, seg.goal, facts, { bypassCache: true }));
}));

export { router as pushRouter };
