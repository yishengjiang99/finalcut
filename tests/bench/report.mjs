#!/usr/bin/env node
// Markdown table from wasm-bench JSON files: node tests/bench/report.mjs test-results/bench/*.json
import { readFileSync } from 'node:fs';
const rows = process.argv.slice(2).flatMap(f => JSON.parse(readFileSync(f, 'utf8')).runs.filter(r => r.op));
const MB = n => (n ? `${Math.round(n / 2 ** 20)}` : '–');
const s = ms => (ms == null ? '–' : ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
console.log('| browser | core | op | status | load | exec | peak MB (one context) | notes |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  let note = '';
  if (r.op === 'soak60') note = `${r.runsOk}/${r.runs} runs ok${r.medianRunMs ? `, median ${r.medianRunMs} ms/run` : ''}${r.firstFailure ? `; run ${r.firstFailure.run} ${r.firstFailure.status}: ${(r.firstFailure.logTail || []).find(l => /NaN|Error|timeout/i.test(l)) || r.firstFailure.error || ''}` : ''}`;
  else if (r.op === 'ffprobe') note = `exit code ${r.exitCode}`;
  else if (r.status !== 'ok') note = r.error || (r.logTail || []).slice(-1)[0] || '';
  console.log(`| ${r.browser} ${r.browserVersion} | ${r.mode} | ${r.op} | ${r.status} | ${s(r.loadMs)} | ${s(r.execMs)} | ${MB(r.peakCtxBytes)} | ${note.replace(/\|/g, '/')} |`);
}
