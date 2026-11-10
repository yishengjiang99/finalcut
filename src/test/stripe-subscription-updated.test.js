// @vitest-environment node
// customer.subscription.updated (FinalCut): past_due / unpaid / canceled / incomplete_expired lose Pro,
// active / trialing keep it, other statuses change nothing. Read-only toward Stripe.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import Stripe from 'stripe';

const db = vi.hoisted(() => ({
  updateUserSubscription: vi.fn(async () => {}),
  setSubscriptionActiveBySubscriptionId: vi.fn(async () => 1),
  setProductEntitlement: vi.fn(async () => {}),
  setProductEntitlementByRef: vi.fn(async () => {}),
  setProductSubscriptionState: vi.fn(async () => {}),
  recordProductEvent: vi.fn(async () => true),
  hasProductEvent: vi.fn(async () => false),
  findProductEntitlementByRef: vi.fn(async () => null),
  findProductEntitlementByCustomer: vi.fn(async () => null),
}));
vi.mock('../db.js', () => db);

const WH = 'whsec_test_subupd';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = WH;

let stripeMod, config, srv;
beforeAll(async () => {
  config = await import('../server/config.js');
  stripeMod = await import('../server/stripe.js');
  const app = express();
  app.use(stripeMod.stripeWebhookRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  srv = { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
});
afterAll(async () => srv.close());
beforeEach(() => Object.values(db).forEach((f) => f.mockClear()));

async function postUpdated(status, extra = {}) {
  const payload = JSON.stringify({ id: `evt_${status}`, type: 'customer.subscription.updated', data: { object: { id: 'sub_fc', status, customer: 'cus_1', ...extra } } });
  const sig = Stripe.webhooks.generateTestHeaderString({ payload, secret: WH });
  return fetch(`${srv.base}/api/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
}

describe('customer.subscription.updated (FinalCut)', () => {
  for (const status of ['past_due', 'unpaid', 'canceled', 'incomplete_expired']) {
    it(`${status} removes Pro`, async () => {
      expect((await postUpdated(status)).status).toBe(200);
      expect(db.setSubscriptionActiveBySubscriptionId).toHaveBeenCalledWith('sub_fc', false);
    });
  }
  for (const status of ['active', 'trialing']) {
    it(`${status} keeps Pro`, async () => {
      expect((await postUpdated(status)).status).toBe(200);
      expect(db.setSubscriptionActiveBySubscriptionId).toHaveBeenCalledWith('sub_fc', true);
    });
  }
  it('incomplete / paused change nothing', async () => {
    await postUpdated('incomplete');
    await postUpdated('paused');
    expect(db.setSubscriptionActiveBySubscriptionId).not.toHaveBeenCalled();
  });
  it('makes no Stripe API calls', async () => {
    const spies = [vi.spyOn(config.stripe.customers, 'retrieve'), vi.spyOn(config.stripe.subscriptions, 'update'), vi.spyOn(config.stripe.refunds, 'create')];
    await postUpdated('past_due');
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
  it('another product\'s subscription never touches the FinalCut flag', async () => {
    await postUpdated('past_due', { metadata: { product: 'compose' } });
    expect(db.setSubscriptionActiveBySubscriptionId).not.toHaveBeenCalled();
  });
});
