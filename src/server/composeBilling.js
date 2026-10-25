// GBK Composer Pro (compose.grepawk.com) web checkout + entitlement lookup on grepawk.com.
//   POST /api/compose/checkout   plan=pro_monthly|pro_yearly|lifetime [+ email, event_id, utm_*, twclid, rdt_cid, landing]
//        HTML form post from compose.grepawk.com/pricing; 303 to Stripe Checkout. `email` (the signed-in
//        GBK account email, if any) prefills Checkout so the entitlement lands on the same address.
//   GET  /api/compose/entitlement?email=…   Authorization: Bearer $COMPOSE_ENTITLEMENT_TOKEN
//        Server-to-server only (the GBK server asks whether an account email has Pro). 404 when the
//        token is unset, so the endpoint does not exist until configured.
// Webhook handling is shared with music (musicBilling.handleProductWebhookEvent, product='compose').
import express from 'express';
import { timingSafeEqual } from 'crypto';
import { stripe as defaultStripe } from './config.js';
import { apiLimiter } from './middleware.js';
import { COMPOSE_PRODUCT, PRODUCT_SPECS, resolveComposePlan } from './products.js';
import { attributionFrom, buildCheckoutParams } from './musicBilling.js';

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
        buildCheckoutParams(spec, plan, attributionFrom(req.body), env, { customerEmail: EMAIL_RE.test(email) ? email : undefined }));
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
      const { hasProductEntitlement } = await getDb();
      res.set('cache-control', 'no-store');
      return res.json({ product: COMPOSE_PRODUCT, pro: await hasProductEntitlement(email, COMPOSE_PRODUCT) });
    } catch (error) {
      console.error('[compose] entitlement error:', error.message);
      return res.status(500).json({ error: 'Failed' });
    }
  });

  return router;
}
