import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import { initDatabase, findUserByGoogleId, findUserByEmail, createUser } from './src/db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy headers (required when behind nginx/reverse proxy)
// Enable for production or when TRUST_PROXY environment variable is set
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

const PORT = process.env.PORT || 3001;
const XAI_API_TOKEN = process.env.XAI_API_TOKEN;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/auth/google/callback';
const SESSION_SECRET = process.env.SESSION_SECRET;
const APP_BASE_URL = process.env.APP_BASE_URL;
const ALLOW_UNAUTH_SAMPLE_MODE = process.env.ALLOW_UNAUTH_SAMPLE_MODE !== 'false';
const SAMPLE_TOKEN_TTL_MS = Math.max(60_000, Number(process.env.SAMPLE_TOKEN_TTL_MS || 10 * 60 * 1000));

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

// Initialize Stripe only if the secret key is available
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const defaultStripePriceId = process.env.STRIPE_SUBSCRIPTION_PRICE_ID || 'price_1StDJe4OymfcnKESq2dIraNE';
const allowedStripePriceIds = new Set(
  [
    defaultStripePriceId,
    ...(process.env.STRIPE_ALLOWED_PRICE_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  ]
);
const sampleAccessTokens = new Map();

function issueSampleAccessToken() {
  const token = randomBytes(32).toString('hex');
  sampleAccessTokens.set(token, Date.now() + SAMPLE_TOKEN_TTL_MS);
  return token;
}

function validateSampleAccessToken(token) {
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

function isValidSampleModeRequest(req) {
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

// Initialize database
try {
  await initDatabase();
} catch (error) {
  console.warn('WARNING: Could not initialize database. Google login features may not work.');
  console.warn('Error:', error.message);
}

// Configure session middleware
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Configure Google OAuth Strategy
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL
  },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user exists by Google ID
        let user = await findUserByGoogleId(profile.id);

        if (!user) {
          // Check if user exists by email
          const email = profile.emails?.[0]?.value;
          if (email) {
            user = await findUserByEmail(email);

            // If user exists but doesn't have google_id, update it
            if (user && !user.google_id) {
              const pool = (await import('./src/db.js')).getPool();
              await pool.query('UPDATE users SET google_id = ? WHERE id = ?', [profile.id, user.id]);
              user.google_id = profile.id;
            }
          }

          if (!user) {
            // Create new user (reuse email variable from above)
            user = await createUser({
              email: email || `${profile.id}@google.com`,
              google_id: profile.id,
              name: profile.displayName,
              has_subscription: false
            });

            // Verify user was created successfully
            if (!user || !user.id) {
              console.error('Failed to create user in database');
              return done(new Error('Failed to create user'), null);
            }

            console.log(`New user created: ${user.email} (ID: ${user.id})`);
          }
        }

        // Normalize boolean fields from MySQL TINYINT(1) to JavaScript boolean
        user.has_subscription = Boolean(user.has_subscription);

        return done(null, user);
      } catch (error) {
        console.error('Error in Google OAuth strategy:', error);
        return done(error, null);
      }
    }));

  passport.serializeUser((user, done) => {
    // Ensure user has a valid ID before serializing
    if (!user || !user.id) {
      console.error('Attempting to serialize user without valid ID:', user);
      return done(new Error('User object missing ID'), null);
    }
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const pool = (await import('./src/db.js')).getPool();
      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
      const user = rows[0] || null;

      if (!user) {
        console.error(`User with id ${id} not found in database during deserialization`);
        return done(new Error('User not found'), null);
      }

      // Normalize boolean fields from MySQL TINYINT(1) to JavaScript boolean
      user.has_subscription = Boolean(user.has_subscription);

      done(null, user);
    } catch (error) {
      console.error('Error deserializing user:', error);
      done(error, null);
    }
  });
}

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

const videoProcessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit video processing to 20 requests per 15 minutes
  message: 'Too many video processing requests, please try again later.'
});

