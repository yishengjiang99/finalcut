// GBK Composer Pro (compose.grepawk.com) web checkout + entitlement lookup on grepawk.com.
//   POST /api/compose/checkout   plan=pro_monthly|pro_yearly|lifetime [+ email, event_id, utm_*, twclid, rdt_cid, landing]
//        HTML form post from compose.grepawk.com/pricing; 303 to Stripe Checkout. `email` (the signed-in
//        GBK account email, if any) prefills Checkout so the entitlement lands on the same address.
//   GET  /api/compose/entitlement?email=…   Authorization: Bearer $COMPOSE_ENTITLEMENT_TOKEN
//        Server-to-server only (the GBK server asks whether an account email has Pro). 404 when the
//        token is unset, so the endpoint does not exist until configured.
//        → { product, pro, plan, status, current_period_end (ISO), cancel_at_period_end }
//   POST /api/compose/portal  {email}  Authorization: Bearer $COMPOSE_ENTITLEMENT_TOKEN → { url }
//        Stripe Billing Portal session for that customer, returning to compose.grepawk.com/studio.
//   GET  /api/compose/portal?email&exp&sig   signed link (lifecycle emails) → 303 to the portal.
//   GET  /api/compose/events?since=ISO&until=ISO  Bearer → funnel events + counts for the GBK report.
// Webhook handling is shared with music (musicBilling.handleProductWebhookEvent, product='compose').
import express from 'express';
import { timingSafeEqual } from 'crypto';
import { stripe as defaultStripe } from './config.js';
import { apiLimiter } from './middleware.js';
import { COMPOSE_PRODUCT, PRODUCT_SPECS, resolveComposePlan } from './products.js';
import { attributionFrom, buildCheckoutParams } from './musicBilling.js';
import { verifyPortalLink, FUNNEL_TYPES } from './composeLifecycle.js';

export const PORTAL_RETURN_PATH = '/studio';

