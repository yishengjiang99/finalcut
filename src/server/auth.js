import express from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import { findUserByGoogleId, findUserByEmail, createUser, createApiToken } from '../db.js';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL,
  GOOGLE_IOS_CLIENT_ID,
  SESSION_SECRET,
  stripe,
  ALLOW_UNAUTH_SAMPLE_MODE,
  SAMPLE_TOKEN_TTL_MS,
  MOBILE_ACCESS_TOKEN_TTL_MS,
} from './config.js';
import {
  apiLimiter,
  issueSampleAccessToken,
  attachBearerUser,
  extractBearerToken,
} from './middleware.js';

/**
 * Configure session middleware and Passport on the Express app.
 * Must be called before registering auth routes.
 */
export function setupAuth(app) {
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  }));

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
                const pool = (await import('../db.js')).getPool();
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
        const pool = (await import('../db.js')).getPool();
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
}

/**
 * Upsert a user from a verified Google identity (shared by web Passport + mobile).
 */
async function upsertGoogleUser({ googleId, email, name }) {
  let user = await findUserByGoogleId(googleId);

  if (!user && email) {
    user = await findUserByEmail(email);
    if (user && !user.google_id) {
      const pool = (await import('../db.js')).getPool();
      await pool.query('UPDATE users SET google_id = ? WHERE id = ?', [googleId, user.id]);
      user.google_id = googleId;
    }
  }

  if (!user) {
    user = await createUser({
      email: email || `${googleId}@google.com`,
      google_id: googleId,
      name: name || null,
      has_subscription: false,
    });
    if (!user || !user.id) {
      throw new Error('Failed to create user');
    }
  }

  user.has_subscription = Boolean(user.has_subscription);
  return user;
}

/**
 * Verify a Google ID token via Google's tokeninfo endpoint.
 * Accepts web (GOOGLE_CLIENT_ID) and iOS (GOOGLE_IOS_CLIENT_ID) audiences.
 */
async function verifyGoogleIdToken(idToken) {
  const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
  const response = await fetch(url);
  if (!response.ok) {
    const err = new Error('Invalid Google idToken');
    err.statusCode = 401;
    throw err;
  }
  const payload = await response.json();
  if (payload.error) {
    const err = new Error(payload.error_description || payload.error || 'Invalid Google idToken');
    err.statusCode = 401;
    throw err;
  }

  const allowedAudiences = [GOOGLE_CLIENT_ID, GOOGLE_IOS_CLIENT_ID].filter(Boolean);
  if (!allowedAudiences.length) {
    const err = new Error('Google OAuth is not configured');
    err.statusCode = 503;
    throw err;
  }
  if (!allowedAudiences.includes(payload.aud)) {
    const err = new Error('Invalid token audience');
    err.statusCode = 401;
    throw err;
  }

  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (payload.email && !emailVerified) {
    const err = new Error('Email not verified');
    err.statusCode = 401;
    throw err;
  }

  return {
    googleId: payload.sub,
    email: payload.email || null,
    name: payload.name || payload.email || null,
  };
}

const router = express.Router();

/**
 * Mobile: Google Sign-In SDK idToken → Bearer accessToken.
 * Additive — does not change web cookie/session OAuth.
 *
 * POST /api/auth/mobile/google
 * Body: { "idToken": "<google id token>" }
 * Response: { accessToken, expiresIn, tokenType, user: { email, name, hasSubscription } }
 */
router.post('/api/auth/mobile/google', apiLimiter, async (req, res) => {
  try {
    const idToken = req.body?.idToken;
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'idToken is required' });
    }

    const identity = await verifyGoogleIdToken(idToken.trim());
    const user = await upsertGoogleUser(identity);
    const { token, expiresInMs } = await createApiToken(user.id, MOBILE_ACCESS_TOKEN_TTL_MS);

    return res.json({
      accessToken: token,
      expiresIn: expiresInMs,
      tokenType: 'Bearer',
      user: {
        email: user.email,
        name: user.name,
        hasSubscription: Boolean(user.has_subscription),
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) {
      console.error('Mobile Google auth error:', error);
    }
    return res.status(status).json({
      error: status >= 500 ? 'Authentication failed' : (error.message || 'Authentication failed'),
    });
  }
});

router.get('/api/sample-access-token', apiLimiter, (req, res) => {

  if (!ALLOW_UNAUTH_SAMPLE_MODE) {
    return res.status(403).json({ error: 'Sample mode is disabled' });
  }
  const token = issueSampleAccessToken();
  res.json({ token, expiresInMs: SAMPLE_TOKEN_TTL_MS });
});

router.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/auth/google/callback',
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

router.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('Logout error:', err);
    }
    res.redirect('/');
  });
});

router.get('/api/auth/status', apiLimiter, async (req, res) => {
  try {
    // Bearer path (iOS / API clients)
    if (extractBearerToken(req)) {
      try {
        await attachBearerUser(req);
      } catch (error) {
        if (error.statusCode === 401) {
          return res.json({ authenticated: false });
        }
        throw error;
      }
      return res.json({
        authenticated: true,
        authMethod: 'bearer',
        user: {
          email: req.user.email,
          name: req.user.name,
          hasSubscription: Boolean(req.user.has_subscription),
        },
      });
    }

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

      return res.json({
        authenticated: true,
        authMethod: 'session',
        user: {
          email: req.user.email,
          name: req.user.name,
          hasSubscription: req.user.has_subscription,
        },
      });
    }

    return res.json({ authenticated: false });
  } catch (error) {
    console.error('Error in /api/auth/status:', error);
    return res.status(500).json({ error: 'Failed to check auth status' });
  }
});

export { router as authRouter };
