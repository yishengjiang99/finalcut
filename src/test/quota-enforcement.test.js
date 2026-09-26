// @vitest-environment node
// consumeDailyInference must enforce the daily limit atomically. The old upsert relied on
// affectedRows from `ON DUPLICATE KEY UPDATE`, which is 1 for an unchanged row when the
// client sets CLIENT_FOUND_ROWS (mysql2's default), so the limit was never enforced.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ─── Unit: a fake pool with MySQL + CLIENT_FOUND_ROWS affectedRows semantics ───
function fakeFoundRowsPool() {
  const rows = new Map(); // `${user}` → count (single day)
  const calls = [];
  return {
    rows,
    calls,
    async query(sql, params) {
      const q = sql.replace(/\s+/g, ' ').trim();
      calls.push(q.split(' ').slice(0, 2).join(' '));
      const [userId] = params;
      if (q.startsWith('INSERT IGNORE')) {
        if (rows.has(userId)) return [{ affectedRows: 0 }];
        rows.set(userId, 0);
        return [{ affectedRows: 1 }];
      }
      if (q.startsWith('INSERT INTO') && q.includes('ON DUPLICATE KEY UPDATE inference_count = IF')) {
        // Old upsert: FOUND_ROWS → 1 for insert, 2 for changed, 1 (found) for unchanged.
        const limit = params[1];
        if (!rows.has(userId)) { rows.set(userId, 1); return [{ affectedRows: 1 }]; }
        const n = rows.get(userId);
        if (n < limit) { rows.set(userId, n + 1); return [{ affectedRows: 2 }]; }
        return [{ affectedRows: 1 }];
      }
      if (q.startsWith('UPDATE daily_inference_usage')) {
        // FOUND_ROWS: affectedRows = rows matched by WHERE (count < limit is in the WHERE).
        const limit = params[1];
        if (!rows.has(userId) || rows.get(userId) >= limit) return [{ affectedRows: 0 }];
        rows.set(userId, rows.get(userId) + 1);
        return [{ affectedRows: 1 }];
      }
      if (q.startsWith('SELECT inference_count')) {
        return [rows.has(userId) ? [{ used: rows.get(userId), resets_at: '2026-09-27' }] : []];
      }
      throw new Error(`unexpected SQL: ${q}`);
    },
  };
}

// Verbatim copy of the pre-fix implementation, to show the bug it had.
async function oldConsumeDailyInference(pool, userId, dailyLimit) {
  const [result] = await pool.query(
    `INSERT INTO daily_inference_usage (user_id, usage_date, inference_count)
     VALUES (?, UTC_DATE(), 1)
     ON DUPLICATE KEY UPDATE inference_count = IF(inference_count < ?, inference_count + 1, inference_count)`,
    [userId, dailyLimit]
  );
  return result.affectedRows > 0;
}

describe('consumeDailyInference (driver mocked to FOUND_ROWS behavior)', () => {
  it('old upsert: the 4th call at limit 3 was allowed (the bug)', async () => {
    const pool = fakeFoundRowsPool();
    const allowed = [];
    for (let i = 0; i < 5; i += 1) allowed.push(await oldConsumeDailyInference(pool, 1, 3));
    expect(allowed).toEqual([true, true, true, true, true]);
    expect(pool.rows.get(1)).toBe(3);
  });

  it('new: calls 1-3 allowed, 4th and later denied, count stays 3', async () => {
    const { consumeDailyInference } = await import('../db.js');
    const pool = fakeFoundRowsPool();
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await consumeDailyInference(1, 3, { pool }));
    expect(results.map(r => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map(r => r.remaining)).toEqual([2, 1, 0, 0, 0]);
    expect(results[3]).toMatchObject({ limit: 3, used: 3, remaining: 0, allowed: false });
    expect(pool.rows.get(1)).toBe(3);
  });

  it('uses INSERT IGNORE + conditional UPDATE (never the FOUND_ROWS-sensitive upsert)', async () => {
    const { consumeDailyInference } = await import('../db.js');
    const pool = fakeFoundRowsPool();
    await consumeDailyInference(9, 3, { pool });
    expect(pool.calls.slice(0, 2)).toEqual(['INSERT IGNORE', 'UPDATE daily_inference_usage']);
  });

  it('limit 0 denies without writing', async () => {
    const { consumeDailyInference } = await import('../db.js');
    const pool = fakeFoundRowsPool();
    expect(await consumeDailyInference(2, 0, { pool })).toMatchObject({ allowed: false, used: 0 });
    expect(pool.rows.has(2)).toBe(false);
  });

  it('retries once when the day rolled over between INSERT and UPDATE', async () => {
    const { consumeDailyInference } = await import('../db.js');
    const pool = fakeFoundRowsPool();
    const realQuery = pool.query.bind(pool);
    let firstUpdate = true;
    pool.query = async (sql, params) => {
      if (sql.includes('UPDATE daily_inference_usage') && firstUpdate) {
        firstUpdate = false;
        pool.rows.delete(params[0]); // new UTC day: yesterday's row no longer matches
        return [{ affectedRows: 0 }];
      }
      return realQuery(sql, params);
    };
    expect(await consumeDailyInference(3, 3, { pool })).toMatchObject({ allowed: true, used: 1 });
  });
});

