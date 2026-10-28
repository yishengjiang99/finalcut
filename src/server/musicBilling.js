// AI Music Radar web checkout + waitlist on grepawk.com (the landing page is music.grepawk.com).
// The landing page posts plain HTML forms here (no CORS needed, works without JS); we answer
// with a 303 to Stripe Checkout, or back to the landing page.
//   POST /api/music/checkout  plan=pro_monthly|pro_yearly|lifetime [+ event_id, utm_*, twclid, rdt_cid, landing]
//   POST /api/music/waitlist  email=… [+ same attribution fields]
// Webhook events for music sessions/subscriptions are handled by handleMusicWebhookEvent and
// only touch product_entitlements(product='music'), never users.has_subscription (FinalCut).
import express from 'express';
import { stripe as defaultStripe } from './config.js';
import { apiLimiter } from './middleware.js';
import { MUSIC_PRODUCT, COMPOSE_PRODUCT, PRODUCT_SPECS, resolveMusicPlan, musicSiteUrl, productOf } from './products.js';
import { sendConversion } from './adsConversions.js';
import * as lifecycle from './composeLifecycle.js';

export const ATTRIBUTION_KEYS = ['event_id', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'twclid', 'rdt_cid', 'landing', 'ads_opt_out'];

// Stripe metadata: ≤50 keys, key ≤40 chars, value ≤500 chars.
export function attributionFrom(body = {}) {
  const out = {};
  for (const k of ATTRIBUTION_KEYS) {
    const v = body[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, k === 'landing' ? 300 : 200);
  }
  if (out.event_id && !/^[A-Za-z0-9_.:-]{8,80}$/.test(out.event_id)) delete out.event_id;
  // Browser sent Global Privacy Control / Do Not Track: keep no click ids, report nothing to ad platforms.
  if (out.ads_opt_out) { out.ads_opt_out = '1'; delete out.twclid; delete out.rdt_cid; delete out.landing; }
  return out;
}

const wantsJson = (req) => (req.get('content-type') || '').includes('application/json');

// Shared by every product in PRODUCT_SPECS (music, compose).
export function buildCheckoutParams(spec, plan, attribution, env = process.env, { customerEmail } = {}) {
  const site = spec.siteUrl(env);
  const metadata = { product: spec.product, plan: plan.plan, ...attribution };
  const params = {
    mode: plan.mode,
    line_items: [{ price: plan.priceId, quantity: 1 }],
    success_url: `${site}${spec.successPath}?plan=${plan.plan}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}${spec.cancelPath}`,
    allow_promotion_codes: true,
    client_reference_id: attribution.event_id || undefined,
    metadata,
  };
  if (plan.mode === 'subscription') {
    params.subscription_data = { metadata };
    if (plan.trialDays > 0) params.subscription_data.trial_period_days = plan.trialDays;
  } else {
    params.payment_intent_data = { metadata };
    params.customer_creation = 'always';
  }
  if (customerEmail) params.customer_email = customerEmail;
  return params;
}

export function buildMusicCheckoutParams(plan, attribution, env = process.env) {
  return buildCheckoutParams(PRODUCT_SPECS[MUSIC_PRODUCT], plan, attribution, env);
}

