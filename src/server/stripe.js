import express from 'express';
import {
  stripe,
  STRIPE_WEBHOOK_SECRET,
  defaultStripePriceId,
  allowedStripePriceIds,
} from './config.js';
import { apiLimiter, getBaseUrlFromRequest } from './middleware.js';

// Stripe webhook router — must be mounted BEFORE express.json() body parsing
// so Stripe signature verification receives the raw body.
const webhookRouter = express.Router();

webhookRouter.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured on this server' });
  }

  const sig = req.headers['stripe-signature'];

  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('WARNING: STRIPE_WEBHOOK_SECRET is not set, skipping signature verification');
    return res.status(400).json({ error: 'Webhook secret not configured' });
  }

  let event;

  try {
    // Verify the webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        console.log('Payment successful:', session.id);

        // Update user subscription status
        if (session.customer_email) {
          const { updateUserSubscription } = await import('../db.js');
          await updateUserSubscription(
            session.customer_email,
            true,
            session.subscription || session.id
          );
          console.log(`Updated subscription for ${session.customer_email}`);
        }
        break;

      case 'customer.subscription.deleted':
        const subscription = event.data.object;
        console.log('Subscription cancelled:', subscription.id);

        // Update user subscription status to false
        if (subscription.customer) {
          const customer = await stripe.customers.retrieve(subscription.customer);
          if (customer.email) {
            const { updateUserSubscription } = await import('../db.js');
            await updateUserSubscription(customer.email, false, null);
            console.log(`Removed subscription for ${customer.email}`);
          }
        }
        break;

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

    // Create a Checkout Session
    const session = await stripe.checkout.sessions.create({
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
    });

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

    // Retrieve the session from Stripe to verify it
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Verify the session is valid and payment was successful
    if (session && session.payment_status === 'paid') {
      // Update the user's subscription in the database
      if (session.customer_email) {
        try {
          const { updateUserSubscription } = await import('../db.js');
          await updateUserSubscription(
            session.customer_email,
            true,
            session.subscription || session.id
          );
          console.log(`Updated subscription for ${session.customer_email} via payment verification`);

          // Update current session for immediate consistency
          // Note: This only affects the current request. On subsequent requests,
          // Passport will deserialize the user from the database with the updated subscription status.
          if (req.isAuthenticated() && req.user && req.user.email === session.customer_email) {
            req.user.has_subscription = true;
            req.user.subscription_id = session.subscription || session.id;
          }
        } catch (dbError) {
          console.error('Error updating subscription in database:', dbError);
          // Continue anyway - webhook will handle it as fallback
        }
      }

      res.json({
        verified: true,
        paymentStatus: session.payment_status,
        customerEmail: session.customer_email
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
