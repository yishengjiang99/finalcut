// @vitest-environment node
// Quota: one charge per client-mode edit turn, via a signed turnToken on continuations.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const db = vi.hoisted(() => ({
  findUserByApiToken: vi.fn(),
  consumeDailyInference: vi.fn(),
  recordDailyInference: vi.fn(),
  getDailyInferenceUsage: vi.fn(),
  enqueueChatInteraction: vi.fn(),
  saveLesson: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../db.js', () => db);

import express from 'express';
import { chatRouter } from '../server/chat.js';
import { requireAuthenticatedUser, requireInferenceAccess } from '../server/middleware.js';
import {
  TURN_TOKEN_TTL_MS,
  issueTurnToken,
  redeemOnce,
  resetRedeemedTurnTokens,
  turnIdFor,
  verifyTurnToken,
} from '../server/turnToken.js';

const DEVICE_USER = { id: 7, has_subscription: 0, device_install_id: '550e8400-e29b-41d4-a716-446655440000' };
const OTHER_DEVICE_USER = { id: 8, has_subscription: 0, device_install_id: '650e8400-e29b-41d4-a716-446655440000' };

describe('turnToken helpers', () => {
  const env = { TURN_TOKEN_SECRET: 'test-only-turn-secret' };
  const msgs = [{ role: 'user', content: 'trim to 3s' }];

  it('round-trips and binds user, turn, tool calls and expiry', () => {
    const now = 1_000_000;
    const token = issueTurnToken({ userId: 7, turnId: turnIdFor(msgs), toolCallIds: ['c1', 'c2'], now, env });
    expect(token).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    const ok = verifyTurnToken(token, { userId: 7, now, env });
    expect(ok.payload).toEqual({ u: '7', t: turnIdFor(msgs), c: ['c1', 'c2'], e: now + TURN_TOKEN_TTL_MS });
    expect(verifyTurnToken(token, { userId: 8, now, env })).toBeNull();
    expect(verifyTurnToken(token, { userId: 7, now: now + TURN_TOKEN_TTL_MS + 1, env })).toBeNull();
    expect(verifyTurnToken(token, { userId: 7, now, env: { TURN_TOKEN_SECRET: 'other' } })).toBeNull();
    const [v, payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: '7', t: 'x', c: ['c9'], e: now + 9e9 })).toString('base64url');
    expect(verifyTurnToken(`${v}.${forged}.${sig}`, { userId: 7, now, env })).toBeNull();
    expect(verifyTurnToken(`v2.${payload}.${sig}`, { userId: 7, now, env })).toBeNull();
    expect(verifyTurnToken('garbage', { userId: 7, now, env })).toBeNull();
    expect(verifyTurnToken(undefined, { userId: 7, now, env })).toBeNull();
  });

  it('secret: TURN_TOKEN_SECRET, else SESSION_SECRET', () => {
    const now = 5;
    const a = issueTurnToken({ userId: 1, turnId: 't', now, env: { SESSION_SECRET: 's1' } });
    expect(verifyTurnToken(a, { userId: 1, now, env: { SESSION_SECRET: 's1' } })).not.toBeNull();
    expect(verifyTurnToken(a, { userId: 1, now, env: { SESSION_SECRET: 's2' } })).toBeNull();
    expect(verifyTurnToken(a, { userId: 1, now, env: { TURN_TOKEN_SECRET: 'x', SESSION_SECRET: 's1' } })).toBeNull();
  });

  it('turn id depends on the last user message text and position', () => {
    const a = turnIdFor([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'b' }]);
    expect(a).toBe(turnIdFor([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'b' }, { role: 'tool', tool_call_id: 'c', content: '{}' }]));
    expect(a).not.toBe(turnIdFor([{ role: 'user', content: 'b' }]));
    expect(a).not.toBe(turnIdFor([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'c' }]));
    expect(turnIdFor([{ role: 'assistant', content: 'x' }])).toBeNull();
  });

  it('redeemOnce is one-time until expiry', () => {
    resetRedeemedTurnTokens();
    expect(redeemOnce('k', 100, 0)).toBe(true);
    expect(redeemOnce('k', 100, 50)).toBe(false);
    expect(redeemOnce('k', 300, 200)).toBe(true); // expired entry was purged
  });
});