export function createMusicRouter({ stripe = defaultStripe, db, env = process.env } = {}) {
  const getDb = async () => db || (await import('../db.js'));
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '8kb' });

  router.post('/api/music/checkout', apiLimiter, form, async (req, res) => {
    const plan = resolveMusicPlan(req.body?.plan, env);
    if (!plan) return res.status(400).json({ error: 'Unknown plan' });
    if (!stripe || !plan.priceId) return res.status(503).json({ error: 'Checkout for this plan is not configured yet' });
    try {
      const session = await stripe.checkout.sessions.create(buildMusicCheckoutParams(plan, attributionFrom(req.body), env));
      if (wantsJson(req)) return res.json({ sessionId: session.id, url: session.url });
      return res.redirect(303, session.url);
    } catch (error) {
      console.error('[music] checkout error:', error.message);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  router.post('/api/music/waitlist', apiLimiter, form, async (req, res) => {
    const site = musicSiteUrl(env);
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (req.body?.website) return res.redirect(303, `${site}/?waitlist=ok#waitlist`); // honeypot
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) {
      return wantsJson(req) ? res.status(400).json({ error: 'Invalid email' }) : res.redirect(303, `${site}/?waitlist=invalid#waitlist`);
    }
    try {
      const { addMusicWaitlist } = await getDb();
      await addMusicWaitlist(email, attributionFrom(req.body));
    } catch (error) {
      console.error('[music] waitlist error:', error.message);
      return wantsJson(req) ? res.status(500).json({ error: 'Failed' }) : res.redirect(303, `${site}/?waitlist=error#waitlist`);
    }
    return wantsJson(req) ? res.json({ ok: true }) : res.redirect(303, `${site}/?waitlist=ok#waitlist`);
  });

  return router;
}

const emailOf = (s) => s?.customer_details?.email || s?.customer_email || null;
const subscriptionMetadataOfInvoice = (inv) => inv?.parent?.subscription_details?.metadata || inv?.subscription_details?.metadata || null;

// Returns true when the event belonged to a non-FinalCut product (music, compose) and was handled here.
// Compose additionally records funnel events + subscription state and sends lifecycle emails (composeLifecycle.js).
export async function handleProductWebhookEvent(event, { stripe = defaultStripe, db, env = process.env, send = sendConversion, sendEmail = lifecycle.sendResendEmail } = {}) {
  const getDb = async () => db || (await import('../db.js'));
  const obj = event?.data?.object;
  switch (event?.type) {
    case 'checkout.session.completed': {
      const spec = PRODUCT_SPECS[productOf(obj)];
      if (!spec) return false;
      const email = emailOf(obj);
      const plan = obj.metadata?.plan || '';
      const { setProductEntitlement } = await getDb();
      if (email) {
        await setProductEntitlement({ email, product: spec.product, plan, source: 'stripe', ref: obj.subscription || obj.payment_intent || obj.id, customerId: obj.customer || null, active: true });
      }
      if (spec.product === COMPOSE_PRODUCT) await lifecycle.recordCheckoutCompleted(obj, await getDb());
      if (obj.metadata?.ads_opt_out === '1') return true;
      const isTrial = obj.mode === 'subscription' && (obj.amount_total || 0) === 0;
      const value = isTrial ? 0 : (obj.amount_total || 0) / 100 || (spec.plans(env)[plan]?.value ?? 0);
      await send({
        kind: isTrial ? 'start_trial' : 'purchase', adsPrefix: spec.adsPrefix,
        eventId: obj.metadata?.event_id || obj.id,
        value, currency: (obj.currency || 'usd').toUpperCase(), email,
        twclid: obj.metadata?.twclid, rdtCid: obj.metadata?.rdt_cid,
        at: new Date((obj.created || Math.floor(Date.now() / 1000)) * 1000),
        sourceUrl: obj.metadata?.landing,
      }, { env });
      return true;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const spec = PRODUCT_SPECS[productOf(obj)];
      if (!spec) return false;
      const active = event.type === 'customer.subscription.updated' && ['active', 'trialing', 'past_due'].includes(obj.status);
      const { setProductEntitlementByRef } = await getDb();
      await setProductEntitlementByRef({ product: spec.product, ref: obj.id, active });
      if (spec.product === COMPOSE_PRODUCT) await lifecycle.recordSubscriptionChange(event, await getDb());
      return true;
    }
    case 'invoice.paid': {
      const meta = subscriptionMetadataOfInvoice(obj);
      const spec = meta && PRODUCT_SPECS[meta.product];
      if (!spec) return false;
      if (spec.product === COMPOSE_PRODUCT) await lifecycle.recordInvoicePaid(obj, await getDb());
      // First paid invoice after the trial (and every renewal): server-only Purchase, no pixel to dedupe with.
      if ((obj.amount_paid || 0) > 0 && meta.ads_opt_out !== '1') {
        await send({
          kind: 'purchase', adsPrefix: spec.adsPrefix, eventId: `inv_${obj.id}`, value: obj.amount_paid / 100,
          currency: (obj.currency || 'usd').toUpperCase(), email: obj.customer_email,
          twclid: meta.twclid, rdtCid: meta.rdt_cid, at: new Date((obj.created || Math.floor(Date.now() / 1000)) * 1000),
        }, { env });
      }
      return true;
    }
    // Compose-only events. Anything else (music, FinalCut) returns false and falls through unchanged.
    case 'checkout.session.expired': {
      if (productOf(obj) !== COMPOSE_PRODUCT) return false;
      await lifecycle.onCheckoutExpired(obj, await getDb(), { env, sendEmail });
      return true;
    }
    case 'customer.subscription.trial_will_end': {
      if (productOf(obj) !== COMPOSE_PRODUCT) return false;
      await lifecycle.onTrialWillEnd(obj, await getDb(), { env, sendEmail, stripe });
      return true;
    }
    case 'charge.refunded':
      return lifecycle.recordRefund(obj, await getDb());
    default:
      return false;
  }
}

// Kept for callers/tests written against #118.
export const handleMusicWebhookEvent = handleProductWebhookEvent;