// Compose-only Checkout extras (#122): Stripe-hosted recovery link for abandoned sessions and the
// promotional-email consent checkbox (the recovery email is only sent with consent).
export function composeCheckoutParams(spec, plan, attribution, env, opts) {
  return {
    ...buildCheckoutParams(spec, plan, attribution, env, opts),
    after_expiration: { recovery: { enabled: true, allow_promotion_codes: true } },
    consent_collection: { promotions: 'auto' },
  };
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const wantsJson = (req) => (req.get('content-type') || '').includes('application/json');

function bearerOk(req, token) {
  const got = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createComposeRouter({ stripe = defaultStripe, db, env = process.env } = {}) {
  const getDb = async () => db || (await import('../db.js'));
  const spec = PRODUCT_SPECS[COMPOSE_PRODUCT];
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '8kb' });

  router.post('/api/compose/checkout', apiLimiter, form, async (req, res) => {
    const plan = resolveComposePlan(req.body?.plan, env);
    if (!plan) return res.status(400).json({ error: 'Unknown plan' });
    if (!stripe || !plan.priceId) return res.status(503).json({ error: 'Checkout for this plan is not configured yet' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    try {
      const session = await stripe.checkout.sessions.create(
        composeCheckoutParams(spec, plan, attributionFrom(req.body), env, { customerEmail: EMAIL_RE.test(email) ? email : undefined }));
      if (wantsJson(req)) return res.json({ sessionId: session.id, url: session.url });
      return res.redirect(303, session.url);
    } catch (error) {
      console.error('[compose] checkout error:', error.message);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  router.get('/api/compose/entitlement', apiLimiter, async (req, res) => {
    const token = env.COMPOSE_ENTITLEMENT_TOKEN || '';
    if (!token) return res.status(404).json({ error: 'Not configured' });
    if (!bearerOk(req, token)) return res.status(401).json({ error: 'Unauthorized' });
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
    try {
      const { hasProductEntitlement, getProductEntitlement } = await getDb();
      const [pro, row] = await Promise.all([hasProductEntitlement(email, COMPOSE_PRODUCT), getProductEntitlement(email, COMPOSE_PRODUCT)]);
      res.set('cache-control', 'no-store');
      return res.json(entitlementBody(pro, row));
    } catch (error) {
      console.error('[compose] entitlement error:', error.message);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  const openPortal = async (email) => {
    const { getProductEntitlement } = await getDb();
    const row = await getProductEntitlement(email, COMPOSE_PRODUCT);
    if (!row?.stripe_customer_id) return null;
    const session = await stripe.billingPortal.sessions.create({ customer: row.stripe_customer_id, return_url: `${spec.siteUrl(env)}${PORTAL_RETURN_PATH}` });
    return session.url;
  };

  router.post('/api/compose/portal', apiLimiter, express.json({ limit: '4kb' }), form, async (req, res) => {
    const token = env.COMPOSE_ENTITLEMENT_TOKEN || '';
    if (!token) return res.status(404).json({ error: 'Not configured' });
    if (!bearerOk(req, token)) return res.status(401).json({ error: 'Unauthorized' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });
    try {
      const url = await openPortal(email);
      if (!url) return res.status(404).json({ error: 'No Stripe customer for this email' });
      res.set('cache-control', 'no-store');
      return res.json({ url });
    } catch (error) {
      console.error('[compose] portal error:', error.message);
      return res.status(500).json({ error: 'Failed to create portal session' });
    }
  });

  // Signed link from the trial-ending email: no bearer, the HMAC (keyed by the same token) is the auth.
  router.get('/api/compose/portal', apiLimiter, async (req, res) => {
    const site = spec.siteUrl(env);
    if (!env.COMPOSE_ENTITLEMENT_TOKEN) return res.status(404).json({ error: 'Not configured' });
    if (!verifyPortalLink(req.query || {}, env)) return res.redirect(303, `${site}${PORTAL_RETURN_PATH}?portal=expired`);
    if (!stripe) return res.status(503).json({ error: 'Stripe is not configured' });
    try {
      const url = await openPortal(String(req.query.email).toLowerCase());
      return res.redirect(303, url || `${site}${PORTAL_RETURN_PATH}?portal=none`);
    } catch (error) {
      console.error('[compose] portal link error:', error.message);
      return res.redirect(303, `${site}${PORTAL_RETURN_PATH}?portal=error`);
    }
  });

  // Funnel events for the GBK report. Default window: last 30 days.
  router.get('/api/compose/events', apiLimiter, async (req, res) => {
    const token = env.COMPOSE_ENTITLEMENT_TOKEN || '';
    if (!token) return res.status(404).json({ error: 'Not configured' });
    if (!bearerOk(req, token)) return res.status(401).json({ error: 'Unauthorized' });
    const until = req.query?.until ? new Date(String(req.query.until)) : new Date();
    const since = req.query?.since ? new Date(String(req.query.since)) : new Date(until.getTime() - 30 * 864e5);
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return res.status(400).json({ error: 'Invalid since/until' });
    try {
      const { listProductEvents } = await getDb();
      const rows = await listProductEvents({ product: COMPOSE_PRODUCT, since, until, limit: 5000 });
      const counts = Object.fromEntries(FUNNEL_TYPES.map((t) => [t, 0]));
      for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;
      const events = rows.map((r) => ({ type: r.type, email: r.email, plan: r.plan, amount_cents: r.amount_cents, currency: r.currency, subscription: r.subscription_ref, at: new Date(r.occurred_at).toISOString() }));
      res.set('cache-control', 'no-store');
      return res.json({ product: COMPOSE_PRODUCT, since: since.toISOString(), until: until.toISOString(), counts, events });
    } catch (error) {
      console.error('[compose] events error:', error.message);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  return router;
}

export function entitlementBody(pro, row) {
  const end = row?.current_period_end ? new Date(Number(row.current_period_end) * 1000).toISOString() : null;
  return {
    product: COMPOSE_PRODUCT,
    pro,
    plan: row?.plan || null,
    status: row?.status || (row ? (row.active ? 'active' : 'canceled') : null),
    current_period_end: end,
    cancel_at_period_end: Boolean(row?.cancel_at_period_end),
  };
}
