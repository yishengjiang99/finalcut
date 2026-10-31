// @vitest-environment node
// #121 richer entitlement + portal, #122 recovery/trial emails (off by default) + funnel events.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';

const db = vi.hoisted(() => {
  const events = new Map();
  return {
    _events: events,
    updateUserSubscription: vi.fn(async () => {}),
    setProductEntitlement: vi.fn(async () => {}),
    setProductEntitlementByRef: vi.fn(async () => {}),
    hasProductEntitlement: vi.fn(async (email) => email === 'pro@example.com'),
    addMusicWaitlist: vi.fn(async () => {}),
    setProductSubscriptionState: vi.fn(async () => {}),
    getProductEntitlement: vi.fn(async (email) => (email === 'pro@example.com'
      ? { plan: 'pro_yearly', ref: 'sub_1', stripe_customer_id: 'cus_1', active: 1, status: 'trialing', current_period_end: 1793000000, cancel_at_period_end: 0 }
      : null)),
    recordProductEvent: vi.fn(async (e) => { const k = `${e.type}|${e.ref}`; if (events.has(k)) return false; events.set(k, e); return true; }),
    hasProductEvent: vi.fn(async ({ subscriptionRef, types }) => [...events.values()].some((e) => e.subscriptionRef === subscriptionRef && types.includes(e.type))),
    findProductEntitlementByRef: vi.fn(async (p, ref) => (ref === 'sub_1' ? { email: 'pro@example.com', plan: 'pro_yearly', ref: 'sub_1' } : null)),
    findProductEntitlementByCustomer: vi.fn(async (p, cus) => (cus === 'cus_1' ? { email: 'pro@example.com', plan: 'pro_yearly', ref: 'sub_1' } : null)),
    listProductEvents: vi.fn(async () => [
      { type: 'trial_start', email: 'a@b.co', plan: 'pro_monthly', amount_cents: 0, currency: 'usd', subscription_ref: 'sub_a', occurred_at: new Date('2026-10-20T00:00:00Z') },
      { type: 'trial_convert', email: 'a@b.co', plan: 'pro_monthly', amount_cents: 599, currency: 'usd', subscription_ref: 'sub_a', occurred_at: new Date('2026-10-27T00:00:00Z') },
    ]),
  };
});
vi.mock('../db.js', () => db);

const TOKEN = 'tok_secret_123';
const ENV = { COMPOSE_ENTITLEMENT_TOKEN: TOKEN, COMPOSE_STRIPE_PRICE_PRO_MONTHLY: 'price_cm' };
const ON = { ...ENV, COMPOSE_LIFECYCLE_EMAILS: '1', RESEND_API_KEY: 're_x', COMPOSE_EMAIL_FROM: 'GBK <hi@grepawk.com>' };

let compose, music, life;
beforeAll(async () => {
  compose = await import('../server/composeBilling.js');
  music = await import('../server/musicBilling.js');
  life = await import('../server/composeLifecycle.js');
});
beforeEach(() => { db._events.clear(); Object.values(db).forEach((f) => f.mockClear?.()); });

