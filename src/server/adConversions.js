// Server-side ad conversions (X Conversions API + Reddit Conversions API v3). One module, two callers:
//  1. forwardConversion(): FinalCut web telemetry events, from POST /api/telemetry. No client pixels: the
//     site serves COEP require-corp for ffmpeg wasm, so third-party pixel scripts are avoided.
//     Env: X_ADS_PIXEL_ID, X_ADS_EVENT_IDS, REDDIT_ADS_PIXEL_ID, REDDIT_ADS_EVENTS, REDDIT_ADS_TEST_ID.
//     Fire-and-forget: never throws and never awaits on the request path.
//  2. sendConversion(): Stripe purchases / trial starts (music, compose), from the Stripe webhook, so they
//     count even when an ad blocker stops the browser pixel. Dedupe: the landing page makes an event_id
//     before checkout; it rides in Checkout metadata and is sent as conversion_id (the thanks-page pixel
//     uses the same value). Pixels are per product: <PREFIX>_X_PIXEL_ID, <PREFIX>_X_EVENT_ID_PURCHASE,
//     <PREFIX>_X_EVENT_ID_START_TRIAL, <PREFIX>_REDDIT_PIXEL_ID (PREFIX = MUSIC | COMPOSE).
// Shared credentials: X_ADS_CONSUMER_KEY, X_ADS_CONSUMER_SECRET, X_ADS_ACCESS_TOKEN, X_ADS_ACCESS_TOKEN_SECRET;
// Reddit token REDDIT_ADS_ACCESS_TOKEN or REDDIT_CAPI_TOKEN (both names are read, by either caller).
// Always on: each platform sends whenever its credentials are set; with nothing set this is a no-op.
// Docs: docs/marketing/ad-conversions.md, docs/STRIPE.md
import crypto from 'crypto';

const X_API = 'https://ads-api.x.com/12/measurement/conversions/';
const REDDIT_API = 'https://ads-api.reddit.com/api/v3/pixels/';
const TIMEOUT_MS = 3000;

// telemetry event -> Reddit v3 tracking_type. Events not listed are not sent to Reddit
// (override with REDDIT_ADS_EVENTS, a JSON map event -> tracking_type or "CUSTOM").
export const DEFAULT_REDDIT_EVENTS = Object.freeze({
  landing_view: 'PAGE_VISIT',
  signup: 'SIGN_UP',
  upgrade: 'PURCHASE',
  sample_start: 'CUSTOM',
  first_edit: 'CUSTOM',
  captions_start: 'CUSTOM',
  translate: 'CUSTOM',
  export_done: 'CUSTOM',
});
const REDDIT_TYPES = new Set(['PAGE_VISIT', 'VIEW_CONTENT', 'SEARCH', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'PURCHASE', 'LEAD', 'SIGN_UP', 'CUSTOM']);

const BOT_UA = /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|selenium|lighthouse|pingdom|uptime|curl|wget|python-requests|axios|node-fetch|go-http/i;

function env(name) { return String(process.env[name] || '').trim(); }
function parseJson(name) {
  const raw = env(name);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

export function xConfig() {
  const c = {
    pixelId: env('X_ADS_PIXEL_ID'), eventIds: parseJson('X_ADS_EVENT_IDS'),
    consumerKey: env('X_ADS_CONSUMER_KEY'), consumerSecret: env('X_ADS_CONSUMER_SECRET'),
    token: env('X_ADS_ACCESS_TOKEN'), tokenSecret: env('X_ADS_ACCESS_TOKEN_SECRET'),
  };
  return c.pixelId && c.eventIds && c.consumerKey && c.consumerSecret && c.token && c.tokenSecret ? c : null;
}

// Reddit conversion token: either env name works (telemetry used REDDIT_ADS_ACCESS_TOKEN, purchases REDDIT_CAPI_TOKEN).
export function redditToken(e = process.env) {
  return String(e.REDDIT_ADS_ACCESS_TOKEN || e.REDDIT_CAPI_TOKEN || '').trim();
}

export function redditConfig() {
  const pixelId = env('REDDIT_ADS_PIXEL_ID');
  const token = redditToken();
  if (!pixelId || !token) return null;
  return { pixelId, token, events: parseJson('REDDIT_ADS_EVENTS') || DEFAULT_REDDIT_EVENTS, testId: env('REDDIT_ADS_TEST_ID') };
}

export function conversionsEnabled() { return Boolean(xConfig() || redditConfig()); }

/** SHA-256 hex of a normalized email (trim + lowercase), per X and Reddit specs. Not used by default. */
export function hashEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  return v ? crypto.createHash('sha256').update(v).digest('hex') : null;
}

