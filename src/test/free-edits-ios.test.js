// @vitest-environment node
// FREE_EDITS_IOS=unlimited: no free-edit limit for iOS clients; web paywall unchanged.
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
import { authRouter } from '../server/auth.js';
import { chatRouter } from '../server/chat.js';
import { requireAuthenticatedUser, requireInferenceAccess } from '../server/middleware.js';
import {
  hasUnlimitedFreeEdits,
  isFreeEditsIosUnlimited,
  isIosClient,
  parseFinalCapIosUserAgent,
} from '../server/clientInfo.js';

const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const BUILD9_UA = 'FinalCap/9 CFNetwork/1498.700.2 Darwin/23.6.0'; // default URLSession UA, no FinalCap-iOS
const IOS10_UA = 'FinalCap-iOS/10';

// Test users. Fixture tokens only (not real credentials).
const DEVICE_USER = { id: 7, has_subscription: 0, device_install_id: '550e8400-e29b-41d4-a716-446655440000', name: 'iOS device' };
const GOOGLE_MOBILE_USER = { id: 8, has_subscription: 0, device_install_id: null, email: 'm@example.com' };
const WEB_USER = { id: 9, has_subscription: false, device_install_id: null, email: 'w@example.com' };
const WEB_USER_WITH_DEVICE_ID = { id: 10, has_subscription: false, device_install_id: '650e8400-e29b-41d4-a716-446655440000' };
const PAID_WEB_USER = { id: 11, has_subscription: true, device_install_id: null };

let server;
let base;
const realFetch = globalThis.fetch;
const xaiResponses = [];

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).startsWith('https://api.x.ai/')) {
      return new Response(JSON.stringify(xaiResponses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  });
  const app = express();
  app.use(express.json());
  // Simulated passport cookie session (what the web app uses): x-test-session: <user key>.
  const sessions = { web: WEB_USER, webDevice: WEB_USER_WITH_DEVICE_ID, paid: PAID_WEB_USER };
  app.use((req, _res, next) => {
    const u = sessions[req.headers['x-test-session']];
    req.isAuthenticated = () => Boolean(u);
    if (u) req.user = { ...u };
    next();
  });
  app.post('/metered', requireAuthenticatedUser, requireInferenceAccess, (req, res) => res.json({ ok: true }));
  app.use(authRouter);
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
  db.findUserByApiToken.mockImplementation(async (token) => ({
    'device-token': { ...DEVICE_USER },
    'google-token': { ...GOOGLE_MOBILE_USER },
  }[token] || null));
  // Today's quota: exhausted (3/3) → 429 daily_limit_reached when enforced.
  db.consumeDailyInference.mockResolvedValue({ allowed: false, limit: 3, used: 3, remaining: 0, resetsAt: '2026-09-27' });
  db.getDailyInferenceUsage.mockResolvedValue({ limit: 3, used: 3, remaining: 0, resetsAt: '2026-09-27' });
  db.recordDailyInference.mockResolvedValue({ used: 4 });
  xaiResponses.length = 0;
});

afterEach(() => { delete process.env.FREE_EDITS_IOS; });

