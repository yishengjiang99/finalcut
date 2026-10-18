import express from 'express';
import cors from 'cors';
import { initDatabase } from './src/db.js';
import { PORT, stripe, nodeEnvWarning } from './src/server/config.js';
import { setupAuth, authRouter } from './src/server/auth.js';
import { MySQLSessionStore } from './src/server/sessionStore.js';
import { stripeWebhookRouter, stripeRouter } from './src/server/stripe.js';
import { captionsRouter } from './src/server/captions.js';
import { videoRouter } from './src/server/video.js';
import { ffmpegCliRouter } from './server/tools/ffmpeg-cli-tool.js';
import { chatRouter } from './src/server/chat.js';
import { jobsRouter, pendingJobCount, waitForJobsToSettle } from './src/server/jobs.js';
import { lyricCaptionsRouter } from './src/server/lyricCaptions.js';
import { streamingCaptionsRouter } from './src/server/streamingCaptions.js';
import { createHealthRouter } from './src/server/health.js';
import { iosSuggestionsRouter } from './src/server/iosSuggestions.js';
import { iosSuggestionsAdminRouter } from './src/server/iosSuggestionsAdmin.js';
import { v2Router } from './src/server/v2.js';
import { telemetryRouter, scheduleTelemetryPurge } from './src/server/telemetry.js';
import { pushRouter, getPushStore } from './src/server/push/router.js';
import { scheduleLifecycle } from './src/server/push/lifecycle.js';

const app = express();

const nodeEnvWarningText = nodeEnvWarning();
if (nodeEnvWarningText) console.warn(nodeEnvWarningText);

// Trust proxy headers (required when behind nginx/reverse proxy)
// Enable for production or when TRUST_PROXY environment variable is set
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Health check first: no auth, no session, no rate limit, no quota.
// ffmpeg + commit are probed once here at startup.
app.use(createHealthRouter());

// iOS suggestion pills: public, pre-login, no session/DB (own rate limiter).
app.use(iosSuggestionsRouter);
// Admin API for the pills (404 while ADMIN_API_TOKEN is unset; own small JSON parser, rate limits).
app.use(iosSuggestionsAdminRouter);

// Anonymous first-party telemetry: before the session middleware so it never sets a cookie
// (own small JSON parser + rate limiter; stores no IP). See src/server/telemetry.js.
app.use(telemetryRouter);
if (process.env.NODE_ENV !== 'test') scheduleTelemetryPurge();

let sessionStore;
try {
  await initDatabase();
  sessionStore = new MySQLSessionStore();
} catch (error) {
  console.warn('WARNING: Could not initialize database. Google login features may not work.');
  console.warn('Error:', error.message);
  console.warn('WARNING: Login sessions are kept in memory and will not survive a restart.');
}

// Configure session middleware, Passport, and Google OAuth strategy
setupAuth(app, { sessionStore });

// Stripe webhook endpoint must be mounted before JSON body parsing
// so Stripe signature verification receives the raw body.
app.use(stripeWebhookRouter);

app.use(express.json({ limit: '950mb' }));

app.use(authRouter);
app.use(stripeRouter);
app.use(captionsRouter);
app.use(videoRouter);
app.use(ffmpegCliRouter);
app.use(chatRouter);
app.use(jobsRouter);
app.use(lyricCaptionsRouter);
app.use(streamingCaptionsRouter);
app.use(v2Router);
// Push notifications (token registration, lifecycle; dry-run by default). See docs/push-lifecycle.md.
app.use(pushRouter);
scheduleLifecycle(getPushStore);

const httpServer = app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
  console.log('Configuration loaded successfully');
  console.log('FFmpeg video processing endpoint available at /api/process-video');
  console.log('Async job endpoints: POST /api/jobs/process-video, GET /api/jobs/:id');
  if (stripe) {
    console.log('Stripe payment endpoints available:');
    console.log('  - POST /api/create-checkout-session');
    console.log('  - POST /api/verify-checkout-session');
    console.log('  - POST /api/stripe-webhook');
  } else {
    console.log('Stripe payment endpoints are disabled (STRIPE_SECRET_KEY not set)');
  }
});

// Graceful stop (systemd sends SIGTERM on every deploy restart). Jobs live in this process's memory,
// so keep serving until running jobs have finished and their results were picked up (at most 45 s),
// then close. A second signal exits at once.
let shuttingDown = false;
process.on('SIGTERM', async () => {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  const pending = pendingJobCount();
  if (pending) console.log(`SIGTERM: waiting up to 45s for ${pending} job(s) to finish before exit`);
  const left = await waitForJobsToSettle({ maxMs: 45_000 });
  console.log(left ? `SIGTERM: exiting with ${left} job(s) still pending` : 'SIGTERM: exiting');
  setTimeout(() => process.exit(0), 5_000).unref();
  httpServer.close(() => process.exit(0));
});