// ─── Integration: real MariaDB/MySQL through mysql2 (CI service; skipped otherwise) ───
// Same pool options as src/db.js (mysql2 defaults, so CLIENT_FOUND_ROWS is on).
const dbEnv = process.env.QUOTA_DB_TEST_HOST ? {
  host: process.env.QUOTA_DB_TEST_HOST,
  user: process.env.QUOTA_DB_TEST_USER || 'quota_test',
  password: process.env.QUOTA_DB_TEST_PASSWORD || '',
  database: process.env.QUOTA_DB_TEST_DATABASE || 'quota_test',
} : null;

describe.skipIf(!dbEnv)('consumeDailyInference against real MariaDB/MySQL (mysql2 defaults)', () => {
  let db;
  let pool;

  beforeAll(async () => {
    db = await import('../db.js');
    const mysql = (await import('mysql2/promise')).default;
    pool = mysql.createPool(dbEnv);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_inference_usage (
        user_id INT NOT NULL,
        usage_date DATE NOT NULL,
        inference_count INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, usage_date),
        INDEX idx_daily_inference_usage_date (usage_date)
      )`);
    await pool.query('DELETE FROM daily_inference_usage WHERE user_id BETWEEN 900000 AND 900099');
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM daily_inference_usage WHERE user_id BETWEEN 900000 AND 900099');
      await pool.end();
    }
  });

  it('reproduces the old bug: the old upsert allows a 4th call at limit 3', async () => {
    const allowed = [];
    for (let i = 0; i < 4; i += 1) allowed.push(await oldConsumeDailyInference(pool, 900001, 3));
    expect(allowed).toEqual([true, true, true, true]);
  });

  it('fixed: the 4th call at limit 3 is denied', async () => {
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await db.consumeDailyInference(900002, 3, { pool }));
    expect(results.map(r => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.at(-1)).toMatchObject({ used: 3, remaining: 0 });
  });

  it('race-safe: 30 concurrent calls at limit 3 → exactly 3 allowed', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => db.consumeDailyInference(900003, 3, { pool })));
    expect(results.filter(r => r.allowed)).toHaveLength(3);
    const [rows] = await pool.query('SELECT inference_count AS n FROM daily_inference_usage WHERE user_id = 900003');
    expect(rows[0].n).toBe(3);
  });

  it('recordDailyInference (FREE_EDITS_IOS=unlimited) still counts past the limit', async () => {
    for (let i = 0; i < 3; i += 1) await db.consumeDailyInference(900004, 3, { pool });
    expect((await db.consumeDailyInference(900004, 3, { pool })).allowed).toBe(false);
    expect(await db.recordDailyInference(900004, { pool })).toEqual({ used: 4 });
    expect((await db.getDailyInferenceUsage(900004, 3, { pool })).remaining).toBe(0);
  });
});
