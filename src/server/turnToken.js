// Signed turn tokens for client-execution chat (`execution: "client"`).
//
// Quota is charged once per user edit turn, not per request. The request that STARTS a turn
// (latest message is a user message) is charged. Its `status: "tool_calls"` response carries a
// `turnToken`. The client echoes it on the continuation that posts the tool results. A
// continuation with a valid, unused token is not charged. A missing, invalid, expired or reused token
// is charged as a new turn (never rejected), so old clients keep working.
//
// Token = "v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256)>", opaque to clients.
// Payload: { u: user id, t: turn id, c: [tool call ids of this round], e: expiry ms }.
// - The turn id is a hash of the turn's user message (its position and text), so a token can't be moved to
//   another prompt.
// - `c` binds the token to the tool calls the server issued in that round.
// - Each token is redeemable once per purpose (in-memory, per process), so replaying a
//   continuation doesn't get free inference. After a restart an unused token can be redeemed
//   again until it expires (at most one extra free round).
//
// Secret: TURN_TOKEN_SECRET, else SESSION_SECRET, else a random per-process secret (tokens then
// stop validating after a restart, which only means those continuations are charged).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { normalizeClientMessages } from './clientExecution.js';

export const TURN_TOKEN_TTL_MS = 30 * 60 * 1000;
const VERSION = 'v1';
let processSecret = null;

function secret(env = process.env) {
  const configured = env.TURN_TOKEN_SECRET || env.SESSION_SECRET;
  if (configured) return String(configured);
  if (!processSecret) processSecret = randomBytes(32).toString('hex');
  return processSecret;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadB64, env) {
  return createHmac('sha256', secret(env)).update(`${VERSION}.${payloadB64}`).digest('base64url');
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (typeof p === 'string' ? p : (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')))
    .filter(Boolean).join('\n');
}

/** Turn id: hash of the last user message's index and text (null when there is none). */
export function turnIdFor(messages) {
  if (!Array.isArray(messages)) return null;
  let idx = -1;
  messages.forEach((m, i) => { if (m?.role === 'user') idx = i; });
  if (idx < 0) return null;
  return createHash('sha256').update(`${idx}\n${messageText(messages[idx].content)}`).digest('base64url').slice(0, 22);
}

/** Issue a token for one tool-call round of a turn. */
export function issueTurnToken({ userId, turnId, toolCallIds = [], now = Date.now(), env = process.env }) {
  if (userId === undefined || userId === null || !turnId) return null;
  const payload = { u: String(userId), t: turnId, c: toolCallIds.map(String), e: now + TURN_TOKEN_TTL_MS };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `${VERSION}.${payloadB64}.${sign(payloadB64, env)}`;
}

/** Verify signature, user and expiry. Returns { payload, sig } or null. */
export function verifyTurnToken(token, { userId, now = Date.now(), env = process.env } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payloadB64, sig] = parts;
  const expected = Buffer.from(sign(payloadB64, env));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.c)) return null;
  if (userId === undefined || userId === null || payload.u !== String(userId)) return null;
  if (!Number.isFinite(payload.e) || payload.e < now) return null;
  return { payload, sig };
}

// ─── One-time redemption (per process) ────────────────────────────────────────
const redeemed = new Map(); // key → expiry ms

/** Mark `key` used; true only the first time (until the token expires). */
export function redeemOnce(key, expiresAt, now = Date.now()) {
  for (const [k, exp] of redeemed) if (exp < now) redeemed.delete(k);
  if (redeemed.has(key)) return false;
  redeemed.set(key, expiresAt);
  return true;
}

/** Test helper. */
export function resetRedeemedTurnTokens() {
  redeemed.clear();
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].map(String).sort();
  const sb = [...b].map(String).sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * Is this chat request a free continuation of an already-charged client-mode turn?
 * Requires: execution "client", latest message is a tool result, a valid unused `turnToken`
 * for this user whose turn id matches the conversation's last user message and whose tool
 * call ids match the latest assistant tool-call round. Redeems the token when it returns true.
 */
export function isFreeClientContinuation(req, { now = Date.now(), env = process.env } = {}) {
  const body = req?.body;
  if (!body || body.execution !== 'client' || typeof body.turnToken !== 'string') return false;
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length || messages.at(-1)?.role !== 'tool') return false;
  const verified = verifyTurnToken(body.turnToken, { userId: req.user?.id, now, env });
  if (!verified) return false;
  // Same normalization as the chat handler (the turn id was computed on it when issued).
  let conversation;
  try {
    conversation = normalizeClientMessages(messages);
  } catch {
    return false;
  }
  if (verified.payload.t !== turnIdFor(conversation)) return false;
  let lastAssistant = null;
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i].role === 'user') break;
    if (conversation[i].role === 'assistant' && conversation[i].tool_calls?.length) {
      lastAssistant = conversation[i];
      break;
    }
  }
  if (!lastAssistant) return false;
  if (!sameIds(lastAssistant.tool_calls.map(c => c?.id), verified.payload.c)) return false;
  return redeemOnce(`${verified.sig}:chat`, verified.payload.e, now);
}

/**
 * Is this media request (job / process-video / captions) the server run of a tool call from an
 * already-charged client-mode turn? Headers: `X-Turn-Token` (the round's turnToken) and
 * `X-Tool-Call-Id` (one of that round's tool call ids). Each tool call id is free once.
 */
export function isFreeToolCallRun(req, { now = Date.now(), env = process.env } = {}) {
  const token = req?.headers?.['x-turn-token'];
  const callId = req?.headers?.['x-tool-call-id'];
  if (typeof token !== 'string' || typeof callId !== 'string' || !callId) return false;
  const verified = verifyTurnToken(token, { userId: req.user?.id, now, env });
  if (!verified || !verified.payload.c.includes(callId)) return false;
  return redeemOnce(`${verified.sig}:call:${callId}`, verified.payload.e, now);
}

/** Already-paid work that must not be charged again (see the two helpers above). */
export function isChargeExempt(req) {
  return isFreeClientContinuation(req) || isFreeToolCallRun(req);
}
