// @vitest-environment node
// FinalCut web Stripe: checkout is tied to the signed-in user (client_reference_id + customer_email) and the
// webhook / verify grant Pro by that user id, falling back to customer_details.email.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import Stripe from 'stripe';

const db = vi.hoisted(() => ({
  updateUserSubscription: vi.fn(async () => {}),
  updateUserSubscriptionById: vi.fn(async (id) => (id === 42 ? 1 : 0)),
  setProductEntitlement: vi.fn(async () => {}),
  setProductEntitlementByRef: vi.fn(async () => {}),
  setProductSubscriptionState: vi.fn(async () => {}),
  recordProductEvent: vi.fn(async () => true),
  hasProductEvent: vi.fn(async () => false),
  findProductEntitlementByRef: vi.fn(async () => null),
  findProductEntitlementByCustomer: vi.fn(async () => null),
}));
vi.mock('../db.js', () => db);

const WH = 'whsec_test_finalcut';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = WH;

let stripeMod, config;
beforeAll(async () => {
  config = await import('../server/config.js');
  stripeMod = await import('../server/stripe.js');
});
beforeEach(() => { Object.values(db).forEach((f) => f.mockClear()); vi.restoreAllMocks(); });

async function serve(user) {
  const app = express();
  app.use(stripeMod.stripeWebhookRouter);
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user || undefined; req.isAuthenticated = () => Boolean(user); next(); });
  app.use(stripeMod.stripeRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function postWebhook(base, event) {
  const payload = JSON.stringify(event);
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WH });
  return fetch(`${base}/api/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
}

describe('POST /api/create-checkout-session', () => {
  it('ties the session to the signed-in user (client_reference_id + customer_email); price unchanged', async () => {
    const create = vi.spyOn(config.stripe.checkout.sessions, 'create').mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    const srv = await serve({ id: 42, email: 'a@example.com' });
    try {
      const r = await post(srv.base, '/api/create-checkout-session', {});
      expect(r.status).toBe(200);
      const params = create.mock.calls[0][0];
      expect(params.client_reference_id).toBe('42');
      expect(params.customer_email).toBe('a@example.com');
      expect(params.subscription_data).toEqual({ metadata: { finalcut_user_id: '42' } });
      expect(params.line_items).toEqual([{ price: config.defaultStripePriceId, quantity: 1 }]);
      expect(params.mode).toBe('subscription');
    } finally { await srv.close(); }
  });

  it('signed out: no client_reference_id or customer_email', async () => {
    const create = vi.spyOn(config.stripe.checkout.sessions, 'create').mockResolvedValue({ id: 'cs_2', url: 'u' });
    const srv = await serve(null);
    try {
      expect((await post(srv.base, '/api/create-checkout-session', {})).status).toBe(200);
      const params = create.mock.calls[0][0];
      expect(params).not.toHaveProperty('client_reference_id');
      expect(params).not.toHaveProperty('customer_email');
    } finally { await srv.close(); }
  });

  it('still rejects a price that is not allowed', async () => {
    const create = vi.spyOn(config.stripe.checkout.sessions, 'create');
    const srv = await serve({ id: 42, email: 'a@example.com' });
    try {
      expect((await post(srv.base, '/api/create-checkout-session', { priceId: 'price_evil' })).status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });
});

describe('checkout.session.completed webhook (FinalCut)', () => {
  let srv;
  beforeAll(async () => { srv = await serve(null); });
  afterAll(async () => srv.close());

  it('grants by client_reference_id', async () => {
    const r = await postWebhook(srv.base, { id: 'evt_1', type: 'checkout.session.completed', data: { object: {
      id: 'cs_a', payment_status: 'paid', status: 'complete', subscription: 'sub_a', client_reference_id: '42', customer_details: { email: 'other@example.com' } } } });
    expect(r.status).toBe(200);
    expect(db.updateUserSubscriptionById).toHaveBeenCalledWith(42, true, 'sub_a');
    expect(db.updateUserSubscription).not.toHaveBeenCalled();
  });

  it('falls back to customer_details.email when there is no client_reference_id', async () => {
    await postWebhook(srv.base, { id: 'evt_2', type: 'checkout.session.completed', data: { object: {
      id: 'cs_b', payment_status: 'paid', status: 'complete', subscription: 'sub_b', customer_email: null, customer_details: { email: 'b@example.com' } } } });
    expect(db.updateUserSubscriptionById).not.toHaveBeenCalled();
    expect(db.updateUserSubscription).toHaveBeenCalledWith('b@example.com', true, 'sub_b');
  });

  it('falls back to email when the client_reference_id user no longer exists', async () => {
    await postWebhook(srv.base, { id: 'evt_3', type: 'checkout.session.completed', data: { object: {
      id: 'cs_c', payment_status: 'paid', status: 'complete', subscription: 'sub_c', client_reference_id: '7', customer_details: { email: 'c@example.com' } } } });
    expect(db.updateUserSubscriptionById).toHaveBeenCalledWith(7, true, 'sub_c');
    expect(db.updateUserSubscription).toHaveBeenCalledWith('c@example.com', true, 'sub_c');
  });

  it('grants a free-trial start (complete, no_payment_required)', async () => {
    await postWebhook(srv.base, { id: 'evt_4', type: 'checkout.session.completed', data: { object: {
      id: 'cs_d', payment_status: 'no_payment_required', status: 'complete', subscription: 'sub_d', client_reference_id: '42' } } });
    expect(db.updateUserSubscriptionById).toHaveBeenCalledWith(42, true, 'sub_d');
  });

  it('does not grant an unpaid session', async () => {
    await postWebhook(srv.base, { id: 'evt_5', type: 'checkout.session.completed', data: { object: {
      id: 'cs_e', payment_status: 'unpaid', status: 'complete', subscription: 'sub_e', client_reference_id: '42', customer_details: { email: 'e@example.com' } } } });
    expect(db.updateUserSubscriptionById).not.toHaveBeenCalled();
    expect(db.updateUserSubscription).not.toHaveBeenCalled();
  });

  it('ignores a non-numeric client_reference_id', () => {
    expect(stripeMod.finalcutSessionOwner({ client_reference_id: '42 OR 1=1', customer_details: { email: 'x@example.com' } })).toEqual({ userId: null, email: 'x@example.com' });
  });
});

describe('POST /api/verify-checkout-session', () => {
  it('grants the client_reference_id user and updates the signed-in session', async () => {
    vi.spyOn(config.stripe.checkout.sessions, 'retrieve').mockResolvedValue({
      id: 'cs_v', payment_status: 'paid', status: 'complete', subscription: 'sub_v', client_reference_id: '42', customer_details: { email: 'a@example.com' } });
    const user = { id: 42, email: 'a@example.com', has_subscription: false };
    const srv = await serve(user);
    try {
      const r = await post(srv.base, '/api/verify-checkout-session', { sessionId: 'cs_v' });
      const body = await r.json();
      expect(body).toEqual({ verified: true, paymentStatus: 'paid', customerEmail: 'a@example.com' });
      expect(db.updateUserSubscriptionById).toHaveBeenCalledWith(42, true, 'sub_v');
    } finally { await srv.close(); }
  });

  it('never grants another product\'s session', async () => {
    vi.spyOn(config.stripe.checkout.sessions, 'retrieve').mockResolvedValue({
      id: 'cs_m', payment_status: 'paid', status: 'complete', client_reference_id: '42', metadata: { product: 'music' } });
    const srv = await serve({ id: 42, email: 'a@example.com' });
    try {
      const body = await (await post(srv.base, '/api/verify-checkout-session', { sessionId: 'cs_m' })).json();
      expect(body.verified).toBe(false);
      expect(db.updateUserSubscriptionById).not.toHaveBeenCalled();
    } finally { await srv.close(); }
  });
});