async function serve(router) {
  const app = express(); app.use(router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const auth = { authorization: `Bearer ${TOKEN}` };
const handle = (event, opts = {}) => music.handleProductWebhookEvent(event, { db, send: vi.fn(async () => ({})), env: ENV, ...opts });

describe('#121 entitlement + portal', () => {
  it('entitlement includes plan/status/period end/cancel flag', async () => {
    const srv = await serve(compose.createComposeRouter({ stripe: null, env: ENV, db }));
    const j = await (await fetch(`${srv.base}/api/compose/entitlement?email=pro@example.com`, { headers: auth })).json();
    expect(j).toEqual({ product: 'compose', pro: true, plan: 'pro_yearly', status: 'trialing', current_period_end: new Date(1793000000 * 1000).toISOString(), cancel_at_period_end: false });
    await srv.close();
  });

  it('POST portal needs the bearer and returns a portal URL back to /studio', async () => {
    const create = vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/x' }));
    const srv = await serve(compose.createComposeRouter({ stripe: { billingPortal: { sessions: { create } } }, env: ENV, db }));
    const post = (body, headers = {}) => fetch(`${srv.base}/api/compose/portal`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await post({ email: 'pro@example.com' })).status).toBe(401);
    expect((await post({ email: 'bad' }, auth)).status).toBe(400);
    expect((await post({ email: 'free@example.com' }, auth)).status).toBe(404);
    const r = await post({ email: 'Pro@Example.com' }, auth);
    expect(await r.json()).toEqual({ url: 'https://billing.stripe.com/p/session/x' });
    expect(create).toHaveBeenCalledWith({ customer: 'cus_1', return_url: 'https://compose.grepawk.com/studio' });
    await srv.close();
    const off = await serve(compose.createComposeRouter({ stripe: { billingPortal: { sessions: { create } } }, env: {}, db }));
    expect((await fetch(`${off.base}/api/compose/portal`, { method: 'POST', headers: auth })).status).toBe(404);
    await off.close();
  });

  it('signed portal link redirects; tampered or expired links do not', async () => {
    const create = vi.fn(async () => ({ url: 'https://billing.stripe.com/p/session/y' }));
    const srv = await serve(compose.createComposeRouter({ stripe: { billingPortal: { sessions: { create } } }, env: ENV, db }));
    const link = new URL(life.signPortalLink('pro@example.com', ENV));
    const go = (qs) => fetch(`${srv.base}/api/compose/portal?${qs}`, { redirect: 'manual' });
    let r = await go(link.searchParams);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('https://billing.stripe.com/p/session/y');
    const bad = new URLSearchParams(link.searchParams); bad.set('email', 'other@example.com');
    r = await go(bad);
    expect(r.headers.get('location')).toBe('https://compose.grepawk.com/studio?portal=expired');
    expect(life.verifyPortalLink(Object.fromEntries(link.searchParams), ENV, Date.now() + 15 * 864e5)).toBe(false);
    await srv.close();
  });
});

describe('#122 checkout + webhooks', () => {
  it('compose checkout enables recovery + promo consent; music checkout does not', async () => {
    const create = vi.fn(async () => ({ id: 'cs', url: 'https://checkout.stripe.com/c' }));
    const srv = await serve(compose.createComposeRouter({ stripe: { checkout: { sessions: { create } } }, env: ENV, db }));
    await fetch(`${srv.base}/api/compose/checkout`, { method: 'POST', body: new URLSearchParams({ plan: 'pro_monthly' }), redirect: 'manual' });
    expect(create.mock.calls[0][0]).toMatchObject({ after_expiration: { recovery: { enabled: true, allow_promotion_codes: true } }, consent_collection: { promotions: 'auto' } });
    await srv.close();
    const m = music.buildMusicCheckoutParams({ plan: 'pro_monthly', priceId: 'p', mode: 'subscription', trialDays: 7 }, {}, {});
    expect(m.after_expiration).toBeUndefined();
    expect(m.consent_collection).toBeUndefined();
  });

  const expired = (consent) => ({ type: 'checkout.session.expired', data: { object: { id: `cs_${consent}`, customer_details: { email: 'a@b.co' }, consent: { promotions: consent }, after_expiration: { recovery: { url: 'https://buy.stripe.com/r/abc' } }, metadata: { product: 'compose' } } } });

  it('recovery email: off by default, needs consent, sent once', async () => {
    const sendEmail = vi.fn(async () => {});
    expect(await handle(expired('opt_in'), { sendEmail })).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled(); // switch off
    await handle(expired('opt_out'), { sendEmail, env: ON });
    expect(sendEmail).not.toHaveBeenCalled(); // no consent
    await handle(expired('opt_in'), { sendEmail, env: ON });
    await handle(expired('opt_in'), { sendEmail, env: ON }); // webhook retry
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: 'a@b.co', subject: 'Your GBK Composer Pro checkout is saved' });
    expect(sendEmail.mock.calls[0][0].text).toContain('https://buy.stripe.com/r/abc');
  });

  it('music/FinalCut expired sessions are not handled here', async () => {
    expect(await handle({ type: 'checkout.session.expired', data: { object: { id: 'cs_m', metadata: { product: 'music' } } } })).toBe(false);
    expect(await handle({ type: 'checkout.session.expired', data: { object: { id: 'cs_f', metadata: {} } } })).toBe(false);
  });

  it('trial ending email carries a signed portal cancel link', async () => {
    const sendEmail = vi.fn(async () => {});
    const ev = { type: 'customer.subscription.trial_will_end', data: { object: { id: 'sub_1', customer: 'cus_1', trial_end: 1793000000, metadata: { product: 'compose', plan: 'pro_yearly' } } } };
    await handle(ev, { sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    await handle(ev, { sendEmail, env: ON });
    await handle(ev, { sendEmail, env: ON });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0][0];
    expect(msg.to).toBe('pro@example.com');
    expect(msg.text).toContain('yearly ($47.99/year)');
    const link = msg.text.split('\n').find((l) => l.startsWith('https://grepawk.com/api/compose/portal?'));
    expect(life.verifyPortalLink(Object.fromEntries(new URL(link).searchParams), ON)).toBe(true);
  });

  it('records trial_start → trial_convert → renewal → cancel → refund', async () => {
    await handle({ type: 'checkout.session.completed', data: { object: { id: 'cs_t', mode: 'subscription', amount_total: 0, subscription: 'sub_1', customer: 'cus_1', customer_details: { email: 'pro@example.com' }, metadata: { product: 'compose', plan: 'pro_yearly' } } } });
    expect(db.setProductSubscriptionState).toHaveBeenCalledWith({ product: 'compose', ref: 'sub_1', status: 'trialing', currentPeriodEnd: null, cancelAtPeriodEnd: false });
    const inv = (id) => ({ type: 'invoice.paid', data: { object: { id, amount_paid: 4799, currency: 'usd', parent: { subscription_details: { subscription: 'sub_1', metadata: { product: 'compose', plan: 'pro_yearly' } } } } } });
    await handle(inv('in_1'));
    await handle(inv('in_2'));
    await handle({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: 1800000000 }] }, metadata: { product: 'compose' } } } });
    expect(db.setProductSubscriptionState).toHaveBeenLastCalledWith({ product: 'compose', ref: 'sub_1', status: 'active', currentPeriodEnd: 1800000000, cancelAtPeriodEnd: true });
    await handle({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', metadata: { product: 'compose' } } } });
    expect(await handle({ type: 'charge.refunded', data: { object: { id: 'ch_1', customer: 'cus_1', amount_refunded: 4799, currency: 'usd' } } })).toBe(true);
    expect(await handle({ type: 'charge.refunded', data: { object: { id: 'ch_fc', customer: 'cus_finalcut' } } })).toBe(false);
    expect([...db._events.values()].map((e) => e.type)).toEqual(['trial_start', 'trial_convert', 'renewal', 'cancel', 'refund']);
    expect(db.updateUserSubscription).not.toHaveBeenCalled();
  });

  it('music events record nothing new', async () => {
    await handle({ type: 'checkout.session.completed', data: { object: { id: 'cs_m', mode: 'subscription', amount_total: 0, subscription: 'sub_m', customer_details: { email: 'a@b.co' }, metadata: { product: 'music', plan: 'pro_monthly' } } } });
    await handle({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_m', metadata: { product: 'music' } } } });
    expect(db.recordProductEvent).not.toHaveBeenCalled();
    expect(db.setProductSubscriptionState).not.toHaveBeenCalled();
  });

  it('events endpoint returns counts for the GBK funnel report', async () => {
    const srv = await serve(compose.createComposeRouter({ stripe: null, env: ENV, db }));
    expect((await fetch(`${srv.base}/api/compose/events`)).status).toBe(401);
    expect((await fetch(`${srv.base}/api/compose/events?since=nope`, { headers: auth })).status).toBe(400);
    const j = await (await fetch(`${srv.base}/api/compose/events?since=2026-10-01T00:00:00Z&until=2026-11-01T00:00:00Z`, { headers: auth })).json();
    expect(j.counts).toMatchObject({ trial_start: 1, trial_convert: 1, cancel: 0, refund: 0 });
    expect(j.events[1]).toMatchObject({ type: 'trial_convert', amount_cents: 599, at: '2026-10-27T00:00:00.000Z' });
    await srv.close();
  });
});