function call(pathname, { ua, bearer, session, method = 'POST', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ua) headers['User-Agent'] = ua;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (session) headers['x-test-session'] = session;
  return realFetch(`${base}${pathname}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
}

describe('clientInfo helpers', () => {
  it('FREE_EDITS_IOS only turns on for "unlimited"', () => {
    expect(isFreeEditsIosUnlimited({ FREE_EDITS_IOS: 'unlimited' })).toBe(true);
    expect(isFreeEditsIosUnlimited({ FREE_EDITS_IOS: ' Unlimited ' })).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'true', '3', 'unlimit', 'no-limit']) {
      expect(isFreeEditsIosUnlimited({ FREE_EDITS_IOS: v })).toBe(false);
    }
  });

  it('iOS client = Bearer auth, or FinalCap-iOS UA on a non-cookie request; never a cookie session', () => {
    expect(isIosClient({ authMethod: 'bearer', headers: { 'user-agent': BUILD9_UA } })).toBe(true);
    expect(isIosClient({ authMethod: 'bearer', headers: {} })).toBe(true);
    expect(isIosClient({ headers: { 'user-agent': IOS10_UA } })).toBe(true);
    expect(isIosClient({ authMethod: 'session', headers: { 'user-agent': IOS10_UA } })).toBe(false);
    expect(isIosClient({ authMethod: 'session', headers: { 'user-agent': WEB_UA } })).toBe(false);
    expect(isIosClient({ headers: { 'user-agent': WEB_UA } })).toBe(false);
    expect(isIosClient({ headers: { 'user-agent': BUILD9_UA } })).toBe(false); // build 9 is identified by Bearer, not UA
    expect(parseFinalCapIosUserAgent(IOS10_UA)).toEqual({ isFinalCapIos: true, build: 10 });
    expect(hasUnlimitedFreeEdits({ authMethod: 'bearer' }, {})).toBe(false);
    expect(hasUnlimitedFreeEdits({ authMethod: 'bearer' }, { FREE_EDITS_IOS: 'unlimited' })).toBe(true);
  });
});

describe('FREE_EDITS_IOS unset: today\'s behavior', () => {
  it('iOS device user at the limit gets 429 daily_limit_reached (build 9 and FinalCap-iOS UA)', async () => {
    for (const ua of [BUILD9_UA, IOS10_UA]) {
      const res = await call('/metered', { ua, bearer: 'device-token' });
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ code: 'daily_limit_reached', dailyLimit: 3, dailyRemaining: 0 });
    }
    expect(db.consumeDailyInference).toHaveBeenCalledWith(7, 3);
    expect(db.recordDailyInference).not.toHaveBeenCalled();
  });

  it('auth status keeps the numeric quota fields and no unlimited flag', async () => {
    const res = await call('/api/auth/status', { method: 'GET', ua: BUILD9_UA, bearer: 'device-token' });
    const body = await res.json();
    expect(body).toMatchObject({ authenticated: true, authMethod: 'bearer', dailyLimit: 3, dailyUsed: 3, dailyRemaining: 0 });
    expect(body).not.toHaveProperty('unlimited');
  });

  it('Google mobile Bearer user without a subscription still gets 403', async () => {
    const res = await call('/metered', { ua: IOS10_UA, bearer: 'google-token' });
    expect(res.status).toBe(403);
  });
});

describe('FREE_EDITS_IOS=unlimited', () => {
  beforeEach(() => { process.env.FREE_EDITS_IOS = 'unlimited'; });

  it('iOS UA (FinalCap-iOS/10) with the device Bearer: never blocked, usage still counted', async () => {
    const res = await call('/metered', { ua: IOS10_UA, bearer: 'device-token' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-inference-unlimited')).toBe('true');
    expect(res.headers.get('x-inference-daily-used')).toBe('4');
    expect(db.recordDailyInference).toHaveBeenCalledWith(7);
    expect(db.consumeDailyInference).not.toHaveBeenCalled();
  });

  it('build 9 (default URLSession UA, device Bearer): unlimited', async () => {
    const res = await call('/metered', { ua: BUILD9_UA, bearer: 'device-token' });
    expect(res.status).toBe(200);
    expect(db.recordDailyInference).toHaveBeenCalledWith(7);
  });

  it('iOS Google-sign-in Bearer user without a subscription: unlimited (no 403 paywall)', async () => {
    const res = await call('/metered', { ua: BUILD9_UA, bearer: 'google-token' });
    expect(res.status).toBe(200);
    expect(db.recordDailyInference).toHaveBeenCalledWith(8);
  });

  it('a counting failure never blocks an iOS request', async () => {
    db.recordDailyInference.mockRejectedValue(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/metered', { ua: IOS10_UA, bearer: 'device-token' });
    expect(res.status).toBe(200);
    spy.mockRestore();
  });

  it('auth status (what build 9 reads) says unlimited, with null limit/remaining so no "0 free left"', async () => {
    for (const ua of [BUILD9_UA, IOS10_UA]) {
      const body = await (await call('/api/auth/status', { method: 'GET', ua, bearer: 'device-token' })).json();
      expect(body).toEqual({
        authenticated: true,
        authMethod: 'bearer',
        user: { id: '7', name: 'iOS device', hasSubscription: false },
        unlimited: true,
        dailyLimit: null,
        dailyUsed: 3,
        dailyRemaining: null,
        dailyResetsAt: '2026-09-27',
      });
    }
  });

  it('web cookie user without a subscription is still paywalled (403), even with a FinalCap-iOS UA', async () => {
    for (const ua of [WEB_UA, IOS10_UA]) {
      const res = await call('/metered', { ua, session: 'web' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Active subscription required' });
    }
    expect(db.recordDailyInference).not.toHaveBeenCalled();
  });

  it('a cookie-session user who has a device id keeps the normal limit (429)', async () => {
    const res = await call('/metered', { ua: IOS10_UA, session: 'webDevice' });
    expect(res.status).toBe(429);
    expect(db.consumeDailyInference).toHaveBeenCalledWith(10, 3);
  });

  it('web cookie auth status has no unlimited flag', async () => {
    const body = await (await call('/api/auth/status', { method: 'GET', ua: IOS10_UA, session: 'web' })).json();
    expect(body.authenticated).toBe(true);
    expect(body).not.toHaveProperty('unlimited');
  });

  it('paid users are unaffected', async () => {
    expect((await call('/metered', { ua: WEB_UA, session: 'paid' })).status).toBe(200);
    expect(db.recordDailyInference).not.toHaveBeenCalled();
    expect(db.consumeDailyInference).not.toHaveBeenCalled();
  });

  it('client-mode chat turns are counted per request and logged as edit turns', async () => {
    xaiResponses.push({ choices: [{ message: { role: 'assistant', content: 'Answer:\nTrimmed it.' } }] });
    const res = await call('/api/chat', {
      ua: IOS10_UA,
      bearer: 'device-token',
      body: {
        execution: 'client',
        media: { type: 'video' },
        messages: [
          { role: 'user', content: 'trim to 3s' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'trim_video', arguments: '{"start":"0","end":"3"}' } }] },
          { role: 'tool', tool_call_id: 'c1', content: '{"ok":true,"executedOn":"device"}' },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('final');
    expect(db.recordDailyInference).toHaveBeenCalledWith(7);
    const final = db.enqueueChatInteraction.mock.calls.map(c => c[0]).find(c => c.interactionType === 'ai2human');
    expect(final.metadata).toMatchObject({ execution: 'client', toolRounds: 1, okToolResults: 1, editTurnCompleted: true, iosClient: true });
  });
});