// ─── HTTP: /api/chat client mode + a metered media route ──────────────────────
let server;
let base;
const realFetch = globalThis.fetch;
const xai = [];

function completion(message) {
  return { choices: [{ message: { role: 'assistant', ...message } }] };
}
const toolRound = (ids, name = 'trim_video') => completion({
  content: null,
  tool_calls: ids.map(id => ({ id, type: 'function', function: { name, arguments: '{"start":"0","end":"3"}' } })),
});
const finalAnswer = completion({ content: 'Answer:\nDone.' });

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).startsWith('https://api.x.ai/')) {
      return new Response(JSON.stringify(xai.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  });
  const app = express();
  app.use(express.json());
  app.post('/api/jobs/process-video-test', requireAuthenticatedUser, requireInferenceAccess, (req, res) => res.json({ ok: true }));
  app.use(chatRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset?.();
  db.saveLesson.mockResolvedValue(undefined);
  db.findUserByApiToken.mockImplementation(async (t) => ({ 'dev-7': { ...DEVICE_USER }, 'dev-8': { ...OTHER_DEVICE_USER } }[t] || null));
  db.consumeDailyInference.mockResolvedValue({ allowed: true, limit: 3, used: 1, remaining: 2, resetsAt: 'x' });
  db.recordDailyInference.mockResolvedValue({ used: 1 });
  xai.length = 0;
  resetRedeemedTurnTokens();
});

afterEach(() => { delete process.env.FREE_EDITS_IOS; });

