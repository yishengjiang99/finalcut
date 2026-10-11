// Push lifecycle ops, run ON the server from the app dir (uses the app's own .env and MySQL):
//   node scripts/push-lifecycle.mjs report [days]     KPIs + recent evaluations (no tokens/ids)
//   node scripts/push-lifecycle.mjs dry_run_tick      evaluate every device once, forced dry run
//   node scripts/push-lifecycle.mjs samples           generate copy for every segment (sends nothing)
//   node scripts/push-lifecycle.mjs kill_switch_on | kill_switch_off
// Used by .github/workflows/push-lifecycle.yml. Never sends a real push.
import { getPool } from '../src/db.js';
import { createMysqlPushStore } from '../src/server/push/store.js';
import { runLifecycleTick, lifecycleReport, effectiveMode } from '../src/server/push/lifecycle.js';
import { generateCopy } from '../src/server/push/copy.js';
import { SEGMENTS, FEATURE_ANNOUNCEMENTS } from '../src/server/push/segments.js';

const [cmd = 'report', arg] = process.argv.slice(2);
const store = createMysqlPushStore();
try {
  let out;
  if (cmd === 'report') out = await lifecycleReport(store, { days: Math.min(90, Math.max(1, Number(arg) || 7)) });
  else if (cmd === 'dry_run_tick') out = await runLifecycleTick({ store, modeOverride: 'dry_run' });
  else if (cmd === 'kill_switch_on') { await store.setOp('kill_switch', 'on'); out = await effectiveMode(store); }
  else if (cmd === 'kill_switch_off') { await store.setOp('kill_switch', null); out = await effectiveMode(store); }
  else if (cmd === 'samples') {
    out = {};
    for (const s of Object.values(SEGMENTS)) {
      const ann = s.id === 'new_feature' ? FEATURE_ANNOUNCEMENTS[0] : null;
      const facts = { tier: 'free', editsLastWeek: s.id.startsWith('inactive') || s.id === 'winback_30' ? '0' : '1-3', hasExported: false, ...(ann ? { announcement: ann.fact } : {}) };
      out[s.id] = await generateCopy(s.id, ann ? `${s.goal} Feature: ${ann.fact}` : s.goal, facts, { bypassCache: true });
    }
  } else { console.error('usage: push-lifecycle.mjs report [days] | dry_run_tick | samples | kill_switch_on | kill_switch_off'); process.exitCode = 2; }
  if (out) console.log(JSON.stringify(out, null, 2));
} finally {
  await getPool().end();
}
