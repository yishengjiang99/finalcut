#!/usr/bin/env node
// Builds src/server/filmcraft/catalog.json (compact tool catalog for POST /api/filmcraft/agent)
// from the full filmcraft API dump: node scripts/build-filmcraft-catalog.mjs path/to/filmcraft-apis.json
import { readFileSync, writeFileSync } from 'fs';

const src = process.argv[2];
if (!src) { console.error('usage: build-filmcraft-catalog.mjs <filmcraft-apis.json>'); process.exit(1); }
const all = JSON.parse(readFileSync(src, 'utf8'));
const out = [];
for (const e of all) {
  if (!e.core || e.http || e.name.startsWith('window.filmcraft.')) continue;
  const request = e.name.startsWith('control.');
  out.push({
    id: request ? e.name.slice('control.'.length) : e.name,
    kind: request ? 'request' : 'execute',
    cat: e.category,
    d: e.description.replace(/\s*(Call via filmcraft\.execute\(id, params\)\.|Web: filmcraft\.request.*)$/, '').slice(0, 140),
    a: (e.arguments || []).map(a => [a.name, a.type, !!a.required]),
  });
}
writeFileSync(new URL('../src/server/filmcraft/catalog.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(`wrote ${out.length} entries`);
