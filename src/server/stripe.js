import express from 'express';
import {
  stripe,
  STRIPE_WEBHOOK_SECRET,
  defaultStripePriceId,
  allowedStripePriceIds,
} from './config.js';
import { apiLimiter, getBaseUrlFromRequest } from './middleware.js';
import { handleProductWebhookEvent } from './musicBilling.js';
import { FINALCUT_PRODUCT, productOf } from './products.js';

// The FinalCut user a checkout session belongs to: client_reference_id (the signed-in user's id, set at
// checkout creation), else the email Stripe collected (customer_details.email) or prefilled (customer_email).
export function finalcutSessionOwner(session) {
  const ref = String(session?.client_reference_id || '').trim();
  const userId = /^[1-9][0-9]*$/.test(ref) ? Number(ref) : null;
  const email = session?.customer_details?.email || session?.customer_email || null;
  return { userId, email };
}

// Paid, or completed with nothing to pay yet (a subscription that starts with a free trial).
export function isFinalcutSessionPaid(session) {
  if (!session) return false;
  if (session.payment_status === 'paid') return true;
  return session.status === 'complete' && session.payment_status === 'no_payment_required';
}

// Grants FinalCut Pro for a paid FinalCut checkout session. Returns the owner it granted to, or null.
export async function grantFinalcutSubscription(session) {
  const db = await import('../db.js');
  const { userId, email } = finalcutSessionOwner(session);
  const subscriptionId = session.subscription || session.id;
  if (userId && (await db.updateUserSubscriptionById(userId, true, subscriptionId)) > 0) {
    console.log(`Updated subscription for user ${userId}`);
    return { userId, email };
  }
  if (email) {
    await db.updateUserSubscription(email, true, subscriptionId);
    console.log(`Updated subscription for ${email}`);
    return { userId: null, email };
  }
  console.warn(`Checkout ${session.id} has no client_reference_id user or email; subscription not granted`);
  return null;
}

// customer.subscription.updated: these statuses lose FinalCut Pro, these keep it. Others (incomplete,
// paused) leave the flag as it is.
export const FINALCUT_REVOKE_STATUSES = new Set(['past_due', 'unpaid', 'canceled', 'incomplete_expired']);
export const FINALCUT_ACTIVE_STATUSES = new Set(['active', 'trialing']);

export function finalcutAccessForStatus(status) {
  if (FINALCUT_REVOKE_STATUSES.has(status)) return false;
  if (FINALCUT_ACTIVE_STATUSES.has(status)) return true;
  return null;
}

// Stripe webhook router — must be mounted BEFORE express.json() body parsing
// so Stripe signature verification receives the raw body.
const webhookRouter = express.Router();

webhookRouter.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured on this server' });
  }

  const sig = req.headers['stripe-signature'];

  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('WARNING: STRIPE_WEBHOOK_SECRET is not set; rejecting webhook (signature cannot be verified)');
    return res.status(400).json({ error: 'Webhook secret not configured' });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    // Non-FinalCut products (metadata.product: 'music', 'compose') are handled on their own and never
    // touch the FinalCut users.has_subscription flag. FinalCut events fall through unchanged.
    if (await handleProductWebhookEvent(event)) {
      return res.json({ received: true });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('Payment successful:', session.id);
        if (isFinalcutSessionPaid(session)) await grantFinalcutSubscription(session);
        break;
      }

      case 'customer.subscription.deleted':
        const subscription = event.data.object;
        console.log('Subscription cancelled:', subscription.id);

        if (subscription.customer) {
          const customer = await stripe.customers.retrieve(subscription.customer);
          if (customer.email) {
            const { updateUserSubscription } = await import('../db.js');
            await updateUserSubscription(customer.email, false, null);
            console.log(`Removed subscription for ${customer.email}`);
          }
        }
        break;

      case 'customer.subscription.updated': {
        const updated = event.data.object;
        const access = finalcutAccessForStatus(updated.status);
        if (access !== null && updated.id) {
          const { setSubscriptionActiveBySubscriptionId } = await import('../db.js');
          const n = await setSubscriptionActiveBySubscriptionId(updated.id, access);
          console.log(`Subscription ${updated.id} is ${updated.status}: Pro ${access ? 'kept' : 'removed'} (${n} user(s))`);
        }
        break;
      }

      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        console.log('PaymentIntent successful:', paymentIntent.id);
        break;

      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        console.log('Payment failed:', failedPayment.id);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error handling webhook event:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// Stripe checkout routes — mounted AFTER express.json()
const router = express.Router();

router.post('/api/create-checkout-session', apiLimiter, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured on this server' });
  }

  try {
    const { priceId } = req.body || {};
    const selectedPriceId = priceId || defaultStripePriceId;

    if (!allowedStripePriceIds.has(selectedPriceId)) {
      return res.status(400).json({
        error: 'Invalid priceId'
      });
    }

    const baseUrl = getBaseUrlFromRequest(req);
    const successUrl = `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl}/`;

    const params = {
      payment_method_types: ['card'],
      line_items: [
        {
          price: selectedPriceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
    };
    // Tie the purchase to the signed-in user so the webhook and verify grant Pro to this account.
    const user = typeof req.isAuthenticated === 'function' && req.isAuthenticated() ? req.user : null;
    if (user?.id) {
      params.client_reference_id = String(user.id);
      params.subscription_data = { metadata: { finalcut_user_id: String(user.id) } };
    }
    if (user?.email) params.customer_email = user.email;

    const session = await stripe.checkout.sessions.create(params);

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ error: error.message || 'Failed to create checkout session' });
  }
});

router.post('/api/verify-checkout-session', apiLimiter, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured on this server' });
  }

  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: 'Missing required field: sessionId'
      });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Verify the session is valid and payment was successful
    if (session && productOf(session) !== FINALCUT_PRODUCT) {
      // Another product's session (music, compose): never grants the FinalCut subscription.
      return res.json({ verified: false, paymentStatus: session.payment_status, product: productOf(session) });
    }

    if (isFinalcutSessionPaid(session)) {
      let owner = null;
      try {
        owner = await grantFinalcutSubscription(session);
      } catch (dbError) {
        console.error('Error updating subscription in database:', dbError);
        // Continue anyway - webhook will handle it as fallback
      }

      // Update the current session for immediate consistency; later requests read the database.
      const signedIn = typeof req.isAuthenticated === 'function' && req.isAuthenticated() ? req.user : null;
      if (owner && signedIn && ((owner.userId && signedIn.id === owner.userId) || (!owner.userId && owner.email && signedIn.email === owner.email))) {
        signedIn.has_subscription = true;
        signedIn.subscription_id = session.subscription || session.id;
      }

      res.json({
        verified: true,
        paymentStatus: session.payment_status,
        customerEmail: finalcutSessionOwner(session).email
      });
    } else {
      res.json({
        verified: false,
        paymentStatus: session?.payment_status || 'unknown'
      });
    }
  } catch (error) {
    console.error('Error verifying checkout session:', error);
    res.status(500).json({ error: error.message || 'Failed to verify checkout session' });
  }
});

export { webhookRouter as stripeWebhookRouter, router as stripeRouter };
