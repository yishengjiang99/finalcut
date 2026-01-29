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

### Sample Video

The application includes a "Try with Sample Video" feature on the landing page. To use this feature, you need to place a file named `BigBuckBunny.mp4` in the `finalcut/public/` directory.

You can download Big Buck Bunny (a free sample video) from:
```bash
cd finalcut/public
curl -o BigBuckBunny.mp4 "http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
```

Alternatively, you can use any MP4 video file and name it `BigBuckBunny.mp4`.

## Architecture

FinalCut now uses **server-side FFmpeg processing** for improved reliability and performance:

- **Client (React)**: Handles UI, chat interface, and file uploads
- **Server (Node.js + Express)**: 
  - Proxies requests to xAI API (keeping API token secure)
  - Processes videos using native FFmpeg via fluent-ffmpeg library
  - Returns processed videos to the client

### Benefits of Server-Side Processing

- ✅ **More Reliable**: Uses native FFmpeg instead of WebAssembly
- ✅ **Better Performance**: Native code is faster than WASM
- ✅ **No Browser Limitations**: No memory constraints or CORS issues
- ✅ **Works Everywhere**: Compatible with all browsers without special headers
- ✅ **Easier Debugging**: Server-side logs make troubleshooting simpler

## Security

The xAI API token is securely stored on the server side and never exposed to the client. The token is read from the `.env` file and used by the Node.js server to authenticate requests to the xAI API.

Video files are processed on the server and immediately cleaned up after processing, ensuring no data persists on the server.

## Technology Stack

- **React 18** - UI framework
- **Vite** - Build tool and dev server
- **Node.js + Express** - Server and API
- **Passport.js** - Google OAuth authentication
- **MySQL** - User and subscription data storage
- **Stripe** - Subscription payment processing
- **FFmpeg (native)** - Server-side video processing via fluent-ffmpeg
- **Multer** - File upload handling
- **xAI Grok API** - AI-powered editing assistance
- **Vitest** - Testing framework
- **React Testing Library** - Component testing

## Project Structure

```
finalcut/
├── src/
│   ├── App.jsx           # Main React component
│   ├── main.jsx          # Application entry point
│   ├── db.js             # Database connection and user operations
│   ├── tools.js          # Tool definitions for AI
│   ├── toolFunctions.js  # Video editing function implementations
│   └── test/             # Test files
├── docs/
│   ├── QUICKSTART.md         # Quick setup guide
│   ├── GOOGLE_AUTH_SETUP.md  # Detailed auth documentation
│   ├── STRIPE.md             # Stripe integration guide
│   └── DEPLOYMENT.md         # Production deployment guide
├── index.html            # HTML entry point
├── server.js             # Express server with auth and API routes
├── package.json          # Dependencies and scripts
└── vite.config.js        # Vite configuration
```

## Deployment

For production deployment to DigitalOcean with DNS configuration on GoDaddy, see the comprehensive guides:

- **[DEPLOYMENT.md](./docs/DEPLOYMENT.md)** - Complete step-by-step deployment guide
- **[QUICK-REFERENCE.md](./docs/QUICK-REFERENCE.md)** - Quick reference for common tasks
- **[deploy.sh](./deploy.sh)** - Automated deployment script
- **[setup-server.sh](./setup-server.sh)** - Server setup script

### Quick Deploy

For initial server setup:
```bash
wget https://raw.githubusercontent.com/yishengjiang99/pages/main/finalcut/setup-server.sh
chmod +x setup-server.sh
sudo ./setup-server.sh
```

For application updates:
```bash
cd /home/finalcut/apps/pages/finalcut
./deploy.sh
```

## License

This project is part of the yishengjiang99/pages repository.
