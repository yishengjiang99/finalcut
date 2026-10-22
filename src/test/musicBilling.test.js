// @vitest-environment node
// Product-scoped Stripe entitlements: music purchases never touch the FinalCut has_subscription flag,
// FinalCut purchases behave exactly as before; music checkout modes; ad conversions + off switch.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import Stripe from 'stripe';

const db = vi.hoisted(() => ({
  updateUserSubscription: vi.fn(async () => {}),
  setProductEntitlement: vi.fn(async () => {}),
  setProductEntitlementByRef: vi.fn(async () => {}),
  addMusicWaitlist: vi.fn(async () => {}),
}));
vi.mock('../db.js', () => db);

const WH = 'whsec_test_123';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = WH;

let stripeMod, music, ads, products;
beforeAll(async () => {
  stripeMod = await import('../server/stripe.js');
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

describe('Stripe webhook: product-scoped entitlements', () => {
  let srv;
  beforeAll(async () => { srv = await serve(stripeMod.stripeWebhookRouter); });
  afterAll(async () => srv.close());

  it('FinalCut checkout (no metadata.product) still sets the global subscription, unchanged', async () => {
    const r = await postWebhook(srv.base, { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_fc', customer_email: 'fc@example.com', subscription: 'sub_fc', metadata: {} } } });
    expect(r.status).toBe(200);
    expect(db.updateUserSubscription).toHaveBeenCalledWith('fc@example.com', true, 'sub_fc');
    expect(db.setProductEntitlement).not.toHaveBeenCalled();
  });

  it('music checkout grants only the music entitlement and never the FinalCut flag', async () => {
    const r = await postWebhook(srv.base, { id: 'evt_2', type: 'checkout.session.completed', data: { object: {
      id: 'cs_m', mode: 'payment', amount_total: 4999, currency: 'usd', payment_intent: 'pi_1', customer: 'cus_1',
      customer_email: 'fc@example.com', customer_details: { email: 'Buyer@Example.com' }, metadata: { product: 'music', plan: 'lifetime', event_id: 'evt-abc-12345' } } } });
    expect(r.status).toBe(200);
    expect(db.updateUserSubscription).not.toHaveBeenCalled();
    expect(db.setProductEntitlement).toHaveBeenCalledWith(expect.objectContaining({ email: 'Buyer@Example.com', product: 'music', plan: 'lifetime', ref: 'pi_1', active: true }));
  });

  it('cancelling a music subscription does not cancel FinalCut for the same email', async () => {
    const r = await postWebhook(srv.base, { id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_m', customer: 'cus_1', status: 'canceled', metadata: { product: 'music' } } } });
    expect(r.status).toBe(200);
    expect(db.updateUserSubscription).not.toHaveBeenCalled();
    expect(db.setProductEntitlementByRef).toHaveBeenCalledWith({ product: 'music', ref: 'sub_m', active: false });
  });

  it('rejects a bad signature', async () => {
    const r = await fetch(`${srv.base}/api/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
    expect(r.status).toBe(400);
  });
});

describe('music checkout', () => {
  const env = { MUSIC_STRIPE_PRICE_PRO_MONTHLY: 'price_m', MUSIC_STRIPE_PRICE_PRO_YEARLY: 'price_y', MUSIC_STRIPE_PRICE_LIFETIME: 'price_l' };
  it('Pro is a subscription with a 7-day trial; Lifetime is a one-time payment; URLs go back to music.grepawk.com', () => {
    const pro = music.buildMusicCheckoutParams(products.resolveMusicPlan('pro_yearly', env), { event_id: 'abcdefgh1' }, env);
    expect(pro).toMatchObject({ mode: 'subscription', line_items: [{ price: 'price_y', quantity: 1 }], subscription_data: { trial_period_days: 7, metadata: { product: 'music', plan: 'pro_yearly' } } });
    expect(pro.success_url).toBe('https://music.grepawk.com/thanks?plan=pro_yearly&session_id={CHECKOUT_SESSION_ID}');
    expect(pro.cancel_url).toBe('https://music.grepawk.com/?checkout=cancel#pricing');
    const life = music.buildMusicCheckoutParams(products.resolveMusicPlan('lifetime', env), {}, env);
    expect(life.mode).toBe('payment');
    expect(life.subscription_data).toBeUndefined();
    expect(life.metadata).toMatchObject({ product: 'music', plan: 'lifetime' });
  });

  it('form post 303s to Stripe and carries UTM + click ids in metadata; unknown/unconfigured plans fail', async () => {
    const create = vi.fn(async () => ({ id: 'cs_x', url: 'https://checkout.stripe.com/c/pay/cs_x' }));
    const srv = await serve(music.createMusicRouter({ stripe: { checkout: { sessions: { create } } }, env, db }));
    const body = new URLSearchParams({ plan: 'lifetime', event_id: 'mr-123456789', utm_source: 'reddit', utm_campaign: 'launch', twclid: 'tw1', rdt_cid: 'rd1', evil: 'x' });
    const r = await fetch(`${srv.base}/api/music/checkout`, { method: 'POST', body, redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_x');
    expect(create.mock.calls[0][0].metadata).toEqual({ product: 'music', plan: 'lifetime', event_id: 'mr-123456789', utm_source: 'reddit', utm_campaign: 'launch', twclid: 'tw1', rdt_cid: 'rd1' });
    expect((await fetch(`${srv.base}/api/music/checkout`, { method: 'POST', body: new URLSearchParams({ plan: 'gold' }) })).status).toBe(400);
    const srv2 = await serve(music.createMusicRouter({ stripe: { checkout: { sessions: { create } } }, env: {}, db }));
    expect((await fetch(`${srv2.base}/api/music/checkout`, { method: 'POST', body: new URLSearchParams({ plan: 'pro_monthly' }) })).status).toBe(503);
    await srv.close(); await srv2.close();
  });

  it('waitlist stores the email and redirects back', async () => {
    const srv = await serve(music.createMusicRouter({ stripe: null, env, db }));
    const r = await fetch(`${srv.base}/api/music/waitlist`, { method: 'POST', body: new URLSearchParams({ email: 'Fan@Example.com', utm_source: 'x' }), redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('https://music.grepawk.com/?waitlist=ok#waitlist');
    expect(db.addMusicWaitlist).toHaveBeenCalledWith('fan@example.com', { utm_source: 'x' });
    const bad = await fetch(`${srv.base}/api/music/waitlist`, { method: 'POST', body: new URLSearchParams({ email: 'nope' }), redirect: 'manual' });
    expect(bad.headers.get('location')).toContain('waitlist=invalid');
    await srv.close();
  });
});

describe('ad conversions', () => {
  const full = {
    MUSIC_X_PIXEL_ID: 'pxX', MUSIC_X_EVENT_ID_PURCHASE: 'tw-pxX-buy', MUSIC_X_EVENT_ID_START_TRIAL: 'tw-pxX-trial',
    X_ADS_CONSUMER_KEY: 'ck', X_ADS_CONSUMER_SECRET: 'cs', X_ADS_ACCESS_TOKEN: 'at', X_ADS_ACCESS_TOKEN_SECRET: 'as',
    MUSIC_REDDIT_PIXEL_ID: 'pxR', REDDIT_CAPI_TOKEN: 'rt',
  };
  const conv = { kind: 'purchase', eventId: 'mr-123456789', value: 49.99, currency: 'USD', email: ' Buyer@Example.com ', twclid: 'tw1', rdtCid: 'rd1', at: new Date('2026-10-22T20:00:00Z') };

  it('builds X and Reddit payloads with the shared dedupe id and hashed email', () => {
    const x = ads.buildXRequest(conv, full);
    expect(x.url).toBe('https://ads-api.x.com/12/measurement/conversions/pxX');
    expect(x.body.conversions[0]).toMatchObject({ event_id: 'tw-pxX-buy', conversion_id: 'mr-123456789', value: 49.99, price_currency: 'USD', identifiers: [{ twclid: 'tw1' }, { hashed_email: ads.sha256Email('buyer@example.com') }] });
    const r = ads.buildRedditRequest(conv, full);
    expect(r.url).toBe('https://ads-api.reddit.com/api/v3/pixels/pxR/conversion_events');
    expect(r.body.data.events[0]).toMatchObject({ event_at: conv.at.getTime(), action_source: 'WEBSITE', click_id: 'rd1', type: { tracking_type: 'PURCHASE' }, metadata: { conversion_id: 'mr-123456789', value: 49.99 } });
    expect(ads.buildRedditRequest({ ...conv, kind: 'start_trial' }, full).body.data.events[0].type).toEqual({ tracking_type: 'CUSTOM', custom_event_name: 'StartTrial' });
  });

  it('OAuth 1.0a signature matches the RFC 5849 / X reference example', () => {
    // Example from https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature
    const h = ads.oauth1Header('POST', 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21', {
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    }, { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958 });
    expect(h).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });

  it('sends both, and ADS_TRACKING_ENABLED=0 or missing credentials send nothing', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    expect(await ads.sendConversion(conv, { env: full, fetchImpl })).toEqual({ x: 200, reddit: 200 });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toMatch(/^OAuth /);
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer rt');
    fetchImpl.mockClear();
    expect(await ads.sendConversion(conv, { env: { ...full, ADS_TRACKING_ENABLED: '0' }, fetchImpl })).toEqual({ skipped: true });
    expect(await ads.sendConversion(conv, { env: {}, fetchImpl })).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('webhook sends start_trial for a Pro trial checkout with the landing event id', async () => {
    const send = vi.fn(async () => ({}));
    await music.handleMusicWebhookEvent({ type: 'checkout.session.completed', data: { object: { id: 'cs_t', mode: 'subscription', amount_total: 0, subscription: 'sub_t', customer_details: { email: 'a@b.co' }, metadata: { product: 'music', plan: 'pro_yearly', event_id: 'mr-trial-0001', twclid: 'tw9' } } } }, { db, send, env: {} });
    expect(send.mock.calls[0][0]).toMatchObject({ kind: 'start_trial', eventId: 'mr-trial-0001', value: 0, twclid: 'tw9' });
    expect(db.setProductEntitlement).toHaveBeenCalledWith(expect.objectContaining({ ref: 'sub_t', plan: 'pro_yearly' }));
  });
});
