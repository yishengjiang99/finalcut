# Quick Start Guide - Google Authentication Setup

This document provides step-by-step instructions to get the Google authentication feature up and running.

## Prerequisites Checklist

Before you begin, ensure you have:

- [ ] MySQL server installed and running
- [ ] Google Cloud account (free tier available)
- [ ] Stripe account (test mode is fine for development)
- [ ] Node.js 16+ installed

## Step 1: Google OAuth Setup (5 minutes)

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project or select an existing one
3. Click "Create Credentials" → "OAuth 2.0 Client ID"
4. Configure the consent screen if prompted
5. For Application type, select "Web application"
6. Add authorized redirect URIs:
   - For development: `http://localhost:3001/auth/google/callback`
   - For production: `https://yourdomain.com/auth/google/callback`
7. Click "Create"
8. **Save** your Client ID and Client Secret

## Step 2: MySQL Database Setup (3 minutes)

### Option A: Local MySQL
```bash
# Install MySQL (Ubuntu/Debian)
sudo apt-get install mysql-server

# Start MySQL
sudo systemctl start mysql

# Secure installation (optional but recommended)
sudo mysql_secure_installation

# Create database user (optional)
mysql -u root -p
CREATE USER 'finalcut'@'localhost' IDENTIFIED BY 'your_secure_password';
GRANT ALL PRIVILEGES ON finalcut.* TO 'finalcut'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### Option B: Use Existing MySQL Server
Just have your connection details ready:
- Host
- Username
- Password
- Database name (will be created automatically)

## Step 3: Stripe Setup (3 minutes)

1. Go to [Stripe Dashboard](https://dashboard.stripe.com/)
2. Enable test mode (toggle in top right)
3. Navigate to Products → Create Product
4. Create a subscription product with recurring billing
5. Copy the Price ID (starts with `price_`)
6. Go to Developers → API keys
7. **Save** your Secret key (starts with `sk_test_`)
8. Go to Developers → Webhooks → Add endpoint
   - Endpoint URL: `http://localhost:3001/api/stripe-webhook` (for dev)
   - Select events: `checkout.session.completed` and `customer.subscription.deleted`
9. **Save** your Webhook signing secret (starts with `whsec_`)

## Step 4: Configure Environment Variables (2 minutes)

```bash
# Copy the example file
cp .env.example .env

# Edit .env with your favorite editor
nano .env  # or vim, code, etc.
```

Fill in these values:

```bash
# Required
XAI_API_TOKEN=your_xai_token_from_x.ai
GOOGLE_CLIENT_ID=your_google_client_id_from_step1
GOOGLE_CLIENT_SECRET=your_google_client_secret_from_step1
SESSION_SECRET=generate_random_32_char_string_here
MYSQL_PASSWORD=your_mysql_password

# Stripe
STRIPE_SECRET_KEY=sk_test_your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
STRIPE_SUBSCRIPTION_PRICE_ID=price_your_price_id

# Optional (defaults shown)
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_DATABASE=finalcut
PORT=3001
```

**Pro tip**: Generate a secure SESSION_SECRET:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Step 5: Install and Run (2 minutes)

```bash
# Install dependencies
npm install

# Start the server
npm run server
```

You should see:
```
Database initialized successfully
Proxy server running on http://localhost:3001
Configuration loaded successfully
FFmpeg video processing endpoint available at /api/process-video
Stripe payment endpoints available:
  - POST /api/create-checkout-session
  - POST /api/verify-checkout-session
  - POST /api/stripe-webhook
```

## Step 6: Test the Flow (2 minutes)

1. Open browser to `http://localhost:3001`
2. Click "Get Started"
3. Sign in with your Google account
4. You'll be redirected to Stripe checkout (test mode)
5. Use test card: `4242 4242 4242 4242`, any future date, any CVC
6. Complete payment
7. You should be redirected back to the video editor

## Verification

Check that everything works:

- [ ] Server starts without errors
- [ ] Clicking "Get Started" redirects to Google login
- [ ] After Google login, redirects to Stripe checkout
- [ ] After payment, returns to video editor
- [ ] MySQL database has `users` table with your user record
- [ ] User has `has_subscription = 1` in database

Check MySQL:
```bash
mysql -u root -p
USE finalcut;
SELECT * FROM users;
```

## Common Issues

### "SESSION_SECRET is not set"
- Make sure you created `.env` file and set SESSION_SECRET

### "Could not initialize database"
- Check MySQL is running: `sudo systemctl status mysql`
- Verify credentials in `.env`
- Try connecting manually: `mysql -u root -p`

### "OAuth redirect mismatch"
- Ensure callback URL in Google Console matches exactly
- Check the port number (default is 3001)

### Stripe webhook not working
- For local development, use Stripe CLI: `stripe listen --forward-to localhost:3001/api/stripe-webhook`
- Update webhook secret from Stripe CLI output

## Next Steps

Once everything works:

1. Review `docs/GOOGLE_AUTH_SETUP.md` for detailed information
2. Set up production environment variables
3. Configure production Google OAuth redirect URLs
4. Set up production Stripe webhooks
5. Deploy to your server

## Need Help?

- Check server logs for detailed error messages
- Review the full documentation in `docs/GOOGLE_AUTH_SETUP.md`
- Ensure all environment variables are set correctly
- Test with Stripe test mode before going live

## Security Reminders

- Never commit `.env` file to git
- Use strong, random SESSION_SECRET
- Enable 2FA on Google and Stripe accounts
- Use HTTPS in production
- Regularly rotate secrets
