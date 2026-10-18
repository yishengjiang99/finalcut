// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';

vi.mock('../server/middleware.js', () => ({
  attachBearerUser: async (req) => {
    const m = /^Bearer (u\d+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    req.user = { id: Number(m[1].slice(1)) };
    req.authMethod = 'bearer';
    return true;
  },
}));

const { featuresFrom, matchSegments, SEGMENTS } = await import('../server/push/segments.js');
const { validateCopy, templateCopy, generateCopy, setCopyFetchForTests, memoryCopyCache } = await import('../server/push/copy.js');
const { runLifecycleTick, lifecycleReport, effectiveMode, autoGuard } = await import('../server/push/lifecycle.js');
const { createMemoryPushStore } = await import('../server/push/store.js');
const { pushRouter, setPushStoreForTests } = await import('../server/push/router.js');

const D = 24 * 3600_000;
// 18:00 UTC = 11:00 in Los Angeles (inside the 10–20 send window)
const NOW = new Date('2026-10-10T18:00:00Z');
const tok = (n) => String(n).padStart(2, '0').repeat(32);
const template = async (seg, goal, facts) => ({ ...templateCopy(seg, facts), source: 'template' });

function world({ ageDays = 1.2, marketing = false, tz = 'America/Los_Angeles', edits = [], events = [], hasSubscription = false, env = 'production' } = {}) {
  const users = [{ id: 1, installId: 'inst-1', createdAt: new Date(NOW - ageDays * D), hasSubscription }];
  const store = createMemoryPushStore({ users, activity: new Map([[1, { edits, events }]]) });
  store.upsertDevice({ userId: 1, token: tok(1), environment: env, tz, marketingOptIn: marketing });
  return store;
}

describe('segments', () => {
  it('onboarding d1 for a day-old install; edit_not_exported needs app-reported events', () => {
    const f = featuresFrom({ createdAt: new Date(NOW - 1.2 * D), edits: [], events: [], hasSubscription: false }, NOW);
    expect(matchSegments(f, NOW).map((m) => m.segment.id)).toEqual(['onboarding_d1']);
    const edited = featuresFrom({ createdAt: new Date(NOW - 10 * D), edits: [{ day: '2026-10-10', count: 3, lastAt: new Date(NOW - 5 * 3600_000) }], events: [{ event: 'app_open', at: new Date(NOW - 5 * 3600_000) }] }, NOW);
    expect(matchSegments(edited, NOW)[0].segment.id).toBe('edit_not_exported');
    const exported = featuresFrom({ createdAt: new Date(NOW - 10 * D), edits: [{ day: '2026-10-10', count: 3, lastAt: new Date(NOW - 5 * 3600_000) }], events: [{ event: 'export_done', at: new Date(NOW - 4 * 3600_000) }] }, NOW);
    expect(matchSegments(exported, NOW).map((m) => m.segment.id)).not.toContain('edit_not_exported');
  });
  it('paywall segment only for free users and never when iOS edits are free/unlimited', () => {
    const f = featuresFrom({ createdAt: new Date(NOW - 20 * D), edits: [], events: [{ event: 'paywall_view', at: new Date(NOW - 30 * 3600_000) }] }, NOW);
    expect(matchSegments(f, NOW).map((m) => m.segment.id)).toContain('paywall_not_converted');
    expect(matchSegments(f, NOW, { paywallEnabled: false }).map((m) => m.segment.id)).not.toContain('paywall_not_converted');
    const pro = featuresFrom({ createdAt: new Date(NOW - 20 * D), hasSubscription: true, edits: [], events: [{ event: 'paywall_view', at: new Date(NOW - 30 * 3600_000) }] }, NOW);
    expect(matchSegments(pro, NOW).map((m) => m.segment.id)).not.toContain('paywall_not_converted');
  });
  it('inactive ladder 7 / 14 / 30 and silence after 45 days', () => {
    const at = (d) => matchSegments(featuresFrom({ createdAt: new Date(NOW - 90 * D), edits: [{ day: 'x', count: 1, lastAt: new Date(NOW - d * D) }], events: [] }, NOW), NOW).map((m) => m.segment.id);
    expect(at(8)).toEqual(['inactive_7']);
    expect(at(15)).toEqual(['inactive_14']);
    expect(at(31)).toEqual(['winback_30']);
    expect(at(50)).toEqual([]);
  });
});

describe('copy guardrails', () => {
  it('every template passes its own guardrails', () => {
    for (const id of Object.keys(SEGMENTS)) expect(validateCopy(templateCopy(id, { tier: 'free', announcement: 'Lyric captions are in the app.' }), id, { tier: 'free' })).toEqual([]);
  });
  it('rejects urgency, prices, trials, surveillance tone and upsell outside the paywall', () => {
    expect(validateCopy({ title: 'Hurry', body: 'Last chance to edit' }, 'inactive_7', {})).toContain('urgency');
    expect(validateCopy({ title: 'Pro', body: 'Only $9.99 a month' }, 'paywall_not_converted', {})).toContain('price_or_discount');
    expect(validateCopy({ title: 'Pro', body: 'Start your free trial' }, 'paywall_not_converted', {})).toContain('free_or_trial_claim');
    expect(validateCopy({ title: 'Hi', body: "It's been two weeks since you last edited" }, 'inactive_14', {})).toContain('surveillance_tone');
    expect(validateCopy({ title: 'Go Pro', body: 'Upgrade for more edits' }, 'inactive_7', {})).toContain('upsell_outside_paywall_segment');
    expect(validateCopy({ title: 'Pro', body: 'Pro unlocks all effects and 4K export' }, 'paywall_not_converted', {})).toContain('unverified_pro_benefit');
    expect(validateCopy({ title: 'x'.repeat(41), body: 'ok' }, 'inactive_7', {})).toContain('title_too_long');
  });
  it('falls back to the template when Grok fails or keeps breaking rules, and caches good copy', async () => {
    process.env.XAI_API_TOKEN = 'test-token';
    try {
      setCopyFetchForTests(async () => ({ ok: false, status: 500 }));
      const a = await generateCopy('inactive_7', 'g', { tier: 'free' }, { cache: memoryCopyCache, bypassCache: true });
      expect(a.source).toBe('template');
      setCopyFetchForTests(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"title":"Act now!","body":"Hurry, last chance"}' } }] }) }));
      expect((await generateCopy('inactive_7', 'g', { tier: 'free' }, { cache: memoryCopyCache, bypassCache: true })).source).toBe('template');
      setCopyFetchForTests(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"title":"A quick edit idea","body":"Open a clip and ask FinalCap to trim it to the best 10 seconds."}' } }] }) }));
      expect((await generateCopy('inactive_7', 'g', { tier: 'free', editsLastWeek: '0' }, { cache: memoryCopyCache })).source).toBe('grok');
      setCopyFetchForTests(async () => { throw new Error('should not be called'); });
      expect((await generateCopy('inactive_7', 'g', { tier: 'free', editsLastWeek: '0' }, { cache: memoryCopyCache })).source).toBe('cache');
    } finally { setCopyFetchForTests(null); delete process.env.XAI_API_TOKEN; }
  });
});

describe('lifecycle engine', () => {
  const sendSpy = () => vi.fn(async () => ({ ok: true, status: 200 }));
  const apnsEnv = { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_P8_CONTENTS: 'x' };

  it('defaults to dry_run: logs would_send, never calls APNs, dedupes the next tick', async () => {
    const store = world(); const send = sendSpy();
    const s = await runLifecycleTick({ store, send, copy: template, now: NOW, env: { ...apnsEnv } });
    expect(s.mode).toBe('dry_run');
    expect(s.wouldSend).toBe(1); expect(s.sent).toBe(0); expect(send).not.toHaveBeenCalled();
    const s2 = await runLifecycleTick({ store, send, copy: template, now: new Date(+NOW + 2 * D), env: {} });
    expect(s2.bySegment.onboarding_d1).toBeUndefined();
  });
  it('kill switch (env or ops) stops everything; ops can only downgrade', async () => {
    const store = world();
    expect((await runLifecycleTick({ store, copy: template, now: NOW, env: { PUSH_KILL_SWITCH: 'true' } })).evaluated).toBe(0);
    await store.setOp('kill_switch', 'on');
    expect((await runLifecycleTick({ store, copy: template, now: NOW, env: { PUSH_LIFECYCLE_MODE: 'live' } })).mode).toBe('off');
    await store.setOp('kill_switch', null);
    await store.setOp('mode', 'live');
    expect((await effectiveMode(store, { PUSH_LIFECYCLE_MODE: 'dry_run' })).mode).toBe('dry_run');
    await store.setOp('mode', 'dry_run');
    expect((await effectiveMode(store, { PUSH_LIFECYCLE_MODE: 'live' })).mode).toBe('dry_run');
  });
  it('quiet hours in the device time zone', async () => {
    const s = await runLifecycleTick({ store: world({ tz: 'Asia/Tokyo' }), copy: template, now: NOW, env: {} }); // 03:00 in Tokyo
    expect(s.skipped.quiet_hours).toBe(1); expect(s.wouldSend).toBe(0);
  });
  it('promotional segments need the Tips & offers opt-in', async () => {
    const edits = [{ day: 'x', count: 2, lastAt: new Date(NOW - 9 * D) }];
    expect((await runLifecycleTick({ store: world({ ageDays: 60, edits }), copy: template, now: NOW, env: {} })).skipped.no_segment).toBe(1);
    expect((await runLifecycleTick({ store: world({ ageDays: 60, edits, marketing: true }), copy: template, now: NOW, env: {} })).bySegment).toEqual({ inactive_7: 1 });
  });
  it('allowlist mode sends only to allowlisted installs, caps at 1/day, prunes dead tokens', async () => {
    const store = world(); const send = sendSpy();
    const off = await runLifecycleTick({ store, send, copy: template, now: NOW, env: { ...apnsEnv, PUSH_LIFECYCLE_MODE: 'allowlist', PUSH_LIFECYCLE_ALLOWLIST: 'someone-else' } });
    expect(off.sent).toBe(0); expect(send).not.toHaveBeenCalled();
    const on = await runLifecycleTick({ store, send, copy: template, now: NOW, env: { ...apnsEnv, PUSH_LIFECYCLE_MODE: 'allowlist', PUSH_LIFECYCLE_ALLOWLIST: 'inst-1' } });
    expect(on.sent).toBe(1);
    const payload = send.mock.calls[0][1];
    expect(payload).toMatchObject({ type: 'lifecycle', segment: 'onboarding_d1', destination: 'editor' });
    expect(payload.aps.alert.title.length).toBeLessThanOrEqual(40);
    // cap: an hour later nothing else goes out
    await store.recordEvent(1, 'paywall_view', null, new Date(+NOW - 30 * 3600_000));
    const again = await runLifecycleTick({ store, send, copy: template, now: new Date(+NOW + 3600_000), env: { ...apnsEnv, PUSH_LIFECYCLE_MODE: 'live' } });
    expect(again.sent).toBe(0);
    // dead token
    const dead = world();
    const s = await runLifecycleTick({ store: dead, send: async () => ({ ok: false, status: 410, reason: 'Unregistered' }), copy: template, now: NOW, env: { ...apnsEnv, PUSH_LIFECYCLE_MODE: 'live' } });
    expect(s.pruned).toBe(1); expect(s.failed).toBe(1);
    expect((await dead.listCandidates()).length).toBe(0);
  });
  it('auto guard trips the kill switch on >2% opt-outs since go-live (min 2 users)', async () => {
    const users = [1, 2, 3].map((id) => ({ id, createdAt: new Date(NOW - 30 * D) }));
    const store = createMemoryPushStore({ users });
    for (const u of users) await store.upsertDevice({ userId: u.id, token: tok(u.id), environment: 'production', tz: 'America/Los_Angeles' });
    await store.setOp('live_since', new Date(+NOW - D).toISOString());
    await store.recordEvent(1, 'marketing_opt_out', null, new Date(+NOW - 2 * D)); // before go-live: ignored
    await store.recordEvent(2, 'marketing_opt_out', null, new Date(+NOW - 3600_000));
    let g = await autoGuard(store, { now: NOW, env: {} });
    expect(g.optOuts).toBe(1); expect(g.tripped).toBe(false);
    await store.disableUserDevices(3, 'app_unregistered');
    g = await autoGuard(store, { now: new Date(), env: {} });
    expect(g.optOuts).toBe(2); expect(g.tripped).toBe(true);
    expect((await effectiveMode(store, { PUSH_LIFECYCLE_MODE: 'live' })).mode).toBe('off');
    expect((await store.getOps()).auto_kill).toMatch(/opt_out_rate/);
  });
  it('auto guard trips on APNs errors >20% of 10+ real sends; uninstalled tokens do not count', async () => {
    const store = createMemoryPushStore();
    for (let i = 0; i < 12; i++) {
      const [status, reason] = i < 6 ? ['failed', 'Unregistered'] : i < 9 ? ['sent', null] : ['failed', 'InvalidProviderToken'];
      await store.claimSend({ at: new Date(+NOW - 3600_000), sendId: `s${i}`, userId: i, segment: 'inactive_7', dedupeKey: 'k', dryRun: false, mode: 'live', status, reason });
    }
    const dry = await autoGuard(store, { now: NOW, env: {}, dryRun: true });
    expect(dry.apnsAttempts24h).toBe(12); expect(dry.apnsErrors24h).toBe(3); expect(dry.tripped).toBe(false);
    expect((await autoGuard(store, { now: NOW, env: {} })).tripped).toBe(true);
    expect((await store.getOps()).kill_switch).toBe('on');
  });
  it('report computes open rate and return-within-24h from real sends', async () => {
    const store = world(); const send = sendSpy();
    await runLifecycleTick({ store, send, copy: template, now: NOW, env: { ...apnsEnv, PUSH_LIFECYCLE_MODE: 'live' } });
    const sid = send.mock.calls[0][1].send_id;
    await store.recordEvent(1, 'push_opened', sid, new Date(+NOW + 60_000));
    await store.recordEvent(1, 'app_open', null, new Date(+NOW + 120_000));
    const r = await lifecycleReport(store, { now: new Date(+NOW + 3600_000), env: {} });
    expect(r.kpis.openRate).toBe(1); expect(r.kpis.returnWithin24h).toBe(1);
  });
});

describe('push routes', () => {
  let srv;
  afterEach(async () => { if (srv) await srv.close(); srv = null; setPushStoreForTests(null); delete process.env.PUSH_ADMIN_SECRET; });
  async function serve(store) {
    setPushStoreForTests(() => store);
    const app = express(); app.use(pushRouter);
    const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    srv = { close: () => new Promise((r) => s.close(r)) };
    return `http://127.0.0.1:${s.address().port}`;
  }
  const post = (url, body, headers = {}, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('register / prefs / events require a device session and validate input', async () => {
    const store = createMemoryPushStore({ users: [{ id: 7, createdAt: NOW }] });
    const base = await serve(store);
    expect((await post(`${base}/api/push/register`, { token: tok(3), environment: 'production' })).status).toBe(401);
    expect((await post(`${base}/api/push/register`, { token: 'nope', environment: 'production' }, { authorization: 'Bearer u7' })).status).toBe(400);
    const r = await post(`${base}/api/push/register`, { token: tok(3), environment: 'production', tz: 'Europe/Paris' }, { authorization: 'Bearer u7' });
    expect(await r.json()).toMatchObject({ ok: true, registered: true, marketingOptIn: false });
    const p = await post(`${base}/api/push/prefs`, { marketingOptIn: true }, { authorization: 'Bearer u7' }, 'PUT');
    expect((await p.json()).marketingOptIn).toBe(true);
    expect((await post(`${base}/api/push/events`, { event: 'prompt_text', sendId: 'x' }, { authorization: 'Bearer u7' })).status).toBe(400);
    expect((await post(`${base}/api/push/events`, { event: 'export_done' }, { authorization: 'Bearer u7' })).status).toBe(202);
    expect(store._events.map((e) => e.event)).toEqual(['marketing_opt_in', 'export_done']);
  });
  it('admin routes are 404 without the secret; tick via HTTP is forced dry-run', async () => {
    const store = world();
    const base = await serve(store);
    expect((await fetch(`${base}/api/push/lifecycle/report`)).status).toBe(404);
    process.env.PUSH_ADMIN_SECRET = 's'.repeat(32);
    expect((await fetch(`${base}/api/push/lifecycle/report`, { headers: { 'x-push-admin-secret': 'wrong'.padEnd(32, 'x') } })).status).toBe(404);
    const rep = await fetch(`${base}/api/push/lifecycle/report`, { headers: { 'x-push-admin-secret': 's'.repeat(32) } });
    expect((await rep.json()).mode).toBe('dry_run');
  });
});
