# User Flow Documentation - First-Time User Get Started

## Overview
This document describes the complete user flow for a first-time user clicking "Get Started" in the FinalCut video editor application.

## User Flow Steps

### 1. Landing Page
- User visits the application and sees the landing page with:
  - "Get Started" button (primary action)
  - "Try with Sample Video" button (demo mode, bypasses authentication)
  - Feature showcase

### 2. Click "Get Started"
- Triggers `handleGetStarted()` in `App.jsx`
- Redirects user to `/auth/google` endpoint
- **Critical**: This route must be proxied to the Node.js server (port 3001)

### 3. Google OAuth Authentication
- User authenticates with their Google account
- Google redirects to `/auth/google/callback`
- Server validates Google OAuth response
- Server checks or creates user in MySQL database

### 4. Subscription Check
- After successful OAuth, server checks if user has an active subscription
- **If user has subscription**: Redirect to `/` (main app)
- **If user has NO subscription**: Redirect to Stripe checkout

### 5. Stripe Payment (for users without subscription)
- User is redirected to Stripe checkout page
- User enters payment information
- On successful payment:
  - Stripe redirects to `/success?session_id={CHECKOUT_SESSION_ID}`
  - Stripe webhook sends `checkout.session.completed` event to server

### 6. Payment Verification
- App detects `/success` route with `session_id` parameter
- App calls `/api/verify-checkout-session` endpoint with the session ID
- Server:
  1. Verifies the payment with Stripe API
  2. Updates user's subscription status in MySQL database
  3. Updates user's session object with `has_subscription: true`
- If verified, app hides landing page and shows the editor

### 7. Editor Access
- User can now upload videos and use the AI-powered video editor
- User's subscription status is maintained in their session

## Critical Configuration Requirements

### Development Environment (Vite)
The `vite.config.js` must proxy both `/api` and `/auth` routes to the Node.js server:

```javascript
proxy: {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
  '/auth': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
}
```

### Production Environment (Nginx)
The `nginx.conf` must proxy both `/api` and `/auth` routes to the Node.js server:

```nginx
# Proxy authentication routes
location /auth {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    # ... other proxy headers
}

# Proxy API routes
location /api {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    # ... other proxy headers
}

# SPA fallback for all other routes
location / {
    try_files $uri $uri/ /index.html;
}
```

## Issues Fixed

### Issue 1: Missing `/auth` Route Proxy
**Problem**: The `/auth/*` routes were not proxied to the Node.js server in either development or production configurations.

**Impact**: Authentication was completely broken. When users clicked "Get Started", the request would try to serve `/auth/google` as a static file instead of hitting the Node.js authentication endpoint.

**Fix**: Added `/auth` proxy configuration to both `vite.config.js` (development) and `nginx.conf` (production).

### Issue 2: Payment Verification Session Update
**Problem**: After successful payment verification, the user's session object was not immediately updated with their subscription status, even though the database was updated by the webhook.

**Impact**: Potential timing issues where users might be shown the landing page even after paying, or need to refresh the page to access the editor.

**Fix**: Enhanced `/api/verify-checkout-session` endpoint to:
1. Update the database with subscription status
2. Update the user's session object if they're authenticated
3. Log the subscription update for debugging

## Authentication Flow Diagram

```
User
  |
  v
Landing Page (App.jsx)
  |
  | (Click "Get Started")
  v
/auth/google (proxied to Node.js)
  |
  v
Google OAuth Login
  |
  v
/auth/google/callback (proxied to Node.js)
  |
  v
[Server checks subscription]
  |
  +----> Has subscription? ----> Redirect to / (Editor)
  |
  +----> No subscription? ----> Redirect to Stripe Checkout
                                  |
                                  v
                          Stripe Payment Page
                                  |
                                  v (Payment completed)
                          /success?session_id=xxx
                                  |
                                  v
                          Verify payment via API
                                  |
                                  v
                          Update DB & Session
                                  |
                                  v
                          Hide landing page
                                  |
                                  v
                          Show Editor
```

## Testing

### Test Coverage
Created comprehensive test suite in `src/test/auth-routing.test.js` covering:
- Vite proxy configuration verification
- Nginx configuration verification
- Authentication endpoints
- Complete user flow steps
- Payment verification
- Error handling
- SPA routing support

All 46 authentication-related tests pass successfully.

### Manual Testing Checklist
To manually test the complete flow:

1. **Prerequisites**:
   - MySQL server running
   - Environment variables configured (.env file)
   - Google OAuth credentials configured
   - Stripe API keys configured
   - FFmpeg installed

2. **Development Testing**:
   ```bash
   # Terminal 1: Start the Node.js server
   npm run server
   
   # Terminal 2: Start the Vite dev server
   npm run dev
   ```

3. **Test Steps**:
   - Visit http://localhost:5173
   - Click "Get Started"
   - Verify redirect to Google OAuth
   - Complete Google authentication
   - Verify redirect to Stripe (if no subscription)
   - Use test card: 4242 4242 4242 4242
   - Verify redirect to /success
   - Verify landing page disappears
   - Verify editor is accessible

4. **Production Testing**:
   ```bash
   npm run build
   npm run server
   ```
   - Visit http://localhost:3001
   - Follow same test steps as development

## Environment Variables Required

```env
# Google OAuth
GOOGLE_CLIENT_ID=your_client_id
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_CALLBACK_URL=http://localhost:3001/auth/google/callback

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUBSCRIPTION_PRICE_ID=price_...

# MySQL
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=finalcut

# App
SESSION_SECRET=your_random_32_char_string
XAI_API_TOKEN=your_xai_token
```

## Security Considerations

1. **Session Management**: Sessions are server-side using express-session with secure cookies in production
2. **Payment Verification**: Always verify payments with Stripe API, never trust client-side data
3. **Database Updates**: Both webhook and payment verification endpoint update the database for redundancy
4. **OAuth Tokens**: Google OAuth tokens are handled securely by Passport.js
5. **API Keys**: All sensitive keys are stored in environment variables, never in code

## Troubleshooting

### Issue: "Get Started" button doesn't work
- **Check**: Vite proxy configuration includes `/auth` routes
- **Check**: Node.js server is running on port 3001
- **Check**: Browser console for errors

### Issue: Stuck on "Google Sign In" page
- **Check**: Google OAuth credentials are correct
- **Check**: Callback URL matches the one configured in Google Console
- **Check**: MySQL database is accessible

### Issue: Payment succeeded but landing page still shows
- **Check**: Stripe webhook secret is configured
- **Check**: Database connection is working
- **Check**: Browser console shows session update
- **Try**: Refresh the page to reload session data

## Related Files

- `src/App.jsx` - Frontend routing and payment verification
- `server.js` - Authentication routes and payment endpoints
- `src/db.js` - Database operations
- `vite.config.js` - Development proxy configuration
- `nginx.conf` - Production proxy configuration
- `src/test/auth-routing.test.js` - Test suite
