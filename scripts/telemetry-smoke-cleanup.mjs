// Deploy smoke helper, run ON the server from the app dir (uses the app's own .env / pool):
//   node scripts/telemetry-smoke-cleanup.mjs deploy-smoke-<run id>
// Prints how many finalcut_telemetry_events rows carry that exact anon_id, then deletes them.
// Only exact ids starting with "deploy-smoke-" are accepted, so real data cannot be touched.
import { getPool } from '../src/db.js';
import { TELEMETRY_TABLE } from '../src/server/telemetry.js';

const id = process.argv[2] || '';
if (!/^deploy-smoke-[A-Za-z0-9-]{1,48}$/.test(id)) {
  console.error('usage: telemetry-smoke-cleanup.mjs deploy-smoke-<id>');
  process.exit(2);
}
const pool = getPool();
try {
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) AS n FROM ${TELEMETRY_TABLE} WHERE anon_id = ?`, [id]);
  const [del] = await pool.query(`DELETE FROM ${TELEMETRY_TABLE} WHERE anon_id = ?`, [id]);
  console.log(JSON.stringify({ anon_id: id, received: Number(n), deleted: del.affectedRows }));
  process.exitCode = Number(n) > 0 ? 0 : 1;
} finally {
  await pool.end();
}
