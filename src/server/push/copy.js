// FinalCap push copy: Grok drafts → guardrails → cache; template fallback. Never throws.
// Sent to xAI: the segment goal, app facts, and coarse facts (tier, "1-3 edits last week",
// exported yes/no). Never ids, tokens, timestamps, prompts, captions or media.
import crypto from 'crypto';
import { getPool } from '../../db.js';

const XAI_URL = 'https://api.x.ai/v1/chat/completions';
export const COPY_MODELS = () => [process.env.PUSH_COPY_MODEL?.trim() || 'grok-4.20-0309-non-reasoning', 'grok-4.3'];
export const LIMITS = Object.freeze({ titleMax: 40, bodyMax: 140 });
const CACHE_TTL_MS = 14 * 24 * 3600_000;

/** True statements about the shipping app (keep in sync with the app + store listing). */
export const APP_FACTS = [
  'FinalCap edits videos and photos on the iPhone by chat: type or say what you want, e.g. "trim the first 3 seconds", "make it black and white", "add captions".',
  'Captions are created on the iPhone; they can be translated by asking in the chat.',
  'Export saves the finished video or photo to the Photos library.',
  'FinalCap Pro (monthly subscription) includes unlimited AI edits, captions and translations. There is no free trial.',
];

const URGENCY = /\b(hurry|urgent|act now|last chance|limited[- ]time|don'?t miss|do not miss|expir\w*|ending soon|ends soon|only today|today only|now or never|final chance|before it'?s gone|running out|deadline|countdown|ASAP|immediately)\b/i;
const MONEY = /[$€£¥₹]|\b\d+\s?%|\b(discount|sale|deal|coupon|promo code|cheap|save \d+|half off|price drop)\b/i;
const LINKS = /(https?:\/\/|www\.|\.com\b|@)/i;
const GUILT = /\b(miss(es|ing)? you|we miss|lonely|abandon\w*|you forgot|don'?t leave|sad)\b/i;
const WATCHED = /\b(since you last|you haven'?t (opened|used|been)|been (a|one|two|three|\d+) (days?|weeks?|months?)|(days?|weeks?|months?) away|while you were away|we noticed|we saw you)\b/i;
const ABSOLUTE = /\b(guarantee\w*|best (video )?editor|perfect every time|100%|never fail|viral)\b/i;

export function validateCopy(c, segment, facts) {
  const r = [];
  const title = String(c?.title ?? '').trim();
  const body = String(c?.body ?? '').trim();
  const both = `${title} ${body}`;
  if (!title) r.push('empty_title');
  if (!body) r.push('empty_body');
  if (title.length > LIMITS.titleMax) r.push('title_too_long');
  if (body.length > LIMITS.bodyMax) r.push('body_too_long');
  if (/[\r\n]/.test(both)) r.push('newline');
  if (URGENCY.test(both)) r.push('urgency');
  if (MONEY.test(both)) r.push('price_or_discount');
  if (LINKS.test(both)) r.push('link_or_handle');
  if (GUILT.test(both)) r.push('guilt');
  if (WATCHED.test(both)) r.push('surveillance_tone');
  if (ABSOLUTE.test(both)) r.push('absolute_claim');
  if ((both.match(/!/g) || []).length > 1) r.push('exclamation');
  if (/\b[A-Z]{4,}\b/.test(both.replace(/\bFinalCap\b/g, ''))) r.push('shouting');
  if ((both.match(/\p{Extended_Pictographic}/gu) || []).length > 1) r.push('emoji');
  if (/[{}[\]<>]/.test(both)) r.push('markup');
  // FinalCap Pro has no trial: never mention "free" or "trial" anywhere.
  if (/\b(free|trial)\b/i.test(both)) r.push('free_or_trial_claim');
  if (/\b(new|just launched|introducing)\b/i.test(both) && segment !== 'new_feature') r.push('new_claim');
  if (/\b(subscribe|subscription|upgrade|pro)\b/i.test(both) && segment !== 'paywall_not_converted') r.push('upsell_outside_paywall_segment');
  if (segment === 'paywall_not_converted' && /\b(all|every|everything|exclusive|premium|no ads|ad-free|4k|templates?|effects?|stickers?|music library)\b/i.test(both)) r.push('unverified_pro_benefit');
  if (/\bunlimited\b/i.test(both) && segment !== 'paywall_not_converted' && facts?.tier !== 'pro') r.push('unlimited_claim');
  return r;
}

export function templateCopy(segment, facts = {}) {
  switch (segment) {
    case 'edit_not_exported': return { title: 'Happy with your edit?', body: 'Tap Export to save the finished video to Photos so it is ready to share.' };
    case 'onboarding_d1': return { title: 'Edit by just asking', body: 'Open a clip and type what you want, like "trim the first 3 seconds" or "make it black and white".' };
    case 'onboarding_d3': return { title: 'Captions in one ask', body: 'Open a video and ask for captions. FinalCap writes them right on your iPhone.' };
    case 'onboarding_d7': return { title: 'Captions in another language', body: 'After adding captions, ask FinalCap to translate them into the language you need.' };
    case 'paywall_not_converted': return { title: 'Still thinking about Pro?', body: 'FinalCap Pro includes unlimited AI edits, captions and translations. Cancel any time in Settings.' };
    case 'new_feature': return { title: 'Now in FinalCap', body: String(facts.announcement || 'A new editing feature is ready to try.').slice(0, LIMITS.bodyMax) };
    case 'inactive_7': return { title: 'A quick edit idea', body: 'Pick a recent clip and ask FinalCap to trim it to the best 10 seconds.' };
    case 'inactive_14': return { title: 'Add captions to a recent video', body: 'Open a video, ask for captions, and export it ready to share.' };
    case 'winback_30': return { title: 'One thing to try', body: 'Open any clip and type "make it black and white" to see FinalCap edit by chat.' };
    default: return { title: 'FinalCap', body: 'Open a clip and type the edit you want.' };
  }
}

export function buildPrompt(goal, facts) {
  return {
    system: [
      'You write one iOS push notification for FinalCap, an AI video editor where you edit by chat.',
      'Voice: warm, specific, calm, helpful. Plain English. Like a friendly editor, not an ad.',
      `Hard rules: title at most ${LIMITS.titleMax} characters; body at most ${LIMITS.bodyMax} characters; one line each.`,
      'No urgency or scarcity. No guilt. No prices, currency, percentages, discounts. No links or hashtags. At most one emoji (prefer none), at most one exclamation mark.',
      'Never say free or trial. Never mention Pro, subscribing or upgrading unless the goal is about Pro.',
      'Do not say "new" unless the goal is a feature announcement.',
      'Never mention how long they have been away, when they last opened the app, tracking or data.',
      'Every message invites one concrete, doable action inside the app.',
      'App facts you may rely on (claim nothing beyond these):',
      ...APP_FACTS.map((f) => `- ${f}`),
      'Reply with JSON only: {"title": "...", "body": "..."}',
    ].join('\n'),
    user: JSON.stringify({ goal, facts }),
  };
}

export function copyCacheKey(segment, facts) {
  return crypto.createHash('sha256').update(JSON.stringify([segment, facts.tier, facts.editsLastWeek, facts.hasExported, facts.announcement ?? null])).digest('hex').slice(0, 24);
}

// Cache in MySQL so it survives deploys (rsync replaces the app dir).
const memCache = new Map();
export const mysqlCopyCache = {
  async get(key) {
    const pool = getPool();
    const [rows] = await pool.query('SELECT title, body, model, created_at AS at FROM push_copy_cache WHERE cache_key = ?', [key]);
    return rows[0] || null;
  },
  async set(key, v) {
    const pool = getPool();
    await pool.query('REPLACE INTO push_copy_cache (cache_key, title, body, model) VALUES (?, ?, ?, ?)', [key, v.title, v.body, v.model]);
  },
};
export const memoryCopyCache = { async get(k) { return memCache.get(k) || null; }, async set(k, v) { memCache.set(k, { ...v, at: new Date() }); } };

let fetchImpl = (...a) => fetch(...a);
export function setCopyFetchForTests(f) { fetchImpl = f || ((...a) => fetch(...a)); }

async function callGrok(model, prompt) {
  const key = (process.env.XAI_API_TOKEN || process.env.XAI_API_KEY || '').trim();
  if (!key) throw new Error('no_xai_key');
  const res = await fetchImpl(XAI_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.7, max_tokens: 200, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] }),
  });
  if (!res.ok) throw new Error(`xai_http_${res.status}`);
  const json = await res.json();
  const m = String(json?.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('xai_no_json');
  const p = JSON.parse(m[0]);
  return { title: String(p.title || '').trim(), body: String(p.body || '').trim() };
}

