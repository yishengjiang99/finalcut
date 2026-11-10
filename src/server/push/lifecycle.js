// FinalCap push lifecycle engine. Always live (no mode / allowlist / env kill switch). Safety:
//   the auto guard below (and the admin ops route) can set ops kill_switch=on → nothing is evaluated
//   or sent until it is cleared; previews and the admin tick run with modeOverride 'dry_run'
//   caps: 1 real push per 24 h, 3 per rolling 7 days per user; send window 10:00–20:00 in the
//   device's own time zone; dedupe per (user, dedupe key); promotional segments need the in-app
//   "Tips & offers" opt-in (App Store Guideline 4.5.4); dead tokens (410 / Unregistered /
//   BadDeviceToken) are disabled immediately.
import crypto from 'crypto';
import { featuresFrom, matchSegments, copyFactsFor } from './segments.js';
import { generateCopy } from './copy.js';
import { sendApns, isApnsConfigured, isDeadTokenResult } from './apns.js';

export const MODES = ['off', 'dry_run', 'live'];
export const CAPS = Object.freeze({ perDay: 1, perWeek: 3 });
export const SEND_WINDOW = Object.freeze({ startHour: 10, endHour: 20 });
const MAX_REAL_SENDS_PER_TICK = 200;
const H = 3600_000;

// Live unless the safety breaker (ops kill_switch, set by autoGuard or an admin) is on.
export async function effectiveMode(store) {
  let ops = {};
  try { ops = await store.getOps(); } catch { /* DB down → be conservative */ return { mode: 'off', killSwitch: 'ops_unreadable' }; }
  if (ops.kill_switch === 'on') return { mode: 'off', killSwitch: 'ops' };
  return { mode: 'live', killSwitch: null };
}

export function localHour(tz, now = new Date()) {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(now);
    return Number(h) % 24;
  } catch { return null; }
}

function capReason(history, now) {
  const t = now.getTime();
  const counted = history.filter((s) => s.status === 'sent' || s.status === 'would_send' || s.status === 'pending');
  if (counted.some((s) => t - new Date(s.at).getTime() < 24 * H)) return 'cap_daily';
  if (counted.filter((s) => t - new Date(s.at).getTime() < 7 * 24 * H).length >= CAPS.perWeek) return 'cap_weekly';
  return null;
}

export function payloadFor({ title, body }, { sendId, segment, destination }) {
  return { aps: { alert: { title, body }, sound: 'default', 'thread-id': 'finalcap-lifecycle' }, type: 'lifecycle', send_id: sendId, segment, destination };
}

/**
 * Evaluate every registered device once. Returns a summary (no tokens, no install ids).
 * deps: { store, send = sendApns, copy = generateCopy, now, env, modeOverride ('dry_run' only, for previews) }
 */
