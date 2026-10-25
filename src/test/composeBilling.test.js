// @vitest-environment node
// GBK Composer Pro on the shared product-entitlement path: compose purchases only grant product='compose',
// never the FinalCut flag or music; compose checkout URLs, email prefill, entitlement lookup auth, compose pixels.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import Stripe from 'stripe';

const db = vi.hoisted(() => ({
  updateUserSubscription: vi.fn(async () => {}),
  setProductEntitlement: vi.fn(async () => {}),
  setProductEntitlementByRef: vi.fn(async () => {}),
  hasProductEntitlement: vi.fn(async (email, product) => email === 'pro@example.com' && product === 'compose'),
  addMusicWaitlist: vi.fn(async () => {}),
}));
vi.mock('../db.js', () => db);

const WH = 'whsec_test_123';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = WH;

let stripeMod, compose, music, ads, products;
beforeAll(async () => {
  stripeMod = await import('../server/stripe.js');
  compose = await import('../server/composeBilling.js');
  music = await import('../server/musicBilling.js');
  ads = await import('../server/adsConversions.js');
  products = await import('../server/products.js');
});
beforeEach(() => { Object.values(db).forEach((f) => f.mockClear()); });

async function serve(...routers) {
  const app = express();
  for (const r of routers) app.use(r);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function postWebhook(base, event) {
  const payload = JSON.stringify(event);
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WH });
  return fetch(`${base}/api/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
}

describe('compose webhook', () => {
  let srv;
  beforeAll(async () => { srv = await serve(stripeMod.stripeWebhookRouter); });
  afterAll(async () => srv.close());

  it('compose checkout grants only product=compose, never the FinalCut flag', async () => {
    const r = await postWebhook(srv.base, { id: 'evt_c1', type: 'checkout.session.completed', data: { object: {
      id: 'cs_c', mode: 'subscription', amount_total: 0, subscription: 'sub_c', customer: 'cus_c',
      customer_details: { email: 'pro@example.com' }, metadata: { product: 'compose', plan: 'pro_monthly', event_id: 'gc-123456789' } } } });
    expect(r.status).toBe(200);
    expect(db.updateUserSubscription).not.toHaveBeenCalled();
    expect(db.setProductEntitlement).toHaveBeenCalledWith(expect.objectContaining({ email: 'pro@example.com', product: 'compose', plan: 'pro_monthly', ref: 'sub_c', active: true }));
  });

  it('cancelling compose deactivates only the compose ref', async () => {
    await postWebhook(srv.base, { id: 'evt_c2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_c', status: 'canceled', metadata: { product: 'compose' } } } });
    expect(db.setProductEntitlementByRef).toHaveBeenCalledWith({ product: 'compose', ref: 'sub_c', active: false });
    expect(db.updateUserSubscription).not.toHaveBeenCalled();
  });

  it('an unknown product is not swallowed by the product handler', async () => {
    expect(await music.handleProductWebhookEvent({ type: 'checkout.session.completed', data: { object: { metadata: { product: 'other' } } } }, { db, send: vi.fn() })).toBe(false);
    expect(await music.handleProductWebhookEvent({ type: 'checkout.session.completed', data: { object: { metadata: {} } } }, { db, send: vi.fn() })).toBe(false);
  });

  it('compose conversions carry the COMPOSE pixel prefix', async () => {
    const send = vi.fn(async () => ({}));
    await music.handleProductWebhookEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_l', mode: 'payment', amount_total: 9900, customer_details: { email: 'a@b.co' }, metadata: { product: 'compose', plan: 'lifetime', event_id: 'gc-life-0001' } } } }, { db, send, env: {} });
    expect(send.mock.calls[0][0]).toMatchObject({ kind: 'purchase', adsPrefix: 'COMPOSE', eventId: 'gc-life-0001', value: 99 });
  });
});

describe('compose checkout + entitlement', () => {
  const env = { COMPOSE_STRIPE_PRICE_PRO_MONTHLY: 'price_cm', COMPOSE_STRIPE_PRICE_PRO_YEARLY: 'price_cy', COMPOSE_STRIPE_PRICE_LIFETIME: 'price_cl', COMPOSE_ENTITLEMENT_TOKEN: 'tok_secret_123' };

  it('returns to compose.grepawk.com/pricing and prefills a valid email', async () => {
    const create = vi.fn(async () => ({ id: 'cs_x', url: 'https://checkout.stripe.com/c/pay/cs_x' }));
    const srv = await serve(compose.createComposeRouter({ stripe: { checkout: { sessions: { create } } }, env, db }));
    const r = await fetch(`${srv.base}/api/compose/checkout`, { method: 'POST', body: new URLSearchParams({ plan: 'pro_yearly', email: 'Me@Example.com', utm_source: 'x' }), redirect: 'manual' });
    expect(r.status).toBe(303);
    const p = create.mock.calls[0][0];
    expect(p).toMatchObject({ mode: 'subscription', line_items: [{ price: 'price_cy', quantity: 1 }], customer_email: 'me@example.com', subscription_data: { trial_period_days: 7, metadata: { product: 'compose', plan: 'pro_yearly', utm_source: 'x' } } });
    expect(p.success_url).toBe('https://compose.grepawk.com/pricing/thanks?plan=pro_yearly&session_id={CHECKOUT_SESSION_ID}');
    expect(p.cancel_url).toBe('https://compose.grepawk.com/pricing?checkout=cancel');
    await fetch(`${srv.base}/api/compose/checkout`, { method: 'POST', body: new URLSearchParams({ plan: 'lifetime', email: 'not-an-email' }), redirect: 'manual' });
    expect(create.mock.calls[1][0].customer_email).toBeUndefined();
    expect(create.mock.calls[1][0].mode).toBe('payment');
    expect((await fetch(`${srv.base}/api/compose/checkout`, { method: 'POST', body: new URLSearchParams({ plan: 'gold' }) })).status).toBe(400);
    await srv.close();
    const srv2 = await serve(compose.createComposeRouter({ stripe: { checkout: { sessions: { create } } }, env: {}, db }));
    expect((await fetch(`${srv2.base}/api/compose/checkout`, { method: 'POST', body: new URLSearchParams({ plan: 'pro_monthly' }) })).status).toBe(503);
    expect((await fetch(`${srv2.base}/api/compose/entitlement?email=pro@example.com`)).status).toBe(404);
    await srv2.close();
  });

  it('entitlement lookup needs the bearer token and answers per email', async () => {
    const srv = await serve(compose.createComposeRouter({ stripe: null, env, db }));
    const get = (email, auth) => fetch(`${srv.base}/api/compose/entitlement?email=${encodeURIComponent(email)}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    expect((await get('pro@example.com')).status).toBe(401);
    expect((await get('pro@example.com', 'wrong')).status).toBe(401);
    expect(await (await get('Pro@Example.com', 'tok_secret_123')).json()).toEqual({ product: 'compose', pro: true });
    expect(await (await get('free@example.com', 'tok_secret_123')).json()).toEqual({ product: 'compose', pro: false });
    expect((await get('bad', 'tok_secret_123')).status).toBe(400);
    await srv.close();
  });

  it('compose ads read COMPOSE_* pixels, music still reads MUSIC_*', () => {
    const creds = { X_ADS_CONSUMER_KEY: 'ck', X_ADS_CONSUMER_SECRET: 'cs', X_ADS_ACCESS_TOKEN: 'at', X_ADS_ACCESS_TOKEN_SECRET: 'as', REDDIT_CAPI_TOKEN: 'rt' };
    const e = { ...creds, MUSIC_X_PIXEL_ID: 'mX', MUSIC_X_EVENT_ID_PURCHASE: 'mbuy', MUSIC_REDDIT_PIXEL_ID: 'mR', COMPOSE_X_PIXEL_ID: 'cX', COMPOSE_X_EVENT_ID_PURCHASE: 'cbuy', COMPOSE_REDDIT_PIXEL_ID: 'cR' };
    const conv = { kind: 'purchase', eventId: 'gc-123456789', value: 6, email: 'a@b.co', at: new Date('2026-10-25T18:00:00Z') };
    expect(ads.buildXRequest({ ...conv, adsPrefix: 'COMPOSE' }, e).url).toContain('/conversions/cX');
    expect(ads.buildXRequest({ ...conv, adsPrefix: 'COMPOSE' }, e).body.conversions[0].event_id).toBe('cbuy');
    expect(ads.buildRedditRequest({ ...conv, adsPrefix: 'COMPOSE' }, e).url).toContain('/pixels/cR/');
    expect(ads.buildXRequest(conv, e).url).toContain('/conversions/mX');
    expect(ads.buildXRequest({ ...conv, adsPrefix: 'COMPOSE' }, creds)).toBeNull();
  });

  it('compose site URL refuses foreign hosts', () => {
    expect(() => products.composeSiteUrl({ COMPOSE_SITE_URL: 'https://evil.example' })).toThrow();
  });
});
