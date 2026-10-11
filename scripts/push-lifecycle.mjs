// Push lifecycle ops, run ON the server from the app dir (uses the app's own .env and MySQL):
//   node scripts/push-lifecycle.mjs report [days]     KPIs + recent evaluations (no tokens/ids)
//   node scripts/push-lifecycle.mjs dry_run_tick      evaluate every device once, forced dry run
//   node scripts/push-lifecycle.mjs live_tick         one real tick, ONLY if the effective mode is live
//   node scripts/push-lifecycle.mjs guard             evaluate the auto kill-switch guardrails
//   node scripts/push-lifecycle.mjs apns_check        APNs auth check against a fake token (no user is contacted)
//   node scripts/push-lifecycle.mjs samples           generate copy for every segment (sends nothing)
//   node scripts/push-lifecycle.mjs kill_switch_on | kill_switch_off
// Used by .github/workflows/push-lifecycle.yml. Only live_tick can send real pushes.
import { getPool } from '../src/db.js';
import { createMysqlPushStore } from '../src/server/push/store.js';
import { runLifecycleTick, lifecycleReport, effectiveMode, autoGuard } from '../src/server/push/lifecycle.js';
import { sendApns, isApnsConfigured, APNS_TOPIC } from '../src/server/push/apns.js';
import { generateCopy } from '../src/server/push/copy.js';
import { SEGMENTS, FEATURE_ANNOUNCEMENTS } from '../src/server/push/segments.js';

const [cmd = 'report', arg] = process.argv.slice(2);
const store = createMysqlPushStore();
try {
  let out;
  if (cmd === 'report') out = await lifecycleReport(store, { days: Math.min(90, Math.max(1, Number(arg) || 7)) });
  else if (cmd === 'dry_run_tick') out = await runLifecycleTick({ store, modeOverride: 'dry_run' });
  else if (cmd === 'live_tick') {
    const eff = await effectiveMode(store);
    out = eff.mode === 'live' ? await runLifecycleTick({ store }) : { refused: `effective mode is ${eff.mode}, not live` };
  } else if (cmd === 'guard') out = await autoGuard(store);
  else if (cmd === 'apns_check') {
    // Auth check without contacting any user: a well-formed but nonexistent token. Apple answers
    // 400 BadDeviceToken when the JWT/key/topic are accepted, 403 InvalidProviderToken etc. when not.
    const fake = '0'.repeat(64);
    const probe = { aps: { alert: { title: 'auth check', body: 'not delivered' } } };
    out = { configured: isApnsConfigured(), topic: APNS_TOPIC() };
    for (const environment of ['sandbox', 'production']) {
      const r = await sendApns(fake, probe, { environment });
      out[environment] = { status: r.status ?? null, reason: r.reason ?? (r.ok ? 'ok' : null), authAccepted: r.status === 400 && r.reason === 'BadDeviceToken' };
    }
  }
  else if (cmd === 'kill_switch_on') { await store.setOp('kill_switch', 'on'); out = await effectiveMode(store); }
  else if (cmd === 'kill_switch_off') { await store.setOp('kill_switch', null); out = await effectiveMode(store); }
  else if (cmd === 'samples') {
    out = {};
    for (const s of Object.values(SEGMENTS)) {
      const ann = s.id === 'new_feature' ? FEATURE_ANNOUNCEMENTS[0] : null;
      const facts = { tier: 'free', editsLastWeek: s.id.startsWith('inactive') || s.id === 'winback_30' ? '0' : '1-3', hasExported: false, ...(ann ? { announcement: ann.fact } : {}) };
      out[s.id] = await generateCopy(s.id, ann ? `${s.goal} Feature: ${ann.fact}` : s.goal, facts, { bypassCache: true });
    }
  } else { console.error('usage: push-lifecycle.mjs report [days] | dry_run_tick | live_tick | guard | apns_check | samples | kill_switch_on | kill_switch_off'); process.exitCode = 2; }
  if (out) console.log(JSON.stringify(out, null, 2));
} finally {
  await getPool().end();
}