describe('compose current_period_end (Stripe 2025-12-15.clover)', () => {
  const completed = (subscription) => ({ type: 'checkout.session.completed', data: { object: { id: 'cs_y', mode: 'subscription', amount_total: 0, subscription, customer: 'cus_1', customer_details: { email: 'pro@example.com' }, metadata: { product: 'compose', plan: 'pro_yearly' } } } });
  const cloverSub = { id: 'sub_y', status: 'trialing', trial_end: 1793000000, cancel_at_period_end: false, items: { data: [{ current_period_end: 1793000000 }] }, metadata: { product: 'compose' } };

  it('periodEndOf: item-level, then legacy top-level, then trial_end', () => {
    expect(life.periodEndOf({ items: { data: [{ current_period_end: 5 }, { current_period_end: 9 }] }, current_period_end: 1 })).toBe(9);
    expect(life.periodEndOf({ current_period_end: 7, items: { data: [] } })).toBe(7);
    expect(life.periodEndOf({ trial_end: 3, items: { data: [{}] } })).toBe(3);
    expect(life.periodEndOf(null)).toBeNull();
  });

  it('checkout.session.completed retrieves an unexpanded subscription and stores its period end', async () => {
    const retrieve = vi.fn(async () => cloverSub);
    await handle(completed('sub_y'), { stripe: { subscriptions: { retrieve } } });
    expect(retrieve).toHaveBeenCalledWith('sub_y');
    expect(db.setProductSubscriptionState).toHaveBeenCalledWith({ product: 'compose', ref: 'sub_y', status: 'trialing', currentPeriodEnd: 1793000000, cancelAtPeriodEnd: false });
  });

  it('checkout.session.completed uses an expanded subscription without a retrieve', async () => {
    const retrieve = vi.fn();
    await handle(completed(cloverSub), { stripe: { subscriptions: { retrieve } } });
    expect(retrieve).not.toHaveBeenCalled();
    expect(db.setProductSubscriptionState).toHaveBeenCalledWith({ product: 'compose', ref: 'sub_y', status: 'trialing', currentPeriodEnd: 1793000000, cancelAtPeriodEnd: false });
    expect(db.setProductEntitlement).toHaveBeenCalledWith(expect.objectContaining({ ref: 'sub_y' }));
  });

  it('retrieve failure still records trialing (falls back gracefully)', async () => {
    const retrieve = vi.fn(async () => { throw new Error('boom'); });
    await handle(completed('sub_y'), { stripe: { subscriptions: { retrieve } } });
    expect(db.setProductSubscriptionState).toHaveBeenCalledWith({ product: 'compose', ref: 'sub_y', status: 'trialing', currentPeriodEnd: null, cancelAtPeriodEnd: false });
  });

  it('customer.subscription.created/updated set period end from items, trial_end fallback', async () => {
    expect(await handle({ type: 'customer.subscription.created', data: { object: cloverSub } })).toBe(true);
    expect(db.setProductSubscriptionState).toHaveBeenLastCalledWith({ product: 'compose', ref: 'sub_y', status: 'trialing', currentPeriodEnd: 1793000000, cancelAtPeriodEnd: false });
    await handle({ type: 'customer.subscription.updated', data: { object: { ...cloverSub, items: { data: [{}] }, trial_end: 1794000000 } } });
    expect(db.setProductSubscriptionState).toHaveBeenLastCalledWith({ product: 'compose', ref: 'sub_y', status: 'trialing', currentPeriodEnd: 1794000000, cancelAtPeriodEnd: false });
  });

  it('music/FinalCut subscription.created is not handled here', async () => {
    expect(await handle({ type: 'customer.subscription.created', data: { object: { id: 'sub_m', metadata: { product: 'music' } } } })).toBe(false);
    expect(await handle({ type: 'customer.subscription.created', data: { object: { id: 'sub_f', metadata: {} } } })).toBe(false);
    expect(db.setProductSubscriptionState).not.toHaveBeenCalled();
  });
});

