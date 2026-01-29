import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const XAI_API_TOKEN = process.env.XAI_API_TOKEN;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

if (!XAI_API_TOKEN) {
  console.error('ERROR: XAI_API_TOKEN environment variable is not set');
  console.error('Please create a .env file with XAI_API_TOKEN=your_token_here');
  process.exit(1);
}

if (!STRIPE_SECRET_KEY) {
  console.warn('WARNING: STRIPE_SECRET_KEY environment variable is not set');
  console.warn('Stripe payment endpoints will not be available');
}

// Initialize Stripe only if the secret key is available
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

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

// Configure multer for file uploads (store in memory)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// app.use(cors({
//   origin: process.env.NODE_ENV === 'production' 
//     ? process.env.ALLOWED_ORIGINS?.split(',') || []
//     : ['http://localhost:5173', 'http://localhost:3000']
// }));
app.use(express.json({ limit: '950mb' }));

// Proxy endpoint for xAI API
app.post('/api/chat', apiLimiter, async (req, res) => {
  try {
    // Basic request validation
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    // Update the model to grok-3
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_TOKEN}`
      },
      body: JSON.stringify({
        ...req.body,
        model: 'grok-3' // Specify the new model here
      })
    });

    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json({ error: error.message });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Video processing endpoint
app.post('/api/process-video', videoProcessLimiter, upload.single('video'), async (req, res) => {
  let inputPath = null;
  let outputPath = null;

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
    const timestamp = Date.now();
    inputPath = path.join(tmpDir, `input-${timestamp}.mp4`);
    outputPath = path.join(tmpDir, `output-${timestamp}.mp4`);

    // Write uploaded file to disk
    await fs.writeFile(inputPath, req.file.buffer);

    // Process video based on operation
    const result = await new Promise((resolve, reject) => {
      let command = ffmpeg(inputPath);

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

        case 'adjust_brightness':
          command = command.videoFilters(`eq=brightness=${parsedArgs.brightness}`).audioCodec('copy');
          break;

        case 'adjust_hue':
          command = command.videoFilters(`hue=h=${parsedArgs.degrees}`).audioCodec('copy');
          break;

        case 'adjust_saturation':
          command = command.videoFilters(`eq=saturation=${parsedArgs.saturation}`).audioCodec('copy');
          break;

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

      // Send metadata as JSON
      res.json(result.metadata);
      return;
    }

    // Read the processed video
    const processedVideo = await fs.readFile(outputPath);

    // Clean up temporary files
    await fs.unlink(inputPath);
    await fs.unlink(outputPath);

    // Send the processed video
    res.set('Content-Type', 'video/mp4');
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

    res.status(500).json({ error: error.message || 'Failed to process video' });
  }
});

// Stripe checkout session creation endpoint
app.post('/api/create-checkout-session', apiLimiter, async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured on this server' });
  }

  try {
    const { priceId, successUrl, cancelUrl } = req.body;

    if (!priceId || !successUrl || !cancelUrl) {
      return res.status(400).json({ 
        error: 'Missing required fields: priceId, successUrl, and cancelUrl are required' 
      });
    }

    // Create a Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
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

// Stripe webhook endpoint for handling payment events
// This endpoint needs to be registered in your Stripe dashboard
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured on this server' });
  }

  const sig = req.headers['stripe-signature'];

  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn('WARNING: STRIPE_WEBHOOK_SECRET is not set, skipping signature verification');
    // In development, you might want to process webhooks without verification
    // In production, this should always be verified
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
        // TODO: Fulfill the order, grant access, etc.
        // You can access session.customer_email, session.amount_total, etc.
        break;

      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        console.log('PaymentIntent successful:', paymentIntent.id);
        // TODO: Handle successful payment
        break;

      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        console.log('Payment failed:', failedPayment.id);
        // TODO: Handle failed payment
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Return a response to acknowledge receipt of the event
    res.json({ received: true });
  } catch (error) {
    console.error('Error handling webhook event:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
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