function chat(body, bearer = 'dev-7') {
  return realFetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`, 'User-Agent': 'FinalCap-iOS/10' },
    body: JSON.stringify(body),
  });
}

const start = { execution: 'client', media: { type: 'video' }, messages: [{ role: 'user', content: 'trim to 3s' }] };
const withResults = (prev, ids = prev.toolCalls.map(c => c.id)) => [
  ...prev.messages,
  ...ids.map(id => ({ role: 'tool', tool_call_id: id, content: { ok: true, executedOn: 'device' } })),
];

async function startTurn(ids = ['c1']) {
  xai.push(toolRound(ids));
  const res = await chat(start);
  expect(res.status).toBe(200);
  return res.json();
}

describe('client-mode charging: one per edit turn', () => {
  it('the turn start is charged and returns a turnToken', async () => {
    const first = await startTurn();
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ schemaVersion: '1', status: 'tool_calls' });
    expect(typeof first.turnToken).toBe('string');
  });

  it('a continuation echoing turnToken is not charged', async () => {
    const first = await startTurn();
    xai.push(finalAnswer);
    const res = await chat({ ...start, messages: withResults(first), turnToken: first.turnToken });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-inference-charged')).toBe('false');
    expect((await res.json()).status).toBe('final');
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(1);
  });

  it('multi-round turn: each round\'s new token keeps it free', async () => {
    const first = await startTurn(['c1']);
    xai.push(toolRound(['c2'], 'adjust_brightness'));
    const second = await (await chat({ ...start, messages: withResults(first), turnToken: first.turnToken })).json();
    expect(second.status).toBe('tool_calls');
    expect(second.turnToken).not.toBe(first.turnToken);
    xai.push(finalAnswer);
    const third = await chat({ ...start, messages: withResults(second), turnToken: second.turnToken });
    expect((await third.json()).status).toBe('final');
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(1);
  });

  it('missing, replayed, foreign or mismatched tokens are charged as a new turn (not rejected)', async () => {
    const first = await startTurn(['c1']);
    const cont = { ...start, messages: withResults(first) };
    const cases = [
      { ...cont }, // no token (old client)
      { ...cont, turnToken: 'v1.bogus.sig' },
    ];
    for (const body of cases) {
      xai.push(finalAnswer);
      expect((await chat(body)).status).toBe(200);
    }
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(3);

    // Valid once, then a replay of the same continuation is charged.
    xai.push(finalAnswer);
    await chat({ ...cont, turnToken: first.turnToken });
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(3);
    xai.push(finalAnswer);
    await chat({ ...cont, turnToken: first.turnToken });
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(4);

    // Another user's token.
    resetRedeemedTurnTokens();
    xai.push(finalAnswer);
    await chat({ ...cont, turnToken: first.turnToken }, 'dev-8');
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(5);

    // Token moved to a different prompt (same fake tool round).
    resetRedeemedTurnTokens();
    const moved = cont.messages.map((m, i) => (i === 0 ? { role: 'user', content: 'something else entirely' } : m));
    xai.push(finalAnswer);
    await chat({ ...start, messages: moved, turnToken: first.turnToken });
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(6);

    // Fabricated tool-call round (ids the server never issued).
    resetRedeemedTurnTokens();
    const fake = [start.messages[0],
      { role: 'assistant', content: null, tool_calls: [{ id: 'zz', type: 'function', function: { name: 'trim_video', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'zz', content: { ok: true } }];
    xai.push(finalAnswer);
    await chat({ ...start, messages: fake, turnToken: first.turnToken });
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(7);
  });

  it('a new user message with an old token starts (and is charged as) a new turn', async () => {
    const first = await startTurn();
    const next = [...withResults(first), { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'now brighten' }];
    xai.push(finalAnswer);
    await chat({ ...start, messages: next, turnToken: first.turnToken });
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(2);
  });

  it('at the limit: a new turn gets 429, but a paid turn can still finish', async () => {
    const first = await startTurn();
    db.consumeDailyInference.mockResolvedValue({ allowed: false, limit: 3, used: 3, remaining: 0, resetsAt: 'x' });
    xai.push(finalAnswer);
    const cont = await chat({ ...start, messages: withResults(first), turnToken: first.turnToken });
    expect(cont.status).toBe(200);
    const fresh = await chat(start);
    expect(fresh.status).toBe(429);
    expect((await fresh.json()).code).toBe('daily_limit_reached');
  });

  it('FREE_EDITS_IOS=unlimited: counted once per turn too', async () => {
    process.env.FREE_EDITS_IOS = 'unlimited';
    const first = await startTurn();
    xai.push(finalAnswer);
    await chat({ ...start, messages: withResults(first), turnToken: first.turnToken });
    expect(db.recordDailyInference).toHaveBeenCalledTimes(1);
    expect(db.consumeDailyInference).not.toHaveBeenCalled();
  });
});

describe('media routes: server run of a charged turn\'s tool call', () => {
  function media(headers) {
    return realFetch(`${base}/api/jobs/process-video-test`, { method: 'POST', headers: { Authorization: 'Bearer dev-7', ...headers } });
  }

  it('X-Turn-Token + X-Tool-Call-Id from the turn: free once per tool call', async () => {
    const first = await startTurn(['c1', 'c2']);
    db.consumeDailyInference.mockClear();
    expect((await media({ 'X-Turn-Token': first.turnToken, 'X-Tool-Call-Id': 'c1' })).status).toBe(200);
    expect((await media({ 'X-Turn-Token': first.turnToken, 'X-Tool-Call-Id': 'c2' })).status).toBe(200);
    expect(db.consumeDailyInference).not.toHaveBeenCalled();
    await media({ 'X-Turn-Token': first.turnToken, 'X-Tool-Call-Id': 'c1' }); // reuse → charged
    await media({ 'X-Turn-Token': first.turnToken, 'X-Tool-Call-Id': 'c9' }); // not in the round → charged
    await media({}); // no headers (build 9, web-style) → charged as today
    expect(db.consumeDailyInference).toHaveBeenCalledTimes(3);
  });
});
