// Product catalog for Stripe Checkout on grepawk.com.
// Each sellable plan belongs to exactly one product, so a purchase only unlocks that product
// (product-scoped entitlements, see db.js product_entitlements). FinalCut keeps its legacy
// global users.has_subscription flag; AI Music Radar never reads or writes it.
//
// Music price IDs come from env (create them in the Stripe dashboard, see docs/STRIPE.md):
//   MUSIC_STRIPE_PRICE_PRO_MONTHLY   recurring $4.99/month
//   MUSIC_STRIPE_PRICE_PRO_YEARLY    recurring $29.99/year
//   MUSIC_STRIPE_PRICE_LIFETIME      one-time  $49.99
// A plan whose price ID is unset is simply not for sale (checkout returns 503 for it).

export const MUSIC_PRODUCT = 'music';
export const FINALCUT_PRODUCT = 'finalcut';

export const MUSIC_TRIAL_DAYS = 7;

export function musicPlans(env = process.env) {
  return {
    pro_monthly: { product: MUSIC_PRODUCT, plan: 'pro_monthly', priceId: env.MUSIC_STRIPE_PRICE_PRO_MONTHLY || '', mode: 'subscription', trialDays: MUSIC_TRIAL_DAYS, value: 4.99 },
    pro_yearly: { product: MUSIC_PRODUCT, plan: 'pro_yearly', priceId: env.MUSIC_STRIPE_PRICE_PRO_YEARLY || '', mode: 'subscription', trialDays: MUSIC_TRIAL_DAYS, value: 29.99 },
    lifetime: { product: MUSIC_PRODUCT, plan: 'lifetime', priceId: env.MUSIC_STRIPE_PRICE_LIFETIME || '', mode: 'payment', trialDays: 0, value: 49.99 },
  };
}

export function resolveMusicPlan(planName, env = process.env) {
  const plans = musicPlans(env);
  return Object.prototype.hasOwnProperty.call(plans, planName) ? plans[planName] : null;
}

// Where Checkout sends music buyers back to. Fixed per deployment (never taken from the request).
export function musicSiteUrl(env = process.env) {
  const raw = (env.MUSIC_SITE_URL || 'https://music.grepawk.com').replace(/\/+$/, '');
  const u = new URL(raw);
  const allowed = new Set(['music.grepawk.com', 'grepawk.com', 'localhost', '127.0.0.1']);
  if (!allowed.has(u.hostname)) throw new Error(`MUSIC_SITE_URL host not allowed: ${u.hostname}`);
  return raw;
}

// Session/subscription metadata says which product a Stripe object belongs to.
// Anything without metadata.product (all existing FinalCut sessions) is FinalCut.
export function productOf(stripeObject) {
  const p = stripeObject?.metadata?.product;
  return p ? String(p) : FINALCUT_PRODUCT;
}