export async function generateCopy(segment, goal, facts, { useGrok, cache = mysqlCopyCache, now = new Date(), bypassCache = false } = {}) {
  const grokOn = useGrok ?? String(process.env.PUSH_COPY_GROK || 'true').toLowerCase() !== 'false';
  const key = copyCacheKey(segment, facts);
  if (!bypassCache) {
    try {
      const hit = await cache.get(key);
      if (hit && now - new Date(hit.at) < CACHE_TTL_MS && !validateCopy(hit, segment, facts).length) {
        return { title: hit.title, body: hit.body, source: 'cache', model: hit.model };
      }
    } catch { /* cache optional */ }
  }
  const rejected = [];
  if (grokOn && (process.env.XAI_API_TOKEN || process.env.XAI_API_KEY)) {
    const prompt = buildPrompt(goal, facts);
    for (const model of COPY_MODELS()) {
      for (let i = 0; i < 2; i++) {
        try {
          const d = await callGrok(model, prompt);
          const reasons = validateCopy(d, segment, facts);
          if (!reasons.length) {
            try { await cache.set(key, { ...d, model }); } catch { /* ignore */ }
            return { ...d, source: 'grok', model, ...(rejected.length ? { rejected } : {}) };
          }
          rejected.push(`${model}:${reasons.join('+')}`);
        } catch (err) {
          rejected.push(`${model}:${err?.message || 'error'}`);
          break;
        }
      }
    }
  }
  return { ...templateCopy(segment, facts), source: 'template', ...(rejected.length ? { rejected } : {}) };
}