function requireAuthenticatedUser(req, res, next) {
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

function requireActiveSubscription(req, res, next) {
  if (isValidSampleModeRequest(req)) {
    return next();
  }
  if (!req.user?.has_subscription) {
    return res.status(403).json({ error: 'Active subscription required' });
  }
  next();
}

function getBaseUrlFromRequest(req) {
  if (APP_BASE_URL) {
    return APP_BASE_URL.replace(/\/+$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

function parseAudioDataUri(audioFile) {
  const match = audioFile.match(/^data:audio\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;

  const [, mimeSubtype, base64Data] = match;
  return {
    extension: mimeSubtype.split('+')[0].replace(/^x-/, '').replace(/[^a-zA-Z0-9]/g, '') || 'audio',
    buffer: Buffer.from(base64Data.replace(/\s+/g, ''), 'base64')
  };
}

function parseAudioInput(audioFile) {
  if (typeof audioFile !== 'string') {
    throw new Error('audioFile must be a base64-encoded string');
  }

  const trimmed = audioFile.trim();
  if (!trimmed) {
    throw new Error('audioFile cannot be empty');
  }

  const parsedDataUri = parseAudioDataUri(trimmed);
  if (parsedDataUri) {
    return parsedDataUri;
  }

  const sanitizedBase64 = trimmed.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(sanitizedBase64)) {
    throw new Error('audioFile is not valid base64 data');
  }

  return {
    extension: 'audio',
    buffer: Buffer.from(sanitizedBase64, 'base64')
  };
}

// Configure multer for file uploads (store in memory)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Stripe webhook endpoint for handling payment events
// Must be mounted before JSON body parsing so Stripe signature verification receives the raw body.
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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
          const { updateUserSubscription } = await import('./src/db.js');
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
            const { updateUserSubscription } = await import('./src/db.js');
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

// app.use(cors({
//   origin: process.env.NODE_ENV === 'production' 
//     ? process.env.ALLOWED_ORIGINS?.split(',') || []
//     : ['http://localhost:5173', 'http://localhost:3000']
// }));
app.use(express.json({ limit: '950mb' }));

app.get('/api/sample-access-token', apiLimiter, (req, res) => {
  if (!ALLOW_UNAUTH_SAMPLE_MODE) {
    return res.status(403).json({ error: 'Sample mode is disabled' });
  }
  const token = issueSampleAccessToken();
  res.json({ token, expiresInMs: SAMPLE_TOKEN_TTL_MS });
});

// Authentication routes
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  async (req, res) => {
    try {
      // Validate user object
      if (!req.user || !req.user.email) {
        console.error('Invalid user object after authentication:', req.user);
        return res.redirect('/?error=invalid_user');
      }
      
      console.log(`Google auth callback for user: ${req.user.email}`);
      console.log(`User has subscription: ${req.user.has_subscription}`);
      
      // Check if Stripe is available
      if (!stripe) {
        console.error('Stripe not configured - subscription signup not available');
        return res.redirect('/?error=payment_not_configured');
      }

      // Check if user has subscription
      if (!req.user.has_subscription) {
        console.log('Creating Stripe checkout session for user:', req.user.email);
        
        // Redirect to Stripe subscription page if no subscription
        const session = await stripe.checkout.sessions.create({
          customer_email: req.user.email,
          payment_method_types: ['card'],
          line_items: [
            {
              price: process.env.STRIPE_SUBSCRIPTION_PRICE_ID || 'price_1StDJe4OymfcnKESq2dIraNE',
              quantity: 1,
            },
          ],
          mode: 'subscription',
          success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${req.protocol}://${req.get('host')}/`,
        });

        console.log('Stripe session created, redirecting to:', session.url);
        return res.redirect(session.url);
      }

      // User has subscription, redirect to app
      console.log('User has subscription, redirecting to app');
      res.redirect('/');
    } catch (error) {
      console.error('Error in auth callback:', error);
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
      res.redirect('/?error=auth_failed');
    }
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/');
  });
});

app.get('/api/auth/status', apiLimiter, (req, res) => {
  if (req.isAuthenticated()) {
    // Verify user object exists and has required fields
    if (!req.user || !req.user.id) {
      console.error('User is authenticated but user object is invalid:', req.user);
      // Clear the invalid session
      req.logout((err) => {
        if (err) console.error('Error logging out invalid user:', err);
      });
      return res.json({ authenticated: false });
    }

    res.json({
      authenticated: true,
      user: {
        email: req.user.email,
        name: req.user.name,
        hasSubscription: req.user.has_subscription
      }
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Proxy endpoint for xAI API with streaming support
app.post('/api/chat', apiLimiter, requireAuthenticatedUser, requireActiveSubscription, async (req, res) => {
  try {
    // Basic request validation
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    // Enable streaming for xAI API
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_TOKEN}`
      },
      body: JSON.stringify({
        ...req.body,
        model: 'grok-3', // Specify the new model here
        stream: true // Enable streaming
      })
    });

    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json({ error: error.message });
    }

    // Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Stream the response chunks to the client
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Decode the chunk and send it to the client
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
      res.end();
    } catch (streamError) {
      console.error('Error streaming response:', streamError);
      res.end();
    }
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Supported formats introspection endpoint
app.get('/api/supported-formats', apiLimiter, requireAuthenticatedUser, (req, res) => {
  res.json({
    video: {
      formats: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'],
      codecs: ['libx264', 'libx265', 'libvpx-vp9', 'auto']
    },
    audio: {
      formats: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'],
      bitrates: ['64k', '128k', '192k', '256k', '320k']
    },
    extract: {
      formats: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a']
    }
  });
});

// Video processing endpoint
app.post('/api/process-video', videoProcessLimiter, requireAuthenticatedUser, requireActiveSubscription, upload.single('video'), async (req, res) => {
  let inputPath = null;
  let outputPath = null;
  let audioInputPath = null;

  try {
    const { operation, args } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    if (!operation) {
      return res.status(400).json({ error: 'No operation specified' });
    }

    // Parse args if it's a string
    const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;

    // Create temporary files
    const tmpDir = '/tmp';
    inputPath = path.join(tmpDir, `input-${randomUUID()}.mp4`);
    // Determine output extension based on operation
    const conversionOps = ['convert_video_format', 'convert_audio_format', 'extract_audio'];
    let outputExt = 'mp4';
    if (conversionOps.includes(operation)) {
      outputExt = parsedArgs.format || 'mp4';
    }
    outputPath = path.join(tmpDir, `output-${randomUUID()}.${outputExt}`);

    // Write uploaded file to disk
    await fs.writeFile(inputPath, req.file.buffer);

    if (operation === 'add_audio_track') {
      const parsedAudio = parseAudioInput(parsedArgs.audioFile);
      audioInputPath = path.join(tmpDir, `audio-${randomUUID()}.${parsedAudio.extension}`);
      await fs.writeFile(audioInputPath, parsedAudio.buffer);
    }

    const sourceHasAudio = operation === 'add_audio_track'
      ? await checkHasAudioStream(inputPath)
      : false;

    // Process video based on operation
    const result = await new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath);
      if (audioInputPath) {
        command = command.input(audioInputPath);
      }

      // Special handling for get_video_info
      if (operation === 'get_video_info') {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
          if (err) {
            reject(err);
          } else {
            resolve({ metadata, isMetadata: true });
          }
        });
        return;
      }

      switch (operation) {
        case 'resize_video':
          command = command.videoFilters(`scale=${parsedArgs.width}:${parsedArgs.height}`).audioCodec('copy');
          break;

        case 'crop_video':
          command = command.videoFilters(`crop=${parsedArgs.width}:${parsedArgs.height}:${parsedArgs.x}:${parsedArgs.y}`).audioCodec('copy');
          break;

        case 'rotate_video':
          command = command.videoFilters(`rotate=${parsedArgs.angle}*PI/180`).audioCodec('copy');
          break;

        case 'flip_video_horizontal':
          command = command.videoFilters('hflip').audioCodec('copy');
          break;

        case 'add_text':
          const escapedText = parsedArgs.text
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/:/g, '\\:')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '')
            .replace(/\t/g, '\\t');
          command = command.videoFilters(
            `drawtext=text='${escapedText}':x=${parsedArgs.x || 10}:y=${parsedArgs.y || 10}:fontsize=${parsedArgs.fontsize || 24}:fontcolor=${parsedArgs.color || 'white'}`
          ).audioCodec('copy');
          break;

        case 'trim_video':
          command = command.setStartTime(parsedArgs.start).setDuration(parsedArgs.end - parsedArgs.start).outputOptions('-c copy');
          break;

        case 'speed_video':
          // atempo filter only supports values between 0.5 and 2.0
          // For values outside this range, we need to chain multiple atempo filters
          let audioFilter = '';
          let speed = parsedArgs.speed;

          if (speed >= 0.5 && speed <= 2.0) {
            audioFilter = `atempo=${speed}`;
          } else if (speed < 0.5) {
            // Chain atempo filters for slow speeds
            let remainingSpeed = speed;
            const filters = [];
            while (remainingSpeed < 0.5) {
              filters.push('atempo=0.5');
              remainingSpeed *= 2;
            }
            if (remainingSpeed !== 1.0) {
              filters.push(`atempo=${remainingSpeed}`);
            }
            audioFilter = filters.join(',');
          } else {
            // Chain atempo filters for fast speeds
            let remainingSpeed = speed;
            const filters = [];
            while (remainingSpeed > 2.0) {
              filters.push('atempo=2.0');
              remainingSpeed /= 2;
            }
            if (remainingSpeed !== 1.0) {
              filters.push(`atempo=${remainingSpeed}`);
            }
            audioFilter = filters.join(',');
          }
          command = command.videoFilters(`setpts=PTS/${parsedArgs.speed}`).audioFilters(audioFilter);
          break;

        case 'adjust_volume':
          command = command.audioFilters(`volume=${parsedArgs.volume}`).videoCodec('copy');
          break;

        case 'add_audio_track': {
          const mode = parsedArgs.mode || 'replace';
          const volume = parsedArgs.volume ?? 1.0;

          if (!audioInputPath) {
            reject(new Error('No audio track provided'));
            return;
          }
          if (mode !== 'replace' && mode !== 'mix') {
            reject(new Error('Mode must be either "replace" or "mix"'));
            return;
          }
          if (typeof volume !== 'number' || Number.isNaN(volume) || volume < 0 || volume > 2) {
            reject(new Error('Volume must be between 0.0 and 2.0'));
            return;
          }

          if (mode === 'mix' && sourceHasAudio) {
            command = command
              .complexFilter([
                `[1:a]volume=${volume}[newaudio]`,
                '[0:a][newaudio]amix=inputs=2:duration=first:dropout_transition=2[mixedaudio]'
              ], ['mixedaudio'])
              .outputOptions([
                '-map 0:v:0',
                '-map [mixedaudio]',
                '-c:v copy',
                '-c:a aac',
                '-shortest'
              ]);
          } else {
            command = command
              .complexFilter([
                `[1:a]volume=${volume}[newaudio]`
              ], ['newaudio'])
              .outputOptions([
                '-map 0:v:0',
                '-map [newaudio]',
                '-c:v copy',
                '-c:a aac',
                '-shortest'
              ]);
          }
          break;
        }

        case 'audio_fade':
          let fadeFilter = '';
          if (parsedArgs.type === 'in') {
            fadeFilter = `afade=t=in:st=${parsedArgs.start}:d=${parsedArgs.duration}`;
          } else {
            fadeFilter = `afade=t=out:st=${parsedArgs.start}:d=${parsedArgs.duration}`;
          }
          command = command.audioFilters(fadeFilter).videoCodec('copy');
          break;

        case 'highpass_filter':
          command = command.audioFilters(`highpass=f=${parsedArgs.frequency}`).videoCodec('copy');
          break;

        case 'lowpass_filter':
          command = command.audioFilters(`lowpass=f=${parsedArgs.frequency}`).videoCodec('copy');
          break;

        case 'echo_effect':
          command = command.audioFilters(`aecho=1.0:0.7:${parsedArgs.delay}:${parsedArgs.decay}`).videoCodec('copy');
          break;

        case 'bass_adjustment':
          command = command.audioFilters(`bass=g=${parsedArgs.gain}`).videoCodec('copy');
          break;

        case 'treble_adjustment':
          command = command.audioFilters(`treble=g=${parsedArgs.gain}`).videoCodec('copy');
          break;

        case 'equalizer':
          const width = parsedArgs.width || 200;
          command = command.audioFilters(`equalizer=f=${parsedArgs.frequency}:width_type=h:width=${width}:g=${parsedArgs.gain}`).videoCodec('copy');
          break;

        case 'normalize_audio':
          const target = parsedArgs.target || -16;
          command = command.audioFilters(`loudnorm=I=${target}:TP=-1.5:LRA=11`).videoCodec('copy');
          break;

        case 'delay_audio':
          command = command.audioFilters(`adelay=${parsedArgs.delay}|${parsedArgs.delay}`).videoCodec('copy');
          break;

        case 'audio_chorus':
          const chorusInGain = parsedArgs.in_gain ?? 0.5;
          const chorusOutGain = parsedArgs.out_gain ?? 0.9;
          const chorusDelays = parsedArgs.delays ?? '40|60|80';
          const chorusDecays = parsedArgs.decays ?? '0.4|0.5|0.6';
          const chorusSpeeds = parsedArgs.speeds ?? '0.5|0.6|0.7';
          const chorusDepths = parsedArgs.depths ?? '0.25|0.4|0.35';
          // 't' at the end sets triangular modulation waveform (alternative is 's' for sinusoidal)
          command = command.audioFilters(`chorus=${chorusInGain}:${chorusOutGain}:${chorusDelays}:${chorusDecays}:${chorusSpeeds}:${chorusDepths}:t`).videoCodec('copy');
          break;

        case 'audio_flanger':
          const flangerDelay = parsedArgs.delay ?? 0;
          const flangerDepth = parsedArgs.depth ?? 2;
          const flangerRegen = parsedArgs.regen ?? 0;
          const flangerWidth = parsedArgs.width ?? 71;
          const flangerSpeed = parsedArgs.speed ?? 0.5;
          command = command.audioFilters(`flanger=delay=${flangerDelay}:depth=${flangerDepth}:regen=${flangerRegen}:width=${flangerWidth}:speed=${flangerSpeed}`).videoCodec('copy');
          break;

        case 'audio_phaser':
          const phaserInGain = parsedArgs.in_gain ?? 0.4;
          const phaserOutGain = parsedArgs.out_gain ?? 0.74;
          const phaserDelay = parsedArgs.delay ?? 3;
          const phaserDecay = parsedArgs.decay ?? 0.4;
          const phaserSpeed = parsedArgs.speed ?? 0.5;
          command = command.audioFilters(`aphaser=in_gain=${phaserInGain}:out_gain=${phaserOutGain}:delay=${phaserDelay}:decay=${phaserDecay}:speed=${phaserSpeed}`).videoCodec('copy');
          break;

        case 'audio_vibrato':
          const vibratoFreq = parsedArgs.frequency ?? 5;
          const vibratoDepth = parsedArgs.depth ?? 0.5;
          command = command.audioFilters(`vibrato=f=${vibratoFreq}:d=${vibratoDepth}`).videoCodec('copy');
          break;

        case 'audio_tremolo':
          const tremoloFreq = parsedArgs.frequency ?? 5;
          const tremoloDepth = parsedArgs.depth ?? 0.5;
          command = command.audioFilters(`tremolo=f=${tremoloFreq}:d=${tremoloDepth}`).videoCodec('copy');
          break;

        case 'audio_compressor':
          const compThreshold = parsedArgs.threshold ?? 0;
          const compRatio = parsedArgs.ratio ?? 4;
          const compAttack = parsedArgs.attack ?? 20;
          const compRelease = parsedArgs.release ?? 250;
          command = command.audioFilters(`acompressor=threshold=${compThreshold}dB:ratio=${compRatio}:attack=${compAttack}:release=${compRelease}`).videoCodec('copy');
          break;

        case 'audio_gate':
          const gateThreshold = parsedArgs.threshold ?? -50;
          const gateRatio = parsedArgs.ratio ?? 2;
          const gateAttack = parsedArgs.attack ?? 20;
          const gateRelease = parsedArgs.release ?? 250;
          command = command.audioFilters(`agate=threshold=${gateThreshold}dB:ratio=${gateRatio}:attack=${gateAttack}:release=${gateRelease}`).videoCodec('copy');
          break;

        case 'audio_stereo_widen':
          const stereoDelay = parsedArgs.delay ?? 20;
          const stereoFeedback = parsedArgs.feedback ?? 0.3;
          const stereoCrossfeed = parsedArgs.crossfeed ?? 0.3;
          command = command.audioFilters(`stereowiden=delay=${stereoDelay}:feedback=${stereoFeedback}:crossfeed=${stereoCrossfeed}`).videoCodec('copy');
          break;

        case 'audio_reverse':
          command = command.audioFilters('areverse').videoCodec('copy');
          break;

        case 'audio_limiter':
          const limiterLevel = parsedArgs.level ?? 1.0;
          const limiterAttack = parsedArgs.attack ?? 5;
          const limiterRelease = parsedArgs.release ?? 50;
          // level_in=1 keeps input at unity, limit sets the ceiling to prevent clipping
          command = command.audioFilters(`alimiter=level_in=1:level_out=1:limit=${limiterLevel}:attack=${limiterAttack}:release=${limiterRelease}`).videoCodec('copy');
          break;

        case 'audio_silence_remove':
          const startThreshold = parsedArgs.start_threshold ?? -50;
          const startDuration = parsedArgs.start_duration ?? 0.5;
          const stopThreshold = parsedArgs.stop_threshold ?? -50;
          const stopDuration = parsedArgs.stop_duration ?? 0.5;
          command = command.audioFilters(`silenceremove=start_periods=1:start_threshold=${startThreshold}dB:start_duration=${startDuration}:stop_periods=-1:stop_threshold=${stopThreshold}dB:stop_duration=${stopDuration}`).videoCodec('copy');
          break;

        case 'audio_pan':
          const panValue = parsedArgs.pan;
          // Convert -1 to 1 range to FFmpeg pan filter format
          // For stereo output: pan=stereo|c0=c0*left_factor+c1*cross_factor|c1=c1*right_factor+c0*cross_factor
          let leftGain, rightGain;
          if (panValue < 0) {
            // Pan left: reduce right channel
            leftGain = 1.0;
            rightGain = 1.0 + panValue;  // panValue is negative, so this reduces right
          } else if (panValue > 0) {
            // Pan right: reduce left channel
            leftGain = 1.0 - panValue;
            rightGain = 1.0;
          } else {
            // Center
            leftGain = 1.0;
            rightGain = 1.0;
          }
          command = command.audioFilters(`pan=stereo|c0=${leftGain}*c0|c1=${rightGain}*c1`).videoCodec('copy');
          break;

        case 'adjust_brightness':
          command = command.videoFilters(`eq=brightness=${parsedArgs.brightness}`).audioCodec('copy');
          break;

        case 'adjust_hue':
          command = command.videoFilters(`hue=h=${parsedArgs.degrees}`).audioCodec('copy');
          break;

        case 'adjust_saturation':
          command = command.videoFilters(`eq=saturation=${parsedArgs.saturation}`).audioCodec('copy');
          break;

        case 'convert_video_format': {
          const targetFormat = parsedArgs.format;
          const codec = parsedArgs.codec && parsedArgs.codec !== 'auto' ? parsedArgs.codec : null;
          if (codec) {
            command = command.videoCodec(codec).audioCodec('copy');
          } else {
            command = command.outputOptions('-c copy');
          }
          command = command.toFormat(targetFormat);
          break;
        }

        case 'convert_audio_format': {
          const audioBitrate = parsedArgs.bitrate || '192k';
          command = command.noVideo().toFormat(parsedArgs.format).audioBitrate(audioBitrate);
          break;
        }

        case 'extract_audio': {
          const extractBitrate = parsedArgs.bitrate || '192k';
          command = command.noVideo().toFormat(parsedArgs.format || 'mp3').audioBitrate(extractBitrate);
          break;
        }

        case 'fade_transition':
          // Simple fade in/out effect for a single video
          const duration = parsedArgs.duration || 1;
          command = command.videoFilters(`fade=t=in:st=0:d=${duration},fade=t=out:st=${parsedArgs.totalDuration - duration}:d=${duration}`).audioCodec('copy');
          break;

        case 'crossfade_transition':
          // Crossfade between two videos - requires special handling with complex filtergraph
          // This requires two input videos which will be handled separately below
          reject(new Error('crossfade_transition requires special multi-video handling'));
          return;

        default:
          reject(new Error(`Unknown operation: ${operation}`));
          return;
      }

      command
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    // Handle metadata response
    if (result && result.isMetadata) {
      // Clean up input file
      await fs.unlink(inputPath);
      if (audioInputPath) {
        await fs.unlink(audioInputPath);
      }

      // Send metadata as JSON
      res.json(result.metadata);
      return;
    }

    // Read the processed video
    const processedVideo = await fs.readFile(outputPath);

    // Clean up temporary files
    await fs.unlink(inputPath);
    await fs.unlink(outputPath);
    if (audioInputPath) {
      await fs.unlink(audioInputPath);
    }

    // Send the processed video
    const AUDIO_CONTENT_TYPES = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      aac: 'audio/aac',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
      m4a: 'audio/mp4',
      wma: 'audio/x-ms-wma'
    };
    const VIDEO_CONTENT_TYPES = {
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      avi: 'video/x-msvideo',
      mkv: 'video/x-matroska',
      flv: 'video/x-flv',
      ogv: 'video/ogg'
    };
    const audioOnlyOps = ['convert_audio_format', 'extract_audio'];
    let contentType = 'video/mp4';
    if (audioOnlyOps.includes(operation)) {
      contentType = AUDIO_CONTENT_TYPES[outputExt] || 'application/octet-stream';
    } else if (operation === 'convert_video_format') {
      contentType = VIDEO_CONTENT_TYPES[outputExt] || 'video/mp4';
    }
    res.set('Content-Type', contentType);
    res.send(processedVideo);

  } catch (error) {
    console.error('Error processing video:', error);

    // Clean up on error
    if (inputPath) {
      try { await fs.unlink(inputPath); } catch (e) { /* ignore */ }
    }
    if (outputPath) {
      try { await fs.unlink(outputPath); } catch (e) { /* ignore */ }
    }
    if (audioInputPath) {
      try { await fs.unlink(audioInputPath); } catch (e) { /* ignore */ }
    }

    res.status(500).json({ error: error.message || 'Failed to process video' });
  }
});

// Multi-video transition endpoint
app.post('/api/transition-videos', videoProcessLimiter, requireAuthenticatedUser, requireActiveSubscription, upload.array('videos', 10), async (req, res) => {
  const tempFiles = [];
  let outputPath = null;

  try {
    const { transition, duration } = req.body;

    if (!req.files || req.files.length < 2) {
      return res.status(400).json({ error: 'At least two video files are required for transitions' });
    }

    if (!transition) {
      return res.status(400).json({ error: 'No transition type specified' });
    }

    // Parse duration if it's a string
    const transitionDuration = duration ? parseFloat(duration) : 1;

    // Create temporary files
    const tmpDir = '/tmp';
    
    // Write uploaded files to disk
    const inputPaths = [];
    for (let i = 0; i < req.files.length; i++) {
      const inputPath = path.join(tmpDir, `input-${randomUUID()}-${i}.mp4`);
      await fs.writeFile(inputPath, req.files[i].buffer);
      inputPaths.push(inputPath);
      tempFiles.push(inputPath);
    }

    outputPath = path.join(tmpDir, `output-${randomUUID()}.mp4`);

    // Check which videos have audio streams
    const hasAudio = await Promise.all(
      inputPaths.map(inputPath => checkHasAudioStream(inputPath))
    );

    // Process videos with transition
    await new Promise((resolve, reject) => {
      let command = ffmpeg();
      
      // Add all inputs
      inputPaths.forEach(inputPath => {
        command = command.input(inputPath);
      });

      let filterComplex = '';
      let outputLabels = [];

      switch (transition) {
        case 'crossfade':
          // Build crossfade filter chain for all videos
          // For 2 videos: [0:v][1:v]xfade=transition=fade:duration=1:offset=<video0_duration-1>[v]
          // For 3+ videos: chain multiple xfades
          filterComplex = buildCrossfadeFilter(inputPaths.length, transitionDuration, hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'wipe_left':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'wipeleft', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'wipe_right':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'wiperight', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'wipe_up':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'wipeup', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'wipe_down':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'wipedown', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'slide_left':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'slideleft', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'slide_right':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'slideright', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'slide_up':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'slideup', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'slide_down':
          filterComplex = buildWipeFilter(inputPaths.length, transitionDuration, 'slidedown', hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'dissolve':
          // Dissolve is similar to crossfade with fade transition
          filterComplex = buildCrossfadeFilter(inputPaths.length, transitionDuration, hasAudio, 'dissolve');
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        case 'fade':
          // Fade to black between clips
          filterComplex = buildFadeFilter(inputPaths.length, transitionDuration, hasAudio);
          outputLabels = hasAudio.some(h => h) ? ['v', 'a'] : ['v'];
          command = command.complexFilter(filterComplex, outputLabels);
          break;

        default:
          reject(new Error(`Unknown transition type: ${transition}`));
          return;
      }

      command
        .output(outputPath)
        .outputOptions('-map', '[v]');
      
      // Only map audio if at least one video has audio
      if (hasAudio.some(h => h)) {
        command.outputOptions('-map', '[a]').audioCodec('aac');
      }
      
      command
        .videoCodec('libx264')
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    // Read the processed video
    const processedVideo = await fs.readFile(outputPath);

    // Clean up temporary files
    for (const tempFile of tempFiles) {
      await fs.unlink(tempFile);
    }
    await fs.unlink(outputPath);

    // Send the processed video
    res.set('Content-Type', 'video/mp4');
    res.send(processedVideo);

  } catch (error) {
    console.error('Error processing video transition:', error);

    // Clean up on error
    for (const tempFile of tempFiles) {
      try { await fs.unlink(tempFile); } catch (e) { /* ignore */ }
    }
    if (outputPath) {
      try { await fs.unlink(outputPath); } catch (e) { /* ignore */ }
    }

    res.status(500).json({ error: error.message || 'Failed to process video transition' });
  }
});

// Helper function to check if a video has audio stream
async function checkHasAudioStream(inputPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        // If ffprobe fails, assume no audio
        resolve(false);
        return;
      }
      
      // Check if there's any audio stream
      const hasAudio = metadata.streams && metadata.streams.some(stream => stream.codec_type === 'audio');
      resolve(hasAudio);
    });
  });
}

// Helper function to build crossfade filter
function buildCrossfadeFilter(numVideos, duration, hasAudio, transition = 'fade') {
  if (numVideos < 2) {
    throw new Error('At least 2 videos required for crossfade');
  }

  let filters = [];
  let audioFilters = [];
  
  // Simple concatenation approach
  // For proper crossfade with xfade filter, we would need video durations
  // This implementation uses basic concat which is simpler and more reliable
  
  // Check if any video has audio
  const anyHasAudio = hasAudio.some(h => h);
  
  if (anyHasAudio) {
    // If some videos have audio and some don't, add silent audio to those without
    const allHasAudio = hasAudio.every(h => h);
    
    if (!allHasAudio) {
      // Generate silent audio for videos without audio
      for (let i = 0; i < numVideos; i++) {
        if (!hasAudio[i]) {
          // Add silent audio track
          filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100[silent${i}]`);
        }
      }
    }
    
    // Build video concat
    let videoInputs = Array.from({length: numVideos}, (_, i) => `[${i}:v]`).join('');
    filters.push(`${videoInputs}concat=n=${numVideos}:v=1:a=0[v]`);
    
    // Build audio concat with proper audio sources
    let audioInputs = Array.from({length: numVideos}, (_, i) => {
      return hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
    }).join('');
    audioFilters.push(`${audioInputs}concat=n=${numVideos}:v=0:a=1[a]`);
  } else {
    // No videos have audio - only concat video streams
    let videoInputs = Array.from({length: numVideos}, (_, i) => `[${i}:v]`).join('');
    filters.push(`${videoInputs}concat=n=${numVideos}:v=1:a=0[v]`);
  }
  
  return [...filters, ...audioFilters].join(';');
}

// Helper function to build wipe/slide filter
function buildWipeFilter(numVideos, duration, transition, hasAudio) {
  if (numVideos < 2) {
    throw new Error('At least 2 videos required for wipe transition');
  }

  // Simple concatenation - for actual wipe effects, we would need xfade filter with offsets
  let filters = [];
  let audioFilters = [];
  
  // Check if any video has audio
  const anyHasAudio = hasAudio.some(h => h);
  
  if (anyHasAudio) {
    // If some videos have audio and some don't, add silent audio to those without
    const allHasAudio = hasAudio.every(h => h);
    
    if (!allHasAudio) {
      // Generate silent audio for videos without audio
      for (let i = 0; i < numVideos; i++) {
        if (!hasAudio[i]) {
          // Add silent audio track
          filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100[silent${i}]`);
        }
      }
    }
    
    // Build video concat
    let videoInputs = Array.from({length: numVideos}, (_, i) => `[${i}:v]`).join('');
    filters.push(`${videoInputs}concat=n=${numVideos}:v=1:a=0[v]`);
    
    // Build audio concat with proper audio sources
    let audioInputs = Array.from({length: numVideos}, (_, i) => {
      return hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
    }).join('');
    audioFilters.push(`${audioInputs}concat=n=${numVideos}:v=0:a=1[a]`);
  } else {
    // No videos have audio - only concat video streams
    let videoInputs = Array.from({length: numVideos}, (_, i) => `[${i}:v]`).join('');
    filters.push(`${videoInputs}concat=n=${numVideos}:v=1:a=0[v]`);
  }
  
  return [...filters, ...audioFilters].join(';');
}

// Helper function to build fade to black filter
function buildFadeFilter(numVideos, duration, hasAudio) {
  if (numVideos < 2) {
    throw new Error('At least 2 videos required for fade transition');
  }

  let filters = [];
  let audioFilters = [];
  
  // Apply fade in to first video and fade out to last video
  // For middle videos, we'll just concatenate normally
  // Note: For proper timing, we would need to get video durations via ffprobe first
  let videoLabels = [];
  let audioLabels = [];
  
  // Check if any video has audio
  const anyHasAudio = hasAudio.some(h => h);
  
  // If some videos have audio and some don't, add silent audio to those without
  if (anyHasAudio && !hasAudio.every(h => h)) {
    for (let i = 0; i < numVideos; i++) {
      if (!hasAudio[i]) {
        filters.push(`anullsrc=channel_layout=stereo:sample_rate=44100[silent${i}]`);
      }
    }
  }
  
  for (let i = 0; i < numVideos; i++) {
    const vLabel = `v${i}fade`;
    const aLabel = `a${i}fade`;
    
    if (i === 0 && numVideos === 2) {
      // First video in a 2-video sequence: only fade out
      // We'll skip the fade for simplicity since we don't know duration
      filters.push(`[${i}:v]copy[${vLabel}]`);
      if (anyHasAudio) {
        const audioSource = hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
        audioFilters.push(`${audioSource}acopy[${aLabel}]`);
      }
    } else if (i === 0) {
      // First video: no fade needed at start, just copy
      filters.push(`[${i}:v]copy[${vLabel}]`);
      if (anyHasAudio) {
        const audioSource = hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
        audioFilters.push(`${audioSource}acopy[${aLabel}]`);
      }
    } else if (i === numVideos - 1) {
      // Last video: fade in at start
      filters.push(`[${i}:v]fade=t=in:st=0:d=${duration}[${vLabel}]`);
      if (anyHasAudio) {
        const audioSource = hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
        audioFilters.push(`${audioSource}afade=t=in:st=0:d=${duration}[${aLabel}]`);
      }
    } else {
      // Middle videos: fade in at start
      filters.push(`[${i}:v]fade=t=in:st=0:d=${duration}[${vLabel}]`);
      if (anyHasAudio) {
        const audioSource = hasAudio[i] ? `[${i}:a]` : `[silent${i}]`;
        audioFilters.push(`${audioSource}afade=t=in:st=0:d=${duration}[${aLabel}]`);
      }
    }
    
    videoLabels.push(`[${vLabel}]`);
    if (anyHasAudio) {
      audioLabels.push(`[${aLabel}]`);
    }
  }
  
  filters.push(`${videoLabels.join('')}concat=n=${numVideos}:v=1:a=0[v]`);
  if (anyHasAudio) {
    audioFilters.push(`${audioLabels.join('')}concat=n=${numVideos}:v=0:a=1[a]`);
  }
  
  return [...filters, ...audioFilters].join(';');
}

// Stripe checkout session creation endpoint
app.post('/api/create-checkout-session', apiLimiter, async (req, res) => {
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

// Verify checkout session endpoint
app.post('/api/verify-checkout-session', apiLimiter, async (req, res) => {
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
          const { updateUserSubscription } = await import('./src/db.js');
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
