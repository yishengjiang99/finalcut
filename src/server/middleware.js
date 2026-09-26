import { randomBytes } from 'crypto';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import {
  ALLOW_UNAUTH_SAMPLE_MODE,
  SAMPLE_TOKEN_TTL_MS,
  APP_BASE_URL,
  IOS_FREE_DAILY_INFERENCE_LIMIT,
} from './config.js';
import { findUserByApiToken, consumeDailyInference } from '../db.js';
import { isAcceptedUpload } from './mediaType.js';

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

/**
 * Extract Bearer token from Authorization header.
 * Returns null if missing/malformed.
 */
export function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token || null;
}

/**
 * Attach req.user from a valid Bearer API token when present.
 * Does not reject unauthenticated requests — use requireAuthenticatedUser for that.
 * @returns {Promise<boolean>} true if a Bearer user was attached
 */
export async function attachBearerUser(req) {
  const token = extractBearerToken(req);
  if (!token) return false;
  const user = await findUserByApiToken(token);
  if (!user) {
    const err = new Error('Invalid or expired access token');
    err.statusCode = 401;
    throw err;
  }
  user.has_subscription = Boolean(user.has_subscription);
  req.user = user;
  req.authMethod = 'bearer';
  return true;
}

export async function requireAuthenticatedUser(req, res, next) {
  try {
    if (isValidSampleModeRequest(req)) {
      return next();
    }
    if (req.headers['sample-access-token']) {
      return res.status(401).json({ error: 'Invalid or expired sample access token' });
    }

    // Mobile / API clients: Authorization: Bearer <accessToken>
    if (extractBearerToken(req)) {
      await attachBearerUser(req);
      return next();
    }

    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Invalid user session' });
    }
    req.authMethod = req.authMethod || 'session';
    next();
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 401) {
      return res.status(401).json({ error: error.message || 'Authentication required' });
    }
    console.error('requireAuthenticatedUser error:', error);
    return res.status(500).json({ error: 'Authentication error' });
  }
}

export function requireActiveSubscription(req, res, next) {
  if (isValidSampleModeRequest(req)) {
    return next();
  }
  if (!req.user?.has_subscription && !req.user?.device_install_id) {
    return res.status(403).json({ error: 'Active subscription required' });
  }
  next();
}

/** Premium users bypass the quota; anonymous iOS installs consume one daily inference. */
export async function requireInferenceAccess(req, res, next) {
  if (isValidSampleModeRequest(req) || req.user?.has_subscription) return next();
  if (!req.user?.device_install_id) {
    return res.status(403).json({ error: 'Active subscription required' });
  }
  try {
    const usage = await consumeDailyInference(req.user.id, IOS_FREE_DAILY_INFERENCE_LIMIT);
    res.set('X-Inference-Daily-Limit', String(usage.limit));
    res.set('X-Inference-Daily-Remaining', String(usage.remaining));
    if (!usage.allowed) {
      return res.status(429).json({
        error: 'Daily free inference limit reached',
        code: 'daily_limit_reached',
        dailyLimit: usage.limit,
        dailyUsed: usage.used,
        dailyRemaining: usage.remaining,
        resetsAt: usage.resetsAt,
      });
    }
    return next();
  } catch (error) {
    console.error('Daily inference usage error:', error);
    return res.status(500).json({ error: 'Unable to check daily inference limit' });
  }
}

export function getBaseUrlFromRequest(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL.replace(/\/+$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

// Configure multer for file uploads (store in memory).
// Accepts videos, audio and photos (jpg/png/webp/heic/…). Photos (typically 1–15MB)
// fit well within the 100MB default, which matches nginx client_max_body_size 100M.
// Override with UPLOAD_MAX_BYTES (raise nginx too if you go higher).
const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = (() => {
  const n = Number(process.env.UPLOAD_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_UPLOAD_MAX_BYTES;
})();

export function mediaFileFilter(req, file, cb) {
  if (isAcceptedUpload({ mimetype: file.mimetype, filename: file.originalname })) {
    return cb(null, true);
  }
  const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname);
  err.message = `Unsupported file type "${file.mimetype}". Upload a video, audio file, or photo (jpg, png, webp, heic).`;
  err.statusCode = 415;
  return cb(err);
}

const storage = multer.memoryStorage();
export const upload = multer({
  storage: storage,
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter: mediaFileFilter,
});

/**
 * upload.single() wrapper that turns multer errors into JSON responses
 * (413 for size limit, 415 for unsupported type, 400 otherwise).
 */
export function uploadSingle(fieldName) {
  const handler = upload.single(fieldName);
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();
      const status = err.statusCode
        || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      return res.status(status).json({ error: err.message || 'Upload failed' });
    });
  };
}