/** Stable id for dedupe: same install + session + event (+ step) => same id on retries. */
export function stableEventId(row) {
  const step = row.props && row.props.step ? `:${row.props.step}` : '';
  return crypto.createHash('sha256').update(`${row.anon_id}:${row.session_id || ''}:${row.event}${step}`).digest('hex').slice(0, 32);
}

export function isBotOrTest({ userAgent, row, testHeader }) {
  if (!userAgent || BOT_UA.test(userAgent)) return true;
  if (testHeader) return true;
  if (row && /^test-/i.test(row.anon_id || '')) return true;
  if (row && row.props && (row.props.utm_source === 'test' || row.props.utm_medium === 'test')) return true;
  return false;
}

// ---- OAuth 1.0a (HMAC-SHA1), user context. JSON bodies are not part of the signature base. ----
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export function oauth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp }) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const params = [...Object.entries(oauth), ...u.searchParams.entries()]
    .map(([k, v]) => [pct(k), pct(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(params)].join('&');
  const signature = crypto.createHmac('sha1', `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest('base64');
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');
}

export function buildXRequest(cfg, { row, clickIds, ip, userAgent, eventId, now }) {
  const xEventId = cfg.eventIds[row.event];
  if (!xEventId) return null;
  const identifiers = [];
  if (clickIds.twclid) identifiers.push({ twclid: clickIds.twclid });
  if (!identifiers.length) return null; // X needs a click id (or hashed email/phone); ip+UA alone don't match
  if (ip && userAgent) identifiers.push({ ip_address: ip, user_agent: userAgent });
  const url = `${X_API}${encodeURIComponent(cfg.pixelId)}`;
  const body = JSON.stringify({ conversions: [{ conversion_time: new Date(now).toISOString(), event_id: String(xEventId), identifiers, conversion_id: eventId }] });
  return { url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: oauth1Header({ method: 'POST', url, ...cfg }) }, body } };
}

export function buildRedditRequest(cfg, { row, clickIds, ip, userAgent, eventId, now }) {
  // Reddit only receives events for visitors who arrived from a Reddit ad click.
  if (!clickIds?.rdt_cid) return null;
  let type = cfg.events[row.event];
  if (!type) return null;
  type = String(type).toUpperCase();
  if (!REDDIT_TYPES.has(type)) type = 'CUSTOM';
  if (row.event === 'upgrade' && type === 'PURCHASE' && row.props?.step && row.props.step !== 'paid') return null;
  const event = {
    event_at: now,
    action_source: 'WEBSITE',
    type: type === 'CUSTOM' ? { tracking_type: 'CUSTOM', custom_event_name: row.event } : { tracking_type: type },
    click_id: clickIds.rdt_cid,
    metadata: { conversion_id: eventId },
  };
  const user = {};
  if (ip) user.ip_address = ip;
  if (userAgent) user.user_agent = userAgent;
  if (Object.keys(user).length) event.user = user;
  const data = { events: [event] };
  if (cfg.testId) data.test_id = cfg.testId;
  return {
    url: `${REDDIT_API}${encodeURIComponent(cfg.pixelId)}/conversion_events`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` }, body: JSON.stringify({ data }) },
  };
}

// Rate-limited failure logging: at most one line per provider per minute.
const lastLog = new Map();
function logFailure(provider, msg) {
  const t = Date.now();
  if (t - (lastLog.get(provider) || 0) < 60000) return;
  lastLog.set(provider, t);
  console.warn(`[ad-conversions] ${provider} failed: ${msg}`);
}
export function _resetLogLimiter() { lastLog.clear(); }

async function post(provider, req, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(req.url, { ...req.init, signal: ctrl.signal });
    if (!res.ok) logFailure(provider, `HTTP ${res.status}`);
  } catch (err) {
    logFailure(provider, err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err)));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward one sanitized telemetry row. Returns a promise (for tests) but callers must not await it.
 * ctx: { clickIds: { twclid, rdt_cid }, ip, userAgent, testHeader, fetchImpl, now }
 */
export function forwardConversion(row, ctx = {}) {
  try {
    const x = xConfig();
    const reddit = redditConfig();
    if (!x && !reddit) return Promise.resolve([]);
    if (!row || row.platform !== 'web') return Promise.resolve([]);
    if (isBotOrTest({ userAgent: ctx.userAgent, row, testHeader: ctx.testHeader })) return Promise.resolve([]);
    const fetchImpl = ctx.fetchImpl || globalThis.fetch;
    const args = {
      row, clickIds: ctx.clickIds || {}, ip: ctx.ip || null,
      userAgent: String(ctx.userAgent || '').slice(0, 512), eventId: stableEventId(row), now: ctx.now || Date.now(),
    };
    const jobs = [];
    if (x) { const r = buildXRequest(x, args); if (r) jobs.push(post('x', r, fetchImpl)); }
    if (reddit) { const r = buildRedditRequest(reddit, args); if (r) jobs.push(post('reddit', r, fetchImpl)); }
    return Promise.all(jobs).catch(() => []);
  } catch (err) {
    logFailure('internal', err?.message || String(err));
    return Promise.resolve([]);
  }
}

