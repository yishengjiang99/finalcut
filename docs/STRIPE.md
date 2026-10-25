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

## Products and entitlements (FinalCut + AI Music Radar)

Every Checkout Session and Subscription carries `metadata.product`. No `product` means FinalCut, so
every existing FinalCut session behaves exactly as before and still sets `users.has_subscription`.

| Product | Where entitlement lives | Who writes it |
|---|---|---|
| FinalCut (`finalcut`, default) | `users.has_subscription` (unchanged) | `checkout.session.completed`, `customer.subscription.deleted`, `/api/verify-checkout-session` |
| AI Music Radar (`music`) | `product_entitlements (email, product='music', plan, ref, active)` | `src/server/musicBilling.js` webhook handler only |
| GBK Composer Pro (`compose`) | `product_entitlements (email, product='compose', …)` | same handler (`handleProductWebhookEvent`, `PRODUCT_SPECS` in `products.js`) |

So a FinalCut subscriber does not unlock music and a music buyer does not unlock FinalCut
(`src/test/musicBilling.test.js` covers both directions; both of those tests fail on the old code).
`hasProductEntitlement(email, 'music')` in `src/db.js` is the read side.

### Music checkout

`POST /api/music/checkout` (HTML form or JSON) with `plan` = `pro_monthly` | `pro_yearly` | `lifetime`,
plus optional attribution fields `event_id`, `utm_source|medium|campaign|content|term`, `twclid`, `rdt_cid`,
`landing`, which are copied into session (and subscription / payment intent) metadata.

| Plan | Stripe price (env) | Mode |
|---|---|---|
| Pro monthly $4.99 | `MUSIC_STRIPE_PRICE_PRO_MONTHLY` (recurring, monthly) | `subscription`, 7-day trial |
| Pro yearly $29.99 | `MUSIC_STRIPE_PRICE_PRO_YEARLY` (recurring, yearly) | `subscription`, 7-day trial |
| Lifetime $49.99 | `MUSIC_STRIPE_PRICE_LIFETIME` (one-time) | `payment` |

Success: `${MUSIC_SITE_URL}/thanks?plan=…&session_id={CHECKOUT_SESSION_ID}`; cancel: `${MUSIC_SITE_URL}/?checkout=cancel#pricing`.
`MUSIC_SITE_URL` defaults to `https://music.grepawk.com` and must be a grepawk host.
`POST /api/music/waitlist` (`email`) stores App Store waitlist sign-ups in `music_waitlist`.

Webhook events to enable on the endpoint (in addition to FinalCut's): `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`.

### Ad conversions (X + Reddit Conversions API)

`src/server/adsConversions.js`, called from the music webhook handler:
- `checkout.session.completed`: `start_trial` (Pro trial, value 0) or `purchase` (Lifetime, value), with
  `conversion_id = metadata.event_id`, the same id the landing page's thanks page passes to the X / Reddit pixel, so each platform dedupes.
- `invoice.paid` with an amount (trial converted, renewals): server-only `purchase`, id `inv_<invoice id>`.
- Identifiers: `twclid` / `rdt_cid` from metadata, SHA-256 of the lowercased email.
- Off switch: `ADS_TRACKING_ENABLED=0`. Each platform also stays off until its env vars are set (see `.env.example`).

## GBK Composer Pro (`compose`)

Checkout: `POST /api/compose/checkout` (form post from https://compose.grepawk.com/pricing), returns to
`/pricing/thanks` or `/pricing?checkout=cancel` on compose.grepawk.com. The same webhook URL handles it;
no new Stripe webhook endpoint is needed.

Create in Stripe (one product, "GBK Composer Pro", three prices) and set:

| Env | Price |
| --- | --- |
| `COMPOSE_STRIPE_PRICE_PRO_MONTHLY` | recurring $6/month (7-day trial is added by Checkout) |
| `COMPOSE_STRIPE_PRICE_PRO_YEARLY` | recurring $48/year |
| `COMPOSE_STRIPE_PRICE_LIFETIME` | one-time $99 |

Entitlement lookup for the GBK server: `GET /api/compose/entitlement?email=…` with
`Authorization: Bearer $COMPOSE_ENTITLEMENT_TOKEN` returns `{ product: 'compose', pro: true|false }`. With the
token unset the route 404s. Ad conversions use `COMPOSE_X_PIXEL_ID`, `COMPOSE_X_EVENT_ID_PURCHASE`,
`COMPOSE_X_EVENT_ID_START_TRIAL`, `COMPOSE_REDDIT_PIXEL_ID` (shared X/Reddit API creds, same
`ADS_TRACKING_ENABLED` off switch).

## Stripe catalog

GBK Composer Pro (live mode). Price IDs are not secret.

| Product | Price ID | Nickname | Amount | Interval | Metadata |
|---|---|---|---|---|---|
| prod_VVXpcLHC6Ahg5t (GBK Composer Pro) | price_1UUWjt4OymfcnKESqqY2SpC4 | GBK Pro Monthly | $5.99 USD | month (7-day trial added by server) | product=compose plan=pro_monthly |
| prod_VVXpcLHC6Ahg5t | price_1UUWjt4OymfcnKESKn99TpqY | GBK Pro Yearly | $47.99 USD | year (7-day trial added by server) | product=compose plan=pro_yearly |
| prod_VVXpcLHC6Ahg5t | price_1UUWjt4OymfcnKES8fWconiv | GBK Pro Lifetime | $99.00 USD | one-time | product=compose plan=lifetime |

Env: `COMPOSE_STRIPE_PRICE_PRO_MONTHLY`, `COMPOSE_STRIPE_PRICE_PRO_YEARLY`, `COMPOSE_STRIPE_PRICE_LIFETIME`.

Product is on acct_1StD764OymfcnKES (the account behind FinalCut's `STRIPE_SECRET_KEY`), statement descriptor `GBK COMPOSER`, product metadata product=compose app=gbk site=https://compose.grepawk.com. The original product prod_VVXeK2j4Dq3rOX on acct_1StDNUAUW7JlNziK (photo-recipes account) is unused; left in place to archive.
