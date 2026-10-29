// Ingest App Store Connect sales report TSVs into one app's MySQL database as a
// deduplicated mirror, then verify the mirror against totals.json computed from
// the raw reports. Run on the server with cwd = the finalcut app dir (mysql2).
//
//   node ingest_sales.mjs --env-file /path/.env --app-id 6815060815 --app-label finalcap --data DIR
//
// Exit codes: 0 verified ok, 2 totals mismatch, 1 failure. Every run writes a row
// to asc_sales_sync_state (status ok|mismatch|failed) when the DB is reachable.
// Existing tables (notably apple_transactions) are never touched.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const ENV_FILE = args['env-file'], APP_ID = args['app-id'], LABEL = args['app-label'] || APP_ID, DATA = args.data;
if (!ENV_FILE || !APP_ID || !DATA) { console.error('missing args'); process.exit(1); }

function parseEnv(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[line.slice(0, eq).trim()] = v;
  }
  return env;
}

function mdY(s) { // "10/25/2026" -> "2026-10-25"
  const [m, d, y] = s.split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const totals = JSON.parse(readFileSync(join(DATA, 'totals.json'), 'utf8'));
const env = parseEnv(ENV_FILE);
let conn, status = 'failed', detail = '';
try {
  conn = await mysql.createConnection({
    host: env.MYSQL_HOST || '127.0.0.1', port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE,
  });
  // The mirror is rebuilt from the reports on every run, so if an older build
  // created it with the pre-grain-hash schema, drop and recreate it.
  const [[grainCol]] = await conn.execute(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'asc_sales_mirror' AND COLUMN_NAME = 'grain_hash'`);
  if (Number(grainCol.n) === 0) await conn.execute(`DROP TABLE IF EXISTS asc_sales_mirror`);
  await conn.execute(`CREATE TABLE IF NOT EXISTS asc_sales_mirror (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    app_id BIGINT NOT NULL, granularity VARCHAR(8) NOT NULL,
    period_start DATE NOT NULL, period_end DATE NOT NULL,
    sku VARCHAR(64) NOT NULL DEFAULT '', parent_sku VARCHAR(64) NOT NULL DEFAULT '',
    product_type VARCHAR(8) NOT NULL DEFAULT '', country VARCHAR(2) NOT NULL DEFAULT '',
    device VARCHAR(32) NOT NULL DEFAULT '',
    grain_hash CHAR(64) NOT NULL,
    units INT NOT NULL, unit_proceeds DECIMAL(10,2) NOT NULL, currency VARCHAR(3) NOT NULL DEFAULT '',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_mirror (app_id, granularity, period_start, grain_hash)
  )`);
  await conn.execute(`CREATE TABLE IF NOT EXISTS asc_sales_sync_state (
    id BIGINT PRIMARY KEY AUTO_INCREMENT, app_id BIGINT NOT NULL, ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(16) NOT NULL, detail TEXT
  )`);

  // Identity of a report row = every descriptive column (measures excluded).
  // Keying on a subset collapses distinct rows (e.g. same SKU split by Device)
  // and silently loses units, which is what the verification below caught.
  const MEASURE_COLS = new Set(['Units', 'Developer Proceeds', 'Customer Price', 'Begin Date', 'End Date']);
  let upserted = 0;
  for (const fname of readdirSync(DATA).filter(f => f.endsWith('.tsv')).sort()) {
    const gran = fname.split('_')[0];
    const lines = readFileSync(join(DATA, fname), 'utf8').split('\n').filter(l => l.trim());
    const hdr = lines[0].split('\t');
    const ix = Object.fromEntries(hdr.map((h, i) => [h, i]));
    const col = (row, name) => (ix[name] !== undefined ? (row[ix[name]] ?? '') : '');
    for (const line of lines.slice(1)) {
      const row = line.split('\t');
      if (col(row, 'Apple Identifier') !== APP_ID) continue;
      const descriptive = hdr.filter(h => !MEASURE_COLS.has(h)).map(h => col(row, h)).join('\u0001');
      const grain = createHash('sha256').update(descriptive).digest('hex');
      const vals = [
        APP_ID, gran, mdY(col(row, 'Begin Date')), mdY(col(row, 'End Date')),
        col(row, 'SKU'), col(row, 'Parent Identifier'), col(row, 'Product Type Identifier'),
        col(row, 'Country Code'), col(row, 'Device'), grain,
        parseInt(col(row, 'Units') || '0', 10),
        parseFloat(col(row, 'Developer Proceeds') || '0'), col(row, 'Currency of Proceeds'),
      ];
      await conn.execute(
        `INSERT INTO asc_sales_mirror (app_id, granularity, period_start, period_end, sku, parent_sku, product_type, country, device, grain_hash, units, unit_proceeds, currency)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE period_end=VALUES(period_end), units=VALUES(units), unit_proceeds=VALUES(unit_proceeds), currency=VALUES(currency)`, vals);
      upserted++;
    }
  }

  // Verify: mirror aggregates per fetched period vs totals from the raw reports.
  const problems = [];
  let checked = 0;
  for (const [name, t] of Object.entries(totals)) {
    const exp = t.apps[APP_ID];
    if (!exp) continue;
    checked++;
    const period = mdY(exp.period_start);
    const [[agg]] = await conn.execute(
      `SELECT COUNT(*) AS rows_n, COALESCE(SUM(units),0) AS units_n FROM asc_sales_mirror
       WHERE app_id=? AND granularity=? AND period_start=?`, [APP_ID, t.granularity, period]);
    const [per] = await conn.execute(
      `SELECT currency, ROUND(SUM(units*unit_proceeds),2) AS p FROM asc_sales_mirror
       WHERE app_id=? AND granularity=? AND period_start=? GROUP BY currency`, [APP_ID, t.granularity, period]);
    const got = Object.fromEntries(per.map(r => [r.currency, Number(r.p)]));
    const canon = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1))));
    if (Number(agg.rows_n) !== exp.rows || Number(agg.units_n) !== exp.units ||
        canon(got) !== canon(exp.proceeds)) {
      problems.push(`${name}: expected rows=${exp.rows} units=${exp.units} proceeds=${JSON.stringify(exp.proceeds)}; mirror rows=${agg.rows_n} units=${agg.units_n} proceeds=${JSON.stringify(got)}`);
    }
  }
  if (problems.length) {
    status = 'mismatch';
    detail = problems.join(' | ');
    await conn.execute(`INSERT INTO asc_sales_sync_state (app_id, status, detail) VALUES (?,?,?)`, [APP_ID, status, detail]);
    console.error(`MISMATCH ${LABEL}: ${detail}`);
    process.exit(2);
  }
  status = 'ok';
  detail = `periods checked=${checked}, rows upserted=${upserted}`;
  await conn.execute(`INSERT INTO asc_sales_sync_state (app_id, status, detail) VALUES (?,?,?)`, [APP_ID, status, detail]);
  console.log(`OK ${LABEL}: ${detail}`);
} catch (err) {
  console.error(`FAILED ${LABEL}: ${err.message}`);
  try {
    if (conn) await conn.execute(`INSERT INTO asc_sales_sync_state (app_id, status, detail) VALUES (?,?,?)`,
      [APP_ID, 'failed', String(err.message).slice(0, 500)]);
  } catch { /* DB unreachable: the freshness watcher reports the stale mirror instead */ }
  process.exit(1);
} finally {
  if (conn) await conn.end();
}