export async function runLifecycleTick({ store, send = sendApns, copy = generateCopy, now = new Date(), env = process.env, modeOverride } = {}) {
  const eff = await effectiveMode(store, env);
  let mode = eff.mode;
  if (modeOverride === 'dry_run' && mode !== 'off') mode = 'dry_run';
  const summary = { at: now.toISOString(), mode, killSwitch: eff.killSwitch, evaluated: 0, matched: 0, sent: 0, wouldSend: 0, failed: 0, pruned: 0, skipped: {}, bySegment: {}, samples: [] };
  if (mode === 'off') return summary;
  if (mode !== 'dry_run') {
    const ops = await store.getOps();
    if (!ops.live_since) await store.setOp('live_since', now.toISOString());
  }
  const skip = (r) => { summary.skipped[r] = (summary.skipped[r] || 0) + 1; };
  const apnsReady = isApnsConfigured(env);
  const paywallEnabled = String(env.FREE_EDITS_IOS || '').trim().toLowerCase() !== 'unlimited';

  const candidates = await store.listCandidates();
  const activity = await store.loadActivity(candidates.map((c) => c.userId), now);
  let realSends = 0;
  for (const c of candidates) {
    summary.evaluated++;
    const tz = c.devices.find((d) => d.tz)?.tz || null;
    const hour = localHour(tz, now);
    if (hour === null || hour < SEND_WINDOW.startHour || hour >= SEND_WINDOW.endHour) { skip('quiet_hours'); continue; }
    const act = activity.get(c.userId) || { edits: [], events: [], lastSessionAt: null };
    const f = featuresFrom({ createdAt: c.createdAt, hasSubscription: c.hasSubscription, ...act }, now);
    const dryRun = mode === 'dry_run';
    const history = await store.sendHistory(c.userId, dryRun, now);
    const used = new Set(history.map((s) => s.dedupeKey));
    const usedAnnouncements = new Set([...used].filter((k) => k.startsWith('new_feature:')).map((k) => k.slice('new_feature:'.length)));
    const marketing = c.devices.some((d) => d.marketingOptIn);
    const matches = matchSegments(f, now, { usedAnnouncements, paywallEnabled })
      .filter((m) => !used.has(m.dedupeKey))
      .filter((m) => m.segment.cls === 'feature' || marketing);
    if (!matches.length) { skip('no_segment'); continue; }
    summary.matched++;
    const cap = capReason(history, now);
    if (cap) { skip(cap); continue; }
    const m = matches[0];
    const facts = copyFactsFor(f, m);
    const text = await copy(m.segment.id, m.announcement ? `${m.segment.goal} Feature: ${m.announcement.fact}` : m.segment.goal, facts, { now });

    const targets = mode === 'live' ? c.devices : [];
    const real = targets.length > 0 && apnsReady && realSends < MAX_REAL_SENDS_PER_TICK;

    const sendId = crypto.randomUUID();
    const row = { at: now, sendId, userId: c.userId, segment: m.segment.id, dedupeKey: m.dedupeKey, dryRun: !real && dryRun, mode, status: real ? 'pending' : 'would_send',
      reason: real ? null : !dryRun ? (targets.length ? 'apns_not_configured' : `not_targeted_in_${mode}`) : null,
      source: text.source, model: text.model ?? null, title: text.title, body: text.body };
    // Non-dry modes log non-targeted users as dry rows so they never burn a real dedupe slot.
    if (!real) row.dryRun = true;
    if (!(await store.claimSend(row))) { skip('dedupe'); continue; }
    summary.bySegment[m.segment.id] = (summary.bySegment[m.segment.id] || 0) + 1;
    if (summary.samples.length < 20) summary.samples.push({ segment: m.segment.id, cls: m.segment.cls, title: text.title, body: text.body, source: text.source, ...(text.rejected ? { rejected: text.rejected } : {}), real });
    if (!real) { summary.wouldSend++; continue; }

    realSends++;
    const payload = payloadFor(text, { sendId, segment: m.segment.id, destination: m.segment.destination });
    let anyOk = false; let lastReason = null;
    for (const d of targets) {
      const r = await send(d.token, payload, { environment: d.environment });
      if (r.ok) anyOk = true; else lastReason = r.reason || 'error';
      if (isDeadTokenResult(r)) { await store.disableDevice(d.token, String(r.reason || 'Unregistered').slice(0, 64)); summary.pruned++; }
    }
    await store.finishSend(sendId, anyOk ? 'sent' : 'failed', anyOk ? null : String(lastReason).slice(0, 80));
    if (anyOk) summary.sent++; else summary.failed++;
  }
  if (mode !== 'dry_run') {
    summary.guard = await autoGuard(store, { now, env });
  }
  return summary;
}

export const GUARD = Object.freeze({ optOutRateMax: 0.02, apnsErrorRateMax: 0.2, minApnsAttempts: 10 });
const guardMinOptOuts = (env) => Math.max(1, Number(env.PUSH_GUARD_MIN_OPTOUTS) || 2);
const DEAD_RE = /Unregistered|BadDeviceToken|http_410/;

/**
 * Auto kill switch: opt-outs (Tips & offers off, or notifications turned off → app unregisters)
 * by more than 2% of push users within 7 days of going live, or more than 20% of real APNs
 * sends failing in 24 h (uninstalled tokens excluded). Trips → ops kill_switch=on + log line.
 */
export async function autoGuard(store, { now = new Date(), env = process.env, dryRun = false } = {}) {
  const ops = await store.getOps();
  const live = ops.live_since ? Date.parse(ops.live_since) : now.getTime();
  const optOutSince = new Date(Math.max(now.getTime() - 7 * 24 * H, live));
  const st = await store.guardStats(optOutSince, new Date(now.getTime() - 24 * H));
  const base = st.activeUsers + st.optOuts;
  const optOutRate = base ? st.optOuts / base : null;
  const attempts = st.sends.length;
  const errors = st.sends.filter((x) => x.status === 'failed' && !DEAD_RE.test(x.reason || '')).length;
  const apnsErrorRate = attempts ? errors / attempts : null;
  let reason = null;
  if (optOutRate !== null && st.optOuts >= guardMinOptOuts(env) && optOutRate > GUARD.optOutRateMax) reason = `opt_out_rate ${(optOutRate * 100).toFixed(1)}% (${st.optOuts}/${base})`;
  else if (apnsErrorRate !== null && attempts >= GUARD.minApnsAttempts && apnsErrorRate > GUARD.apnsErrorRateMax) reason = `apns_error_rate ${(apnsErrorRate * 100).toFixed(1)}% (${errors}/${attempts})`;
  const tripped = Boolean(reason) && !dryRun && ops.kill_switch !== 'on';
  if (tripped) {
    await store.setOp('kill_switch', 'on');
    await store.setOp('auto_kill', `${now.toISOString()} ${reason}`.slice(0, 64));
    console.warn('[push-lifecycle] AUTO KILL SWITCH ON:', reason);
  }
  return { tripped, reason, windowStart: optOutSince.toISOString(), optOuts: st.optOuts, optOutBase: base, optOutRate, apnsAttempts24h: attempts, apnsErrors24h: errors, apnsErrorRate24h: apnsErrorRate };
}

