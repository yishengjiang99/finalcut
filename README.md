# FinalCut - Video Editor Chat

A React-based video editing application with AI chat capabilities using xAI's Grok API and server-side FFmpeg processing.

## Features

- **Google OAuth Authentication** - Secure login with Google accounts
- **Subscription Management** - Stripe integration for subscription payments
- Upload and edit videos in the browser
- AI-powered video editing through natural language chat
- **Server-side FFmpeg processing** for reliable video operations
- **MySQL Database** - User and subscription data storage
- Video operations:
  - Resize video
  - Crop video
  - Rotate video
  - Add text overlays
  - Trim video
  - Adjust playback speed
- **Transitions Between Clips**:
  - Crossfade - Smooth blend between clips
  - Fade - Fade to black between clips
  - Dissolve - Gradual transition effect
  - Wipe (left, right, up, down) - Directional wipe transitions
  - Slide (left, right, up, down) - Sliding transitions
  - Multi-clip support for creating montages
  - Customizable transition duration
- Audio filters:
  - Adjust audio volume
  - Audio fade in/out effects
  - High-pass filter (remove low frequencies)
  - Low-pass filter (remove high frequencies)
  - Echo effect
  - Bass adjustment
  - Treble adjustment
  - Parametric equalizer
  - Audio normalization
  - Audio delay/sync
  - Chorus effect (rich, layered sound)
  - Flanger effect (sweeping whoosh sound)
  - Phaser effect (sweeping phase-shift sound)
  - Vibrato (pitch modulation)
  - Tremolo (volume modulation)
  - Compressor (dynamic range compression)
  - Gate (noise reduction)
  - Stereo widener (enhance stereo image)
  - Reverse audio (play backwards)
  - Limiter (prevent clipping)
  - Silence removal (trim silent parts)
  - Pan (stereo positioning)
- Video filters:
  - Adjust brightness
  - Adjust hue
  - Adjust saturation
- Powered by native FFmpeg on the server for fast, reliable processing
- Integration with xAI's Grok API for intelligent editing assistance

## Development

### Prerequisites

- Node.js 18 or higher
- npm
- **FFmpeg installed on the system** (for server-side processing)
- **MySQL server** (for user authentication and subscription management)
- xAI API token (get one from https://console.x.ai/)
- Google OAuth credentials (from Google Cloud Console)
- Stripe API keys for subscription processing

### FFmpeg Installation

#### Ubuntu/Debian:
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

#### macOS:
```bash
brew install ffmpeg
```

#### Windows:
Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH.

### Installation

```bash
npm install
```

### Configuration

#### Quick Setup

For a step-by-step quick start guide, see **[docs/QUICKSTART.md](./docs/QUICKSTART.md)**.

For detailed authentication setup, see **[docs/GOOGLE_AUTH_SETUP.md](./docs/GOOGLE_AUTH_SETUP.md)**.

#### Manual Configuration

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Edit `.env` and add your credentials:
```bash
# Required
XAI_API_TOKEN=your_actual_token_here
SESSION_SECRET=generate_random_32_char_string
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# MySQL Database
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=finalcut

# Stripe
STRIPE_SECRET_KEY=sk_test_your_secret_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here
STRIPE_SUBSCRIPTION_PRICE_ID=price_your_price_id
```

See [docs/STRIPE.md](./docs/STRIPE.md) for detailed Stripe integration documentation.
See [docs/GOOGLE_AUTH_SETUP.md](./docs/GOOGLE_AUTH_SETUP.md) for Google OAuth setup.

**Important**: Never commit your `.env` file to version control. It's already included in `.gitignore`.

### Development Server

You need to run both the proxy server and the Vite dev server:

**Terminal 1 - Start the proxy server:**
```bash
npm run server
```

**Terminal 2 - Start the Vite dev server:**
```bash
npm run dev
```

The app will be available at `http://localhost:5173`

The proxy server runs on `http://localhost:3001` and handles xAI API calls securely.

### Build

```bash
npm run build
```

The built files will be in the `dist/` directory.

### Testing

```bash
npm test
```

Run tests with Vitest.

## Usage

### First Time Setup

1. Complete the configuration steps above
2. Ensure MySQL server is running
3. Start the server (it will automatically initialize the database)

### Running the Application

1. Start the server (which serves both the API proxy and handles video processing):
   ```bash
   npm run server
   ```
2. Open your browser to `http://localhost:3001`
3. Click "Get Started" and sign in with your Google account
4. Complete the subscription payment (use test card in test mode)
5. Upload a video file or use the "Try with Sample Video" button
6. Describe the edits you want in natural language
7. The AI will apply the appropriate filters and transformations using server-side FFmpeg
8. A spinner will display while ffmpeg is processing your video

### Generate Captions (AI Subtitles)

The app can automatically generate subtitles from your video's audio using AI speech-to-text. It can also translate captions to a second language and burn one or two subtitle tracks into the video.

What you get:
- Downloadable subtitle files (`.srt` and `.vtt`)
- Optional burned-in subtitles in the exported video
- Optional translated subtitle track (shown opposite the original track position)

#### Sample Prompt Text (copy/paste)

```text
Generate captions for this video.
```

```text
Generate English captions for this video and burn them into the video.
```

```text
Generate captions, translate them to Spanish, and put Spanish at the top with the original captions at the bottom.
```

```text
Generate captions in auto-detect mode, use yellow subtitle style, and place them at the top.
```

```text
Generate captions but do not burn them into the video. I only want SRT and VTT files.
```

Tips:
- Mention a language code or language name (for example: English/`en`, Spanish/`es`, French/`fr`)
- Ask for translation to create bilingual captions
- Ask for subtitle style (`default`, `white_on_black`, or `yellow`)
- Ask for position (`top` or `bottom`)

### Sample Video

The application includes a "Try with Sample Video" feature on the landing page. To use this feature, you need to place a file named `BigBuckBunny.mp4` in the `finalcut/public/` directory.

You can download Big Buck Bunny (a free sample video) from:
```bash
cd finalcut/public
curl -o BigBuckBunny.mp4 "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
```

Alternatively, you can use any MP4 video file and name it `BigBuckBunny.mp4`.

## More Documentation

For deeper technical and deployment details, see:

- **[docs/QUICKSTART.md](./docs/QUICKSTART.md)** - Quick setup guide
- **[docs/FUNCTIONALITY.md](./docs/FUNCTIONALITY.md)** - Feature overview
- **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** - Deployment guide
- **[docs/QUICK-REFERENCE.md](./docs/QUICK-REFERENCE.md)** - Deployment quick reference

## License

This project is part of the yishengjiang99/pages repository.
