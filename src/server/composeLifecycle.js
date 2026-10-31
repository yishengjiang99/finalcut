// GBK Composer Pro billing lifecycle (#121, #122): signed portal links, the two lifecycle emails,
// and the funnel events the GBK report reads (GET /api/compose/events).
//
// Emails go through Resend's HTTP API (no SDK). They are OFF unless COMPOSE_LIFECYCLE_EMAILS=1,
// and also need RESEND_API_KEY + COMPOSE_EMAIL_FROM. Events are recorded either way.
import { createHmac, timingSafeEqual } from 'crypto';
import { COMPOSE_PRODUCT } from './products.js';
import { renderEmail } from './emailTemplate.js';

export const PORTAL_LINK_TTL_S = 14 * 24 * 3600;

// ---- signed portal link (used in emails; HMAC keyed by COMPOSE_ENTITLEMENT_TOKEN) ----
function sig(email, exp, secret) {
  return createHmac('sha256', secret).update(`compose-portal:${email}:${exp}`).digest('base64url');
}
export function signPortalLink(email, env = process.env, now = Date.now()) {
  const secret = env.COMPOSE_ENTITLEMENT_TOKEN;
  if (!secret) return null;
  const base = (env.PUBLIC_API_URL || 'https://grepawk.com').replace(/\/+$/, '');
  const e = String(email).toLowerCase();
  const exp = Math.floor(now / 1000) + PORTAL_LINK_TTL_S;
  return `${base}/api/compose/portal?${new URLSearchParams({ email: e, exp: String(exp), sig: sig(e, exp, secret) })}`;
}
export function verifyPortalLink({ email, exp, sig: got }, env = process.env, now = Date.now()) {
  const secret = env.COMPOSE_ENTITLEMENT_TOKEN;
  if (!secret || !email || !exp || !got) return false;
  if (!/^\d+$/.test(String(exp)) || Number(exp) < Math.floor(now / 1000)) return false;
  const want = Buffer.from(sig(String(email).toLowerCase(), exp, secret));
  const have = Buffer.from(String(got));
  return want.length === have.length && timingSafeEqual(want, have);
}

// ---- signed unsubscribe link (marketing-type emails only; no expiry) ----
function unsubSig(email, secret) {
  return createHmac('sha256', secret).update(`compose-unsub:${email}`).digest('base64url');
}
export function signUnsubscribeLink(email, env = process.env) {
  const secret = env.COMPOSE_ENTITLEMENT_TOKEN;
  if (!secret) return null;
  const base = (env.PUBLIC_API_URL || 'https://grepawk.com').replace(/\/+$/, '');
  const e = String(email).toLowerCase();
  return `${base}/api/compose/unsubscribe?${new URLSearchParams({ email: e, sig: unsubSig(e, secret) })}`;
}
export function verifyUnsubscribeLink({ email, sig: got } = {}, env = process.env) {
  const secret = env.COMPOSE_ENTITLEMENT_TOKEN;
  if (!secret || !email || !got) return false;
  const want = Buffer.from(unsubSig(String(email).toLowerCase(), secret));
  const have = Buffer.from(String(got));
  return want.length === have.length && timingSafeEqual(want, have);
}
export const unsubscribeRef = (email) => `unsub:${String(email).toLowerCase()}`;

