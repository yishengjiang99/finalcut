# Google Authentication Setup Guide

This guide explains how to set up Google OAuth authentication for the FinalCut video editor application.

## Overview

The application now includes Google OAuth authentication with the following features:
- Users must authenticate with Google to access the application
- After authentication, users without a subscription are redirected to a Stripe subscription page
- Users with an active subscription can directly access the video editor
- User information and subscription status are stored in a MySQL database

## Prerequisites

1. **Google OAuth Credentials**
   - Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   - Create a new OAuth 2.0 Client ID
   - Set authorized redirect URIs to: `http://localhost:3001/auth/google/callback` (for development)
   - Note your Client ID and Client Secret

2. **MySQL Database**
   - Install MySQL on your system
   - Create a database for the application (default name: `finalcut`)

3. **Stripe Account**
   - Set up a Stripe account at [stripe.com](https://stripe.com)
   - Create a subscription product and price
   - Note your API keys and webhook secret

## Setup Instructions

### 1. Environment Variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Update the following variables in your `.env` file:

```
# Google OAuth Credentials
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_CALLBACK_URL=http://localhost:3001/auth/google/callback

# Session Secret (generate a random string)
SESSION_SECRET=your_random_session_secret_here

# MySQL Database Configuration
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=your_mysql_password_here
MYSQL_DATABASE=finalcut

# Stripe Configuration
STRIPE_SECRET_KEY=your_stripe_secret_key_here
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret_here
STRIPE_SUBSCRIPTION_PRICE_ID=price_xxxxxxxxxxxxx
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Database Setup

The application will automatically create the required database and tables on first run. The following table will be created:

**users table:**
- `id` - Auto-incrementing primary key
- `email` - User's email address (unique)
- `google_id` - Google OAuth ID (unique)
- `name` - User's display name
- `has_subscription` - Boolean indicating subscription status
- `subscription_id` - Stripe subscription ID
- `created_at` - Timestamp of user creation
- `updated_at` - Timestamp of last update

### 4. Start the Server

```bash
npm run server
```

The server will:
- Initialize the MySQL database and create tables if they don't exist
- Start listening on port 3001 (or the PORT specified in .env)
- Enable Google OAuth authentication endpoints

## Authentication Flow

1. **User clicks "Get Started"**
   - Frontend redirects to `/auth/google`
   - User is redirected to Google login page

2. **Google OAuth Callback**
   - After successful authentication, Google redirects to `/auth/google/callback`
   - Server checks if user exists in database
   - If new user, creates a record with `has_subscription: false`

3. **Subscription Check**
   - If user has no subscription (`has_subscription: false`):
     - Redirects to Stripe subscription checkout
   - If user has subscription (`has_subscription: true`):
     - Redirects to the video editor

4. **Stripe Webhook**
   - When subscription payment is successful, Stripe sends a webhook
   - Server updates user's `has_subscription` to `true`
   - Stores the subscription ID

## API Endpoints

### Authentication Endpoints

- `GET /auth/google` - Initiate Google OAuth flow
- `GET /auth/google/callback` - OAuth callback endpoint
- `GET /auth/logout` - Logout user and destroy session
- `GET /api/auth/status` - Check current authentication status

### Response Format for `/api/auth/status`

**Authenticated:**
```json
{
  "authenticated": true,
  "user": {
    "email": "user@example.com",
    "name": "User Name",
    "hasSubscription": true
  }
}
```

**Not Authenticated:**
```json
{
  "authenticated": false
}
```

## Stripe Webhook Configuration

1. Go to your [Stripe Dashboard Webhooks](https://dashboard.stripe.com/webhooks)
2. Add an endpoint: `https://yourdomain.com/api/stripe-webhook`
3. Select the following events to listen to:
   - `checkout.session.completed` - Updates subscription status when payment succeeds
   - `customer.subscription.deleted` - Removes subscription when cancelled
4. Copy the webhook signing secret to your `.env` file

## Production Deployment

For production deployment, update the following:

1. **Environment Variables:**
   ```
   NODE_ENV=production
   GOOGLE_CALLBACK_URL=https://yourdomain.com/auth/google/callback
   ```

2. **Session Security:**
   - Ensure `SESSION_SECRET` is a strong, random string
   - The session cookie will automatically be set to secure in production

3. **Google OAuth:**
   - Add production domain to authorized redirect URIs in Google Cloud Console

4. **MySQL:**
   - Use a production MySQL server
   - Ensure proper security and backup procedures

5. **CORS (if needed):**
   - Uncomment and configure CORS in `server.js` if your frontend is on a different domain

## Troubleshooting

### Database Connection Issues
- Verify MySQL is running
- Check database credentials in `.env`
- Ensure MySQL user has proper permissions

### OAuth Redirect Mismatch
- Verify `GOOGLE_CALLBACK_URL` matches the redirect URI in Google Cloud Console
- Check that the port matches your server configuration

### Session Not Persisting
- Check that `SESSION_SECRET` is set
- Verify cookies are not being blocked by browser
- In production, ensure HTTPS is being used

### Subscription Not Updating
- Verify Stripe webhook is configured correctly
- Check webhook signing secret matches `.env`
- Review server logs for webhook processing errors

## Testing

Run the authentication tests:

```bash
npm test -- src/test/google-auth.test.js
```

## Security Considerations

1. **Never commit `.env` file** - It contains sensitive credentials
2. **Use HTTPS in production** - Required for secure session cookies
3. **Rotate secrets regularly** - Update `SESSION_SECRET` periodically
4. **Validate webhook signatures** - Always verify Stripe webhook signatures
5. **Sanitize database inputs** - The application uses parameterized queries to prevent SQL injection