// ---- Stripe purchases (music, compose) ----
// conv: { kind: 'purchase'|'start_trial', eventId, value, currency, email, twclid, rdtCid, at: Date, sourceUrl }
export function buildPurchaseXRequest(conv, env = process.env) {
  const px = conv.adsPrefix || 'MUSIC';
  const pixelId = env[`${px}_X_PIXEL_ID`];
  const eventId = conv.kind === 'start_trial' ? env[`${px}_X_EVENT_ID_START_TRIAL`] : env[`${px}_X_EVENT_ID_PURCHASE`];
  const creds = {
    consumerKey: env.X_ADS_CONSUMER_KEY, consumerSecret: env.X_ADS_CONSUMER_SECRET,
    token: env.X_ADS_ACCESS_TOKEN, tokenSecret: env.X_ADS_ACCESS_TOKEN_SECRET,
  };
  if (!pixelId || !eventId || Object.values(creds).some((v) => !v)) return null;
  const identifiers = [];
  if (conv.twclid) identifiers.push({ twclid: conv.twclid });
  const h = hashEmail(conv.email);
  if (h) identifiers.push({ hashed_email: h });
  if (!identifiers.length) return null; // X needs at least one identifier
  const c = {
    conversion_time: conv.at.toISOString(),
    event_id: eventId,
    identifiers,
    conversion_id: conv.eventId,
    description: conv.kind,
  };
  if (conv.value > 0) { c.value = Number(conv.value.toFixed(2)); c.price_currency = conv.currency || 'USD'; }
  const url = `https://ads-api.x.com/12/measurement/conversions/${encodeURIComponent(pixelId)}`;
  return { url, body: { conversions: [c] }, creds };
}

export function buildPurchaseRedditRequest(conv, env = process.env) {
  const pixelId = env[`${conv.adsPrefix || 'MUSIC'}_REDDIT_PIXEL_ID`];
  const token = redditToken(env);
  if (!pixelId || !token) return null;
  const ev = {
    event_at: conv.at.getTime(),
    action_source: 'WEBSITE',
    type: conv.kind === 'start_trial' ? { tracking_type: 'CUSTOM', custom_event_name: 'StartTrial' } : { tracking_type: 'PURCHASE' },
    metadata: { conversion_id: conv.eventId, currency: conv.currency || 'USD', value: conv.value > 0 ? Number(conv.value.toFixed(2)) : 0 },
    user: {},
  };
  if (conv.rdtCid) ev.click_id = conv.rdtCid;
  if (conv.sourceUrl) ev.event_source_url = conv.sourceUrl;
  const h = hashEmail(conv.email);
  if (h) ev.user.email = h;
  return {
    url: `https://ads-api.reddit.com/api/v3/pixels/${encodeURIComponent(pixelId)}/conversion_events`,
    body: { data: { events: [ev] } },
    token,
  };
}

// Never throws: ad reporting must not break the webhook. Returns per-platform results for logs/tests.
export async function sendConversion(conv, { env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  if (!conv?.eventId) return { skipped: true };
  const out = {};
  const x = buildPurchaseXRequest(conv, env);
  if (x) {
    try {
      const r = await fetchImpl(x.url, { method: 'POST', headers: { Authorization: oauth1Header({ method: 'POST', url: x.url, ...x.creds }), 'Content-Type': 'application/json' }, body: JSON.stringify(x.body) });
      out.x = r.status;
      if (!r.ok) log.warn?.(`[ads] X CAPI ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    } catch (e) { out.x = 'error'; log.warn?.(`[ads] X CAPI error: ${e.message}`); }
  }
  const rd = buildPurchaseRedditRequest(conv, env);
  if (rd) {
    try {
      const r = await fetchImpl(rd.url, { method: 'POST', headers: { Authorization: `Bearer ${rd.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(rd.body) });
      out.reddit = r.status;
      if (!r.ok) log.warn?.(`[ads] Reddit CAPI ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    } catch (e) { out.reddit = 'error'; log.warn?.(`[ads] Reddit CAPI error: ${e.message}`); }
  }
  return out;
}