// ---- email copy (Yisheng approves before COMPOSE_LIFECYCLE_EMAILS=1) ----
const fmtDate = (unix) => new Date(unix * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Marketing-type (sent only with promotional consent): carries an unsubscribe link + headers.
export function recoveryEmail({ recoveryUrl, unsubscribeUrl = null }) {
  const { text, html } = renderEmail({
    preheader: 'Your GBK Composer Pro checkout is saved and ready when you are.',
    heading: 'Your checkout is saved',
    blocks: [
      { p: 'Hi,' },
      { p: 'You started checking out GBK Composer Pro but didn\'t finish. Your cart is saved, so you can pick up where you left off.' },
      { button: { label: 'Resume checkout', url: recoveryUrl } },
      { p: 'Pro includes a 7-day free trial on monthly and yearly plans, and you can cancel any time.' },
      { small: 'If you meant to skip it, no worries. This is the only reminder we\'ll send.' },
    ],
    reason: 'You received this because you started a GBK Composer Pro checkout and agreed to receive emails from us.',
    unsubscribeUrl,
  });
  const headers = unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined;
  return { subject: 'Your GBK Composer Pro checkout is saved', text, html, ...(headers ? { headers } : {}) };
}

// Transactional (billing notice about an existing trial): no unsubscribe.
export function trialEndingEmail({ trialEnd, planLabel, manageUrl }) {
  const when = fmtDate(trialEnd);
  const { text, html } = renderEmail({
    preheader: `Your free trial ends on ${when}. No action is needed to keep Pro.`,
    heading: `Your free trial ends on ${when}`,
    blocks: [
      { p: 'Hi,' },
      { p: `Your GBK Composer Pro free trial ends on ${when}. After that, your ${planLabel} plan starts and your card on file is charged.` },
      { p: 'Want to keep Pro? You don\'t need to do anything.' },
      { p: 'Want to cancel or change plans? You can manage your subscription here:' },
      { button: { label: 'Manage subscription', url: manageUrl } },
      { small: 'This link is personal to you and expires in 14 days.' },
    ],
    reason: 'You received this because you have a GBK Composer Pro trial. It is a required billing notice about your account.',
  });
  return { subject: `Your GBK Composer Pro trial ends ${when}`, text, html };
}

const PLAN_LABELS = { pro_monthly: 'monthly ($5.99/month)', pro_yearly: 'yearly ($47.99/year)' };

export function emailsEnabled(env = process.env) {
  return env.COMPOSE_LIFECYCLE_EMAILS === '1' && Boolean(env.RESEND_API_KEY) && Boolean(env.COMPOSE_EMAIL_FROM);
}

export async function sendResendEmail({ to, subject, text, html, headers }, { env = process.env, fetchImpl = fetch } = {}) {
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.COMPOSE_EMAIL_FROM, to: [to], subject, text, html, ...(env.COMPOSE_EMAIL_REPLY_TO ? { reply_to: env.COMPOSE_EMAIL_REPLY_TO } : {}), ...(headers ? { headers } : {}) }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}`);
}

// ---- webhook additions for product='compose' ----
const at = (unix) => new Date((unix || Math.floor(Date.now() / 1000)) * 1000);
export const periodEndOf = (sub) => sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;

// Email is sent at most once per ref: the email_* event is recorded first (INSERT IGNORE), and only
// the call that inserted it sends. A failed send is logged and not retried (better than a double send).
async function sendOnce(db, { type, ref, email, message, marketing = false }, { env, sendEmail }) {
  if (!emailsEnabled(env) || !email) return false;
  if (marketing && (await db.isEmailUnsubscribed?.(email))) return false;
  const fresh = await db.recordProductEvent({ product: COMPOSE_PRODUCT, type, ref, email });
  if (!fresh) return false;
  try {
    await sendEmail({ to: email, ...message }, { env });
    return true;
  } catch (error) {
    console.error(`[compose] ${type} send failed:`, error.message);
    return false;
  }
}

export async function onCheckoutExpired(session, db, { env, sendEmail }) {
  const email = session.customer_details?.email || session.customer_email || null;
  const recoveryUrl = session.after_expiration?.recovery?.url;
  // Only email people who opted in to promotional email on the Checkout page.
  if (session.consent?.promotions !== 'opt_in' || !recoveryUrl) return false;
  return sendOnce(db, { type: 'email_recovery', ref: session.id, email, message: recoveryEmail({ recoveryUrl, unsubscribeUrl: email ? signUnsubscribeLink(email, env) : null }), marketing: true }, { env, sendEmail });
}

export async function onTrialWillEnd(sub, db, { env, sendEmail, stripe }) {
  const row = await db.findProductEntitlementByRef(COMPOSE_PRODUCT, sub.id);
  let email = row?.email || null;
  if (!email && sub.customer && stripe) {
    try { email = (await stripe.customers.retrieve(sub.customer))?.email || null; } catch { /* no email, no send */ }
  }
  const manageUrl = email && signPortalLink(email, env);
  if (!manageUrl || !sub.trial_end) return false;
  const message = trialEndingEmail({ trialEnd: sub.trial_end, planLabel: PLAN_LABELS[sub.metadata?.plan] || 'Pro', manageUrl });
  return sendOnce(db, { type: 'email_trial_ending', ref: `${sub.id}:${sub.trial_end}`, email, message }, { env, sendEmail });
}

export async function recordCheckoutCompleted(session, db) {
  const email = session.customer_details?.email || session.customer_email || null;
  const plan = session.metadata?.plan || null;
  const isTrial = session.mode === 'subscription' && (session.amount_total || 0) === 0;
  const ref = session.subscription || session.payment_intent || session.id;
  if (session.subscription) await db.setProductSubscriptionState({ product: COMPOSE_PRODUCT, ref, status: isTrial ? 'trialing' : 'active' });
  else await db.setProductSubscriptionState({ product: COMPOSE_PRODUCT, ref, status: 'active' });
  await db.recordProductEvent({
    product: COMPOSE_PRODUCT, type: isTrial ? 'trial_start' : 'purchase', ref: session.id, email, plan,
    amountCents: session.amount_total || 0, currency: session.currency || null, subscriptionRef: session.subscription || null, occurredAt: at(session.created),
  });
}

export async function recordSubscriptionChange(event, db) {
  const sub = event.data.object;
  const deleted = event.type === 'customer.subscription.deleted';
  await db.setProductSubscriptionState({
    product: COMPOSE_PRODUCT, ref: sub.id, status: deleted ? 'canceled' : sub.status,
    currentPeriodEnd: periodEndOf(sub), cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  });
  if (deleted) {
    await db.recordProductEvent({ product: COMPOSE_PRODUCT, type: 'cancel', ref: sub.id, plan: sub.metadata?.plan || null, subscriptionRef: sub.id, occurredAt: at(sub.canceled_at || sub.ended_at) });
  }
}

// First paid invoice on a subscription that started with a trial = trial_convert; later ones = renewal.
export async function recordInvoicePaid(inv, db) {
  if ((inv.amount_paid || 0) <= 0) return;
  const subId = inv.parent?.subscription_details?.subscription || inv.subscription || null;
  const meta = inv.parent?.subscription_details?.metadata || inv.subscription_details?.metadata || {};
  let type = 'renewal';
  if (subId && !(await db.hasProductEvent({ subscriptionRef: subId, types: ['trial_convert', 'renewal'] }))) {
    type = (await db.hasProductEvent({ subscriptionRef: subId, types: ['trial_start'] })) ? 'trial_convert' : 'renewal';
  }
  await db.recordProductEvent({
    product: COMPOSE_PRODUCT, type, ref: inv.id, email: inv.customer_email || null, plan: meta.plan || null,
    amountCents: inv.amount_paid, currency: inv.currency || null, subscriptionRef: subId, occurredAt: at(inv.status_transitions?.paid_at || inv.created),
  });
}

// charge.refunded: Charges carry no product metadata for subscriptions, so match by customer.
// Returns true only when the charge belongs to a compose customer (FinalCut/music refunds fall through).
export async function recordRefund(charge, db) {
  const isCompose = charge.metadata?.product === COMPOSE_PRODUCT;
  const row = await db.findProductEntitlementByCustomer(COMPOSE_PRODUCT, charge.customer);
  if (!isCompose && !row) return false;
  await db.recordProductEvent({
    product: COMPOSE_PRODUCT, type: 'refund', ref: charge.id, email: charge.billing_details?.email || row?.email || null, plan: row?.plan || charge.metadata?.plan || null,
    amountCents: charge.amount_refunded || 0, currency: charge.currency || null, subscriptionRef: row?.ref?.startsWith('sub_') ? row.ref : null, occurredAt: at(charge.created),
  });
  return true;
}

export const FUNNEL_TYPES = ['trial_start', 'trial_convert', 'renewal', 'purchase', 'cancel', 'refund', 'email_recovery', 'email_trial_ending', 'email_unsubscribe'];
