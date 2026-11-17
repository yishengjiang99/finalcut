// Forwards GBK Composer money events to gbk (compose.grepawk.com), so its billing funnel sees Stripe
// purchases the same way it sees Apple ones. Receiving end: gbk server/src/routes/billing.ts
//   POST <COMPOSE_SITE_URL>/api/billing/stripe-events   header x-gbk-billing-token: $COMPOSE_BILLING_WEBHOOK_TOKEN
//   { event, plan?, value_cents?, surface: 'pricing', platform: 'web', detail: <stripe object id>, ads_opt_out: '1' }
// - Only compose money events this service already records in product_events (trial_start, purchase,
//   trial_convert, renewal, cancel, refund), and only when the row is new, so Stripe retries are not
//   double-counted. checkout_start is not forwarded: gbk's pricing page already reports it.
// - ads_opt_out is always '1': this service already sends the X/Reddit conversions (adConversions.js),
//   so gbk must not send them a second time. No email or account: gbk records an aggregate count.
// - Fire and forget: callers do not await it, so Stripe's 200 never waits on gbk. 3 s timeout, one
//   retry on a network error, timeout, 429 or 5xx. Never throws. Unset token = skipped.
// - The token is never logged.
import { composeSiteUrl } from './products.js';

export const HOP_EVENTS = new Set(['trial_start', 'purchase', 'trial_convert', 'renewal', 'cancel', 'refund']);
const GBK_PLANS = new Set(['pro_monthly', 'pro_yearly', 'lifetime']);

export function hopToken(env = process.env) {
  return String(env.COMPOSE_BILLING_WEBHOOK_TOKEN || '').trim();
}

/** product_events row (as passed to recordProductEvent) -> gbk hop payload, or null if not forwarded. */
export function gbkHopPayload(e) {
  if (!e || !HOP_EVENTS.has(e.type)) return null;
  const out = { event: e.type, surface: 'pricing', platform: 'web', ads_opt_out: '1' };
  if (GBK_PLANS.has(e.plan)) out.plan = e.plan;
  if (Number.isFinite(e.amountCents) && e.amountCents > 0) out.value_cents = Math.round(e.amountCents);
  if (e.ref) out.detail = String(e.ref).slice(0, 120);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns a promise (for tests) that always resolves: { skipped } | { ok, status, attempts }. */
export function forwardBillingEvent(e, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 3000, retryDelayMs = 500 } = {}) {
  const token = hopToken(env);
  const payload = gbkHopPayload(e);
  if (!token || !payload) return Promise.resolve({ skipped: true });
  return (async () => {
    let url;
    try { url = `${composeSiteUrl(env)}/api/billing/stripe-events`; } catch (error) {
      console.error('[compose] gbk hop: bad COMPOSE_SITE_URL:', error.message);
      return { ok: false, status: 0, attempts: 0 };
    }
    let status = 0, attempts = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      attempts = attempt;
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gbk-billing-token': token },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        if (res.ok) return { ok: true, status, attempts: attempt };
        if (status !== 429 && status < 500) break;  // 401/404/400: retrying will not help
      } catch (error) {
        status = 0;
        if (attempt === 2) console.error(`[compose] gbk hop ${payload.event} ${payload.detail || ''} error:`, error.name);
      }
      if (attempt === 1) await sleep(retryDelayMs);
    }
    if (status) console.error(`[compose] gbk hop ${payload.event} ${payload.detail || ''} failed: HTTP ${status}`);
    return { ok: false, status, attempts };
  })().catch(() => ({ ok: false, status: 0, attempts: 0 }));
}
