// @vitest-environment node
// gbk billing hop: compose money events from the Stripe webhook are forwarded to
// compose.grepawk.com/api/billing/stripe-events (fire and forget, one retry, token never logged).
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => {
  const events = new Map();
  return {
    _events: events,
    setProductEntitlement: vi.fn(async () => {}),
    setProductEntitlementByRef: vi.fn(async () => {}),
    setProductSubscriptionState: vi.fn(async () => {}),
    recordProductEvent: vi.fn(async (e) => { const k = `${e.type}|${e.ref}`; if (events.has(k)) return false; events.set(k, e); return true; }),
    hasProductEvent: vi.fn(async ({ subscriptionRef, types }) => [...events.values()].some((e) => e.subscriptionRef === subscriptionRef && types.includes(e.type))),
    findProductEntitlementByCustomer: vi.fn(async (p, cus) => (cus === 'cus_1' ? { email: 'pro@example.com', plan: 'pro_yearly', ref: 'sub_1' } : null)),
  };
});
vi.mock('../db.js', () => db);

const TOKEN = 'hop_token_abcdef0123456789';
const ENV = { COMPOSE_BILLING_WEBHOOK_TOKEN: TOKEN };
let hop, music;
beforeAll(async () => {
  hop = await import('../server/gbkBillingHop.js');
  music = await import('../server/musicBilling.js');
});
let errSpy, logSpy;
beforeEach(() => {
  db._events.clear(); Object.values(db).forEach((f) => f.mockClear?.());
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const logged = () => JSON.stringify([...errSpy.mock.calls, ...logSpy.mock.calls]);
const ok = (status = 200) => ({ ok: status < 300, status, json: async () => ({}) });
const evt = { product: 'compose', type: 'purchase', ref: 'cs_1', email: 'a@b.co', plan: 'pro_yearly', amountCents: 4799 };

describe('gbkHopPayload', () => {
  it('maps money events and drops everything else', () => {
    expect(hop.gbkHopPayload(evt)).toEqual({ event: 'purchase', plan: 'pro_yearly', value_cents: 4799, surface: 'pricing', platform: 'web', detail: 'cs_1', ads_opt_out: '1' });
    expect(hop.gbkHopPayload({ type: 'trial_start', ref: 'cs_2', plan: 'pro_monthly', amountCents: 0 })).toEqual({ event: 'trial_start', plan: 'pro_monthly', surface: 'pricing', platform: 'web', detail: 'cs_2', ads_opt_out: '1' });
    expect(hop.gbkHopPayload({ type: 'cancel', ref: 'sub_1', plan: 'weird' })).not.toHaveProperty('plan');
    for (const type of ['email_welcome', 'email_recovery', 'email_unsubscribe', 'checkout_start']) expect(hop.gbkHopPayload({ type, ref: 'x' })).toBeNull();
  });
  it('never carries email or account (no PII to gbk; this service sends the ad conversions)', () => {
    const p = hop.gbkHopPayload(evt);
    expect(p).not.toHaveProperty('email'); expect(p).not.toHaveProperty('account'); expect(p.ads_opt_out).toBe('1');
  });
});

describe('forwardBillingEvent', () => {
  it('skips when the token is unset', async () => {
    const fetchImpl = vi.fn();
    expect(await hop.forwardBillingEvent(evt, { env: {}, fetchImpl })).toEqual({ skipped: true });
    expect(await hop.forwardBillingEvent(evt, { env: { COMPOSE_BILLING_WEBHOOK_TOKEN: '  ' }, fetchImpl })).toEqual({ skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('POSTs to compose.grepawk.com with the token header', async () => {
    const fetchImpl = vi.fn(async () => ok());
    expect(await hop.forwardBillingEvent(evt, { env: ENV, fetchImpl })).toEqual({ ok: true, status: 200, attempts: 1 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://compose.grepawk.com/api/billing/stripe-events');
    expect(init.method).toBe('POST');
    expect(init.headers['x-gbk-billing-token']).toBe(TOKEN);
    expect(JSON.parse(init.body).event).toBe('purchase');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('retries once on 5xx or a network error, not on 401', async () => {
    let f = vi.fn().mockResolvedValueOnce(ok(502)).mockResolvedValueOnce(ok(200));
    expect(await hop.forwardBillingEvent(evt, { env: ENV, fetchImpl: f, retryDelayMs: 1 })).toEqual({ ok: true, status: 200, attempts: 2 });
    f = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { name: 'TimeoutError' }));
    expect(await hop.forwardBillingEvent(evt, { env: ENV, fetchImpl: f, retryDelayMs: 1 })).toEqual({ ok: false, status: 0, attempts: 2 });
    expect(f).toHaveBeenCalledTimes(2);
    f = vi.fn(async () => ok(401));
    expect(await hop.forwardBillingEvent(evt, { env: ENV, fetchImpl: f, retryDelayMs: 1 })).toEqual({ ok: false, status: 401, attempts: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(TOKEN);
  });
  it('times out a hung gbk and never throws', async () => {
    const hang = vi.fn((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))));
    const r = await hop.forwardBillingEvent(evt, { env: ENV, fetchImpl: hang, timeoutMs: 20, retryDelayMs: 1 });
    expect(r).toEqual({ ok: false, status: 0, attempts: 2 });
    expect(logged()).not.toContain(TOKEN);
  });
});

describe('Stripe webhook -> gbk hop', () => {
  const handle = (event, forward) => music.handleProductWebhookEvent(event, { db, send: vi.fn(async () => ({})), env: ENV, forward, sendEmail: vi.fn() });
  const checkout = { type: 'checkout.session.completed', data: { object: { id: 'cs_9', mode: 'payment', amount_total: 9999, currency: 'usd', customer_details: { email: 'a@b.co' }, metadata: { product: 'compose', plan: 'lifetime' } } } };

  it('forwards a new compose purchase once (Stripe retries are not re-sent)', async () => {
    const forward = vi.fn(async () => ({ ok: true }));
    expect(await handle(checkout, forward)).toBe(true);
    expect(await handle(checkout, forward)).toBe(true);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0][0]).toMatchObject({ type: 'purchase', ref: 'cs_9', plan: 'lifetime', amountCents: 9999 });
    expect(forward.mock.calls[0][1]).toEqual({ env: ENV });
  });
  it('does not wait on gbk: a hung forward does not delay the handler', async () => {
    const forward = vi.fn(() => new Promise(() => {}));
    await expect(handle(checkout, forward)).resolves.toBe(true);
    expect(forward).toHaveBeenCalledTimes(1);
  });
  it('forwards cancel, renewal and refund; ignores music and FinalCut events', async () => {
    const forward = vi.fn(async () => ({ ok: true }));
    await handle({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', canceled_at: 1793000000, metadata: { product: 'compose', plan: 'pro_yearly' } } } }, forward);
    await handle({ type: 'invoice.paid', data: { object: { id: 'in_1', amount_paid: 4799, currency: 'usd', parent: { subscription_details: { subscription: 'sub_2', metadata: { product: 'compose', plan: 'pro_yearly' } } } } } }, forward);
    await handle({ type: 'charge.refunded', data: { object: { id: 'ch_1', customer: 'cus_1', amount_refunded: 4799, currency: 'usd', metadata: {} } } }, forward);
    await handle({ type: 'checkout.session.completed', data: { object: { id: 'cs_m', mode: 'payment', amount_total: 100, metadata: { product: 'music', plan: 'lifetime' } } } }, forward);
    expect(await handle({ type: 'charge.refunded', data: { object: { id: 'ch_fc', customer: 'cus_other', metadata: {} } } }, forward)).toBe(false);
    expect(forward.mock.calls.map(([e]) => e.type)).toEqual(['cancel', 'renewal', 'refund']);
  });
  it('end to end with the real forwarder: the webhook resolves, gbk gets the event', async () => {
    const fetchImpl = vi.fn(async () => ok());
    const forward = (e, o) => hop.forwardBillingEvent(e, { ...o, fetchImpl });
    await handle(checkout, forward);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ event: 'purchase', plan: 'lifetime', value_cents: 9999, detail: 'cs_9' });
  });
});
