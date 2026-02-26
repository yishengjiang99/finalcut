import { randomBytes } from 'crypto';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import {
  ALLOW_UNAUTH_SAMPLE_MODE,
  SAMPLE_TOKEN_TTL_MS,
  APP_BASE_URL,
} from './config.js';

export const sampleAccessTokens = new Map();

export function issueSampleAccessToken() {
  const token = randomBytes(32).toString('hex');
  sampleAccessTokens.set(token, Date.now() + SAMPLE_TOKEN_TTL_MS);
  return token;
}

export function validateSampleAccessToken(token) {
  if (typeof token !== 'string' || token.length < 32) {
    return false;
  }
  const expiresAt = sampleAccessTokens.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    sampleAccessTokens.delete(token);
    return false;
  }
  return true;
}

export function isValidSampleModeRequest(req) {
  if (!ALLOW_UNAUTH_SAMPLE_MODE) return false;
  return validateSampleAccessToken(req.headers['sample-access-token']);
}

const sampleTokenCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sampleAccessTokens.entries()) {
    if (expiresAt < now) {
      sampleAccessTokens.delete(token);
    }
  }
}, 60_000);

if (typeof sampleTokenCleanupTimer.unref === 'function') {
  sampleTokenCleanupTimer.unref();
}

// Rate limiting for API endpoints
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

export const videoProcessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit video processing to 20 requests per 15 minutes
  message: 'Too many video processing requests, please try again later.'
});

export function requireAuthenticatedUser(req, res, next) {
  if (isValidSampleModeRequest(req)) {
    return next();
  }
  if (req.headers['sample-access-token']) {
    return res.status(401).json({ error: 'Invalid or expired sample access token' });
  }
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Invalid user session' });
  }
  next();
}

export function requireActiveSubscription(req, res, next) {
  if (isValidSampleModeRequest(req)) {
    return next();
  }
  if (!req.user?.has_subscription) {
    return res.status(403).json({ error: 'Active subscription required' });
  }
  next();
}

export function getBaseUrlFromRequest(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL.replace(/\/+$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

// Configure multer for file uploads (store in memory)
const storage = multer.memoryStorage();
export const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});
