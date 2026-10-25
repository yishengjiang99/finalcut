// Server-side ad conversions (X Conversions API + Reddit Conversions API v3) for Stripe purchases.
// Sent from the Stripe webhook, so they count even when an ad blocker stops the browser pixel.
// Dedupe: the landing page makes an event_id before checkout; it rides in Checkout metadata, the
// thanks page fires the pixel with it (X conversion_id / Reddit conversionId) and the same value is
// sent here as conversion_id, so each platform counts the purchase once.
//
// Off switch: ADS_TRACKING_ENABLED=0 (or false). Otherwise each platform sends only when its own
// credentials are set, so with nothing configured this is a no-op.
//   X:      MUSIC_X_PIXEL_ID, MUSIC_X_EVENT_ID_PURCHASE, MUSIC_X_EVENT_ID_START_TRIAL,
//           X_ADS_CONSUMER_KEY, X_ADS_CONSUMER_SECRET, X_ADS_ACCESS_TOKEN, X_ADS_ACCESS_TOKEN_SECRET
//   Reddit: MUSIC_REDDIT_PIXEL_ID, REDDIT_CAPI_TOKEN
// The MUSIC_ prefix is per product: conv.adsPrefix='COMPOSE' reads COMPOSE_X_PIXEL_ID etc. (API creds are shared).
// Docs: https://docs.x.com/x-ads-api/measurement/web-conversions
//       https://ads-api.reddit.com/docs/v3/guides/programs/capi/direct-integration
import { createHash, createHmac, randomBytes } from 'crypto';

export function adsTrackingEnabled(env = process.env) {
  const v = String(env.ADS_TRACKING_ENABLED ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

export function sha256Email(email) {
  if (!email || typeof email !== 'string') return '';
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// OAuth 1.0a HMAC-SHA1 header (JSON body is not part of the signature base string).
export function oauth1Header(method, url, creds, { nonce = randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: creds.token,
    oauth_version: '1.0',
  };
  const params = [...Object.entries(oauth), ...u.searchParams.entries()].map(([k, v]) => [pct(k), pct(v)]);
  params.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = [method.toUpperCase(), pct(`${u.origin}${u.pathname}`), pct(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const key = `${pct(creds.consumerSecret)}&${pct(creds.tokenSecret)}`;
  oauth.oauth_signature = createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.entries(oauth).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');
}

// conv: { kind: 'purchase'|'start_trial', eventId, value, currency, email, twclid, rdtCid, at: Date, sourceUrl }
export function buildXRequest(conv, env = process.env) {
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
  const h = sha256Email(conv.email);
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

export function buildRedditRequest(conv, env = process.env) {
  const pixelId = env[`${conv.adsPrefix || 'MUSIC'}_REDDIT_PIXEL_ID`];
  const token = env.REDDIT_CAPI_TOKEN;
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
  const h = sha256Email(conv.email);
  if (h) ev.user.email = h;
  return {
    url: `https://ads-api.reddit.com/api/v3/pixels/${encodeURIComponent(pixelId)}/conversion_events`,
    body: { data: { events: [ev] } },
    token,
  };
}

// Never throws: ad reporting must not break the webhook. Returns per-platform results for logs/tests.
export async function sendConversion(conv, { env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  if (!adsTrackingEnabled(env) || !conv?.eventId) return { skipped: true };
  const out = {};
  const x = buildXRequest(conv, env);
  if (x) {
    try {
      const r = await fetchImpl(x.url, { method: 'POST', headers: { Authorization: oauth1Header('POST', x.url, x.creds), 'Content-Type': 'application/json' }, body: JSON.stringify(x.body) });
      out.x = r.status;
      if (!r.ok) log.warn?.(`[ads] X CAPI ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    } catch (e) { out.x = 'error'; log.warn?.(`[ads] X CAPI error: ${e.message}`); }
  }
  const rd = buildRedditRequest(conv, env);
  if (rd) {
    try {
      const r = await fetchImpl(rd.url, { method: 'POST', headers: { Authorization: `Bearer ${rd.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(rd.body) });
      out.reddit = r.status;
      if (!r.ok) log.warn?.(`[ads] Reddit CAPI ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    } catch (e) { out.reddit = 'error'; log.warn?.(`[ads] Reddit CAPI error: ${e.message}`); }
  }
  return out;
}