describe('compose welcome email', () => {
  const sub = { id: 'sub_w', status: 'trialing', trial_end: 1793000000, items: { data: [{ current_period_end: 1793000000 }] } };
  const stripe = { subscriptions: { retrieve: vi.fn(async () => sub) } };
  const trial = { type: 'checkout.session.completed', data: { object: { id: 'cs_w', mode: 'subscription', amount_total: 0, subscription: 'sub_w', customer: 'cus_1', customer_details: { email: 'pro@example.com' }, metadata: { product: 'compose', plan: 'pro_yearly' } } } };

  it('off by default; when on, sent once per session with plan, trial end, Pro perks, studio + signed portal link', async () => {
    const sendEmail = vi.fn(async () => {});
    await handle(trial, { sendEmail, stripe });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db._events.has('email_welcome|cs_w')).toBe(false);
    await handle(trial, { sendEmail, stripe, env: ON });
    await handle(trial, { sendEmail, stripe, env: ON }); // webhook retry
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0][0];
    expect(msg.to).toBe('pro@example.com');
    expect(msg.subject).toBe('Welcome to GBK Composer Pro: your free trial has started');
    expect(msg.text).toContain('yearly ($47.99/year)');
    expect(msg.text).toContain('until October 26, 2026');
    expect(msg.text).toContain('10x the Studio AI budget');
    expect(msg.text).toContain('120 renders per hour');
    expect(msg.text).toContain('https://compose.grepawk.com/studio');
    const link = msg.text.split('\n').find((l) => l.startsWith('https://grepawk.com/api/compose/portal?'));
    expect(life.verifyPortalLink(Object.fromEntries(new URL(link).searchParams), ON)).toBe(true);
    expect(db._events.get('email_welcome|cs_w')).toMatchObject({ product: 'compose', type: 'email_welcome', email: 'pro@example.com' });
  });

  it('lifetime purchase: no trial line', async () => {
    const sendEmail = vi.fn(async () => {});
    await handle({ type: 'checkout.session.completed', data: { object: { id: 'cs_l', mode: 'payment', amount_total: 9900, payment_intent: 'pi_1', customer_details: { email: 'pro@example.com' }, metadata: { product: 'compose', plan: 'lifetime' } } } }, { sendEmail, env: ON });
    const msg = sendEmail.mock.calls[0][0];
    expect(msg.subject).toBe('Welcome to GBK Composer Pro');
    expect(msg.text).toContain('Your plan: lifetime.');
    expect(msg.text).not.toContain('free trial');
  });

  it('music checkout sends no welcome email', async () => {
    const sendEmail = vi.fn(async () => {});
    await handle({ type: 'checkout.session.completed', data: { object: { id: 'cs_m', mode: 'subscription', amount_total: 0, subscription: 'sub_m', customer_details: { email: 'a@b.co' }, metadata: { product: 'music', plan: 'pro_monthly' } } } }, { sendEmail, env: ON });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
