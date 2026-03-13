import express from 'express';
import cors from 'cors';
import { initDatabase } from './src/db.js';
import { PORT, stripe } from './src/server/config.js';
import { setupAuth, authRouter } from './src/server/auth.js';
import { stripeWebhookRouter, stripeRouter } from './src/server/stripe.js';
import { captionsRouter } from './src/server/captions.js';
import { videoRouter } from './src/server/video.js';
import { chatRouter } from './src/server/chat.js';

const app = express();

// Trust proxy headers (required when behind nginx/reverse proxy)
// Enable for production or when TRUST_PROXY environment variable is set
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Initialize database
try {
  await initDatabase();
} catch (error) {
  console.warn('WARNING: Could not initialize database. Google login features may not work.');
  console.warn('Error:', error.message);
}

// Configure session middleware, Passport, and Google OAuth strategy
setupAuth(app);

// Stripe webhook endpoint must be mounted before JSON body parsing
// so Stripe signature verification receives the raw body.
app.use(stripeWebhookRouter);

// JSON body parsing
app.use(express.json({ limit: '950mb' }));

// Routes
app.use(authRouter);
app.use(stripeRouter);
app.use(captionsRouter);
app.use(videoRouter);
app.use(chatRouter);

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
  console.log('Configuration loaded successfully');
  console.log('FFmpeg video processing endpoint available at /api/process-video');
  if (stripe) {
    console.log('Stripe payment endpoints available:');
    console.log('  - POST /api/create-checkout-session');
    console.log('  - POST /api/verify-checkout-session');
    console.log('  - POST /api/stripe-webhook');
  } else {
    console.log('Stripe payment endpoints are disabled (STRIPE_SECRET_KEY not set)');
  }
});