/** KPIs: open rate (push_opened with send_id), return within 24 h (any app_open/export event within 24 h of a real send), opt-outs. */
export async function lifecycleReport(store, { days = 7, now = new Date(), env = process.env } = {}) {
  const since = new Date(now.getTime() - days * 24 * H);
  const { sends, events, devices } = await store.reportRows(since);
  const eff = await effectiveMode(store, env);
  const opened = new Set(events.filter((e) => e.event === 'push_opened' && e.sendId).map((e) => e.sendId));
  const seg = {};
  for (const s of sends) {
    const k = s.segment;
    const r = (seg[k] ||= { sent: 0, wouldSend: 0, failed: 0, opened: 0, returned24h: 0 });
    if (s.status === 'sent') {
      r.sent++;
      if (opened.has(s.sendId)) r.opened++;
      const t0 = new Date(s.at).getTime();
      if (events.some((e) => e.userId === s.userId && e.event !== 'push_opened' && !e.event.startsWith('marketing_') && new Date(e.at).getTime() > t0 && new Date(e.at).getTime() - t0 <= 24 * H)) r.returned24h++;
    } else if (s.status === 'would_send') r.wouldSend++;
    else if (s.status === 'failed') r.failed++;
  }
  const tot = Object.values(seg).reduce((a, r) => ({ sent: a.sent + r.sent, opened: a.opened + r.opened, returned24h: a.returned24h + r.returned24h }), { sent: 0, opened: 0, returned24h: 0 });
  const optOuts = events.filter((e) => e.event === 'marketing_opt_out').length;
  return {
    windowDays: days, mode: eff.mode, killSwitch: eff.killSwitch, apnsConfigured: isApnsConfigured(env), caps: CAPS, sendWindow: SEND_WINDOW,
    guard: { ...GUARD, minOptOuts: guardMinOptOuts(env), ...(await autoGuard(store, { now, env, dryRun: true })) },
    ops: await store.getOps().catch(() => ({})),
    devices, bySegment: seg,
    kpis: {
      openRate: tot.sent ? +(tot.opened / tot.sent).toFixed(3) : null,
      returnWithin24h: tot.sent ? +(tot.returned24h / tot.sent).toFixed(3) : null,
      marketingOptOuts: optOuts,
      tokensDisabled: devices.disabledInWindow,
      optOutRate: devices.active + devices.disabledInWindow ? +((optOuts + devices.disabledInWindow) / (devices.active + devices.disabledInWindow)).toFixed(3) : null,
    },
    recent: sends.slice(0, 25).map((s) => ({ segment: s.segment, status: s.status, dryRun: Boolean(s.dryRun), reason: s.reason, source: s.source, title: s.title, body: s.body, at: new Date(s.at).toISOString() })),
  };
}

let timer = null;
/** In-process scheduler (every 10 min, unref'd). Only real work when mode != off; dedupe key is the cross-process lock. */
export function scheduleLifecycle(storeFactory, { intervalMs = 10 * 60_000 } = {}) {
  if (timer || process.env.NODE_ENV === 'test') return;
  let running = false;
  let lastPurge = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const store = storeFactory();
      if (Date.now() - lastPurge > 24 * H) { lastPurge = Date.now(); await store.purgeOld().catch(() => {}); }
      const s = await runLifecycleTick({ store });
      if (s.mode !== 'off' && (s.sent || s.wouldSend || s.failed)) console.log('[push-lifecycle]', JSON.stringify({ mode: s.mode, sent: s.sent, wouldSend: s.wouldSend, failed: s.failed, pruned: s.pruned, bySegment: s.bySegment }));
    } catch (e) {
      console.warn('[push-lifecycle] tick failed:', e?.message || e);
    } finally { running = false; }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}
