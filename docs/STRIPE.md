# Stripe Payment Integration

This document describes the Stripe payment functionality added to server.js.

For complete client-side code examples, see [stripe-client-examples.js](./stripe-client-examples.js).

## Configuration

Add the following environment variables to your `.env` file:

```bash
# Stripe API Keys
# Get your keys from https://dashboard.stripe.com/apikeys
STRIPE_SECRET_KEY=sk_test_your_secret_key_here
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret_here
```

### Getting Your Stripe Keys

1. Sign up or log in to [Stripe Dashboard](https://dashboard.stripe.com/)
2. Go to Developers > API keys
3. Copy your Secret key (starts with `sk_test_` for test mode or `sk_live_` for production)
4. For the webhook secret, go to Developers > Webhooks > Add endpoint and configure your webhook URL

## Endpoints

### POST /api/create-checkout-session

Creates a Stripe Checkout session for accepting payments.

**Request Body:**
```json
{
  "priceId": "price_1234567890",
  "successUrl": "https://yourdomain.com/success",
  "cancelUrl": "https://yourdomain.com/cancel"
}
```

**Response:**
```json
{
  "sessionId": "cs_test_1234567890",
  "url": "https://checkout.stripe.com/pay/cs_test_1234567890"
}
```

**Usage Example:**
```javascript
const response = await fetch('http://localhost:3001/api/create-checkout-session', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    priceId: 'price_1234567890',
    successUrl: 'https://yourdomain.com/success',
    cancelUrl: 'https://yourdomain.com/cancel',
  }),
});

const { url } = await response.json();
// Redirect user to the Stripe Checkout page
window.location.href = url;
```

### POST /api/stripe-webhook

Receives and processes webhook events from Stripe.

**Important:** This endpoint must be registered in your Stripe Dashboard under Developers > Webhooks.

**Webhook URL:** `https://yourdomain.com/api/stripe-webhook`

**Supported Events:**
- `checkout.session.completed` - Payment successful
- `payment_intent.succeeded` - Payment intent succeeded
- `payment_intent.payment_failed` - Payment failed

**Headers Required:**
- `stripe-signature` - Automatically added by Stripe for verification

## Testing

### Test Mode

Use Stripe's test mode keys (starting with `sk_test_` and `whsec_test_`) during development.

Test card numbers:
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 0002`

See [Stripe Testing Docs](https://stripe.com/docs/testing) for more test cards.

### Webhook Testing with Stripe CLI

1. Install the [Stripe CLI](https://stripe.com/docs/stripe-cli)
2. Login: `stripe login`
3. Forward webhooks to your local server:
   ```bash
   stripe listen --forward-to localhost:3001/api/stripe-webhook
   ```
4. The CLI will provide a webhook signing secret starting with `whsec_`
5. Update your `.env` file with this secret

## Security Notes

1. **Never commit your `.env` file** - It contains sensitive API keys
2. **Always verify webhook signatures** - The endpoint uses `stripe.webhooks.constructEvent()` to verify that webhooks come from Stripe
3. **Use HTTPS in production** - Stripe webhooks require HTTPS endpoints
4. **Set up proper CORS** - Configure ALLOWED_ORIGINS in production

## Creating Stripe Products and Prices

Before you can accept payments, you need to create products and prices in Stripe:

1. Go to Stripe Dashboard > Products
2. Click "Add Product"
3. Fill in product details
4. Add a price (one-time or recurring)
5. Copy the Price ID (starts with `price_`) to use in your API calls

## Fulfillment

The webhook endpoint logs successful payments but includes TODO comments where you should add your business logic:

- Grant user access to premium features
- Send confirmation emails
- Update database records
- Generate invoices

Look for the `TODO` comments in the webhook handler in `server.js`.

## Rate Limiting

The `/api/create-checkout-session` endpoint is protected by the `apiLimiter` middleware:
- 100 requests per 15 minutes per IP address

## Error Handling

All endpoints return appropriate HTTP status codes:
- `200` - Success
- `400` - Bad request (missing fields, invalid data)
- `500` - Server error
- `503` - Service unavailable (Stripe not configured)

## Running Without Stripe

If `STRIPE_SECRET_KEY` is not set, the server will:
- Start normally with a warning message
- Return 503 errors for Stripe endpoints
- Continue to work for all other endpoints (video processing, xAI chat, etc.)
