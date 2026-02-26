import express from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import { findUserByGoogleId, findUserByEmail, createUser } from '../db.js';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK_URL,
  SESSION_SECRET,
  stripe,
} from './config.js';
import { apiLimiter, issueSampleAccessToken } from './middleware.js';
import { ALLOW_UNAUTH_SAMPLE_MODE, SAMPLE_TOKEN_TTL_MS } from './config.js';

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

const router = express.Router();

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

router.get('/api/auth/status', apiLimiter, (req, res) => {
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

export { router as authRouter };
