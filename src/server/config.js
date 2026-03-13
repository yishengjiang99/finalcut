import dotenv from 'dotenv';
import os from 'os';
import Stripe from 'stripe';

dotenv.config();

export const PORT = process.env.PORT || 3001;
export const TMP_DIR = process.env.FINALCUT_TMP_DIR || os.tmpdir();
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
export const XAI_API_TOKEN = process.env.XAI_API_TOKEN;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback';
export const SESSION_SECRET = process.env.SESSION_SECRET;
export const APP_BASE_URL = process.env.APP_BASE_URL;
export const ALLOW_UNAUTH_SAMPLE_MODE = process.env.ALLOW_UNAUTH_SAMPLE_MODE !== 'false';
export const SAMPLE_TOKEN_TTL_MS = Math.max(60_000, Number(process.env.SAMPLE_TOKEN_TTL_MS || 10 * 60 * 1000));

if (!XAI_API_TOKEN) {
  console.error('ERROR: XAI_API_TOKEN environment variable is not set');
  console.error('Please create a .env file with XAI_API_TOKEN=your_token_here');
  process.exit(1);
}

if (!SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET environment variable is not set');
  console.error('Please set SESSION_SECRET to a secure random string');
  process.exit(1);
}

if (!STRIPE_SECRET_KEY) {
  console.warn('WARNING: STRIPE_SECRET_KEY environment variable is not set');
  console.warn('Stripe payment endpoints will not be available');
}

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.warn('WARNING: Google OAuth credentials not set');
  console.warn('Google login will not be available');
}

if (!OPENAI_API_KEY) {
  console.warn('WARNING: OPENAI_API_KEY environment variable is not set');
  console.warn('Speaker diarization (batch /v1/audio/transcriptions) will not be available');
}

// Initialize Stripe only if the secret key is available
export const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
export const defaultStripePriceId = process.env.STRIPE_SUBSCRIPTION_PRICE_ID || 'price_1StDJe4OymfcnKESq2dIraNE';
export const allowedStripePriceIds = new Set(
  [
    defaultStripePriceId,
    ...(process.env.STRIPE_ALLOWED_PRICE_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ]
);
