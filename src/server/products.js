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
export const COMPOSE_PRODUCT = 'compose';

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

// GBK Composer (compose.grepawk.com) Pro. Price IDs from env, same rules as music:
//   COMPOSE_STRIPE_PRICE_PRO_MONTHLY  recurring $5.99/month
//   COMPOSE_STRIPE_PRICE_PRO_YEARLY   recurring $47.99/year
//   COMPOSE_STRIPE_PRICE_LIFETIME     one-time  $99.99 (aligned with iOS, gbk #117)
export const COMPOSE_TRIAL_DAYS = 7;

export function composePlans(env = process.env) {
  return {
    pro_monthly: { product: COMPOSE_PRODUCT, plan: 'pro_monthly', priceId: env.COMPOSE_STRIPE_PRICE_PRO_MONTHLY || '', mode: 'subscription', trialDays: COMPOSE_TRIAL_DAYS, value: 5.99 },
    pro_yearly: { product: COMPOSE_PRODUCT, plan: 'pro_yearly', priceId: env.COMPOSE_STRIPE_PRICE_PRO_YEARLY || '', mode: 'subscription', trialDays: COMPOSE_TRIAL_DAYS, value: 47.99 },
    lifetime: { product: COMPOSE_PRODUCT, plan: 'lifetime', priceId: env.COMPOSE_STRIPE_PRICE_LIFETIME || '', mode: 'payment', trialDays: 0, value: 99.99 },
  };
}

export function resolveComposePlan(planName, env = process.env) {
  const plans = composePlans(env);
  return Object.prototype.hasOwnProperty.call(plans, planName) ? plans[planName] : null;
}

export function composeSiteUrl(env = process.env) {
  const raw = (env.COMPOSE_SITE_URL || 'https://compose.grepawk.com').replace(/\/+$/, '');
  const u = new URL(raw);
  const allowed = new Set(['compose.grepawk.com', 'localhost', '127.0.0.1']);
  if (!allowed.has(u.hostname)) throw new Error(`COMPOSE_SITE_URL host not allowed: ${u.hostname}`);
  return raw;
}

// Every non-FinalCut product the Stripe webhook handles. adsPrefix picks the pixel env vars
// (<PREFIX>_X_PIXEL_ID, <PREFIX>_REDDIT_PIXEL_ID, ...); return paths are relative to siteUrl.
export const PRODUCT_SPECS = {
  [MUSIC_PRODUCT]: { product: MUSIC_PRODUCT, plans: musicPlans, siteUrl: musicSiteUrl, adsPrefix: 'MUSIC', successPath: '/thanks', cancelPath: '/?checkout=cancel#pricing' },
  [COMPOSE_PRODUCT]: { product: COMPOSE_PRODUCT, plans: composePlans, siteUrl: composeSiteUrl, adsPrefix: 'COMPOSE', successPath: '/pricing/thanks', cancelPath: '/pricing?checkout=cancel' },
};

// Session/subscription metadata says which product a Stripe object belongs to.
// Anything without metadata.product (all existing FinalCut sessions) is FinalCut.
export function productOf(stripeObject) {
  const p = stripeObject?.metadata?.product;
  return p ? String(p) : FINALCUT_PRODUCT;
}
