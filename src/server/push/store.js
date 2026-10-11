// Storage for FinalCap push lifecycle. MySQL in production (tables created lazily with
// CREATE TABLE IF NOT EXISTS — additive, no existing table is altered) and an in-memory
// store with the same interface for tests.
//
// push_devices : APNs token per device + timezone + consent flags (no install id; linked by user_id)
// push_events  : allowlisted lifecycle events from the app (app_open, export_done, paywall_view,
//                push_opened, marketing_opt_in/out) — names and times only
// push_sends   : one row per evaluated send (dry_run=1 for simulations); unique per dedupe key
// push_ops     : runtime mode / kill switch
// push_copy_cache : generated copy keyed by (segment, coarse facts)
import { getPool } from '../../db.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_devices (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(200) NOT NULL UNIQUE,
    environment ENUM('sandbox','production') NOT NULL DEFAULT 'production',
    tz VARCHAR(64) NULL,
    app_version VARCHAR(32) NULL,
    marketing_opt_in TINYINT(1) NOT NULL DEFAULT 0,
    marketing_changed_at DATETIME NULL,
    disabled_at DATETIME NULL,
    disabled_reason VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_push_devices_user (user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS push_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    event VARCHAR(32) NOT NULL,
    send_id VARCHAR(40) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_push_events_user_created (user_id, created_at),
    INDEX idx_push_events_send (send_id)
  )`,
  `CREATE TABLE IF NOT EXISTS push_sends (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    send_id VARCHAR(40) NOT NULL UNIQUE,
    user_id INT NOT NULL,
    segment VARCHAR(40) NOT NULL,
    dedupe_key VARCHAR(80) NOT NULL,
    dry_run TINYINT(1) NOT NULL,
    mode VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    reason VARCHAR(80) NULL,
    source VARCHAR(16) NULL,
    model VARCHAR(64) NULL,
    title VARCHAR(80) NULL,
    body VARCHAR(200) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_push_sends_dedupe (user_id, dedupe_key, dry_run),
    INDEX idx_push_sends_user_created (user_id, created_at),
    INDEX idx_push_sends_created (created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS push_ops (
    k VARCHAR(32) PRIMARY KEY,
    v VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS push_copy_cache (
    cache_key CHAR(24) PRIMARY KEY,
    title VARCHAR(80) NOT NULL,
    body VARCHAR(200) NOT NULL,
    model VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
];

let schemaReady = null;
const DAY = 24 * 3600_000;

export function createMysqlPushStore(poolFn = getPool) {
  const q = async (sql, params) => (await poolFn().query(sql, params))[0];
  return {
    async ensureSchema() {
      if (!schemaReady) schemaReady = (async () => { for (const s of SCHEMA) await q(s); })().catch((e) => { schemaReady = null; throw e; });
      return schemaReady;
    },
    async upsertDevice({ userId, token, environment, tz, appVersion, marketingOptIn }) {
      await this.ensureSchema();
      const mk = marketingOptIn === undefined ? null : marketingOptIn ? 1 : 0;
      await q(
        `INSERT INTO push_devices (user_id, token, environment, tz, app_version, marketing_opt_in, marketing_changed_at)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, 0), IF(? IS NULL, NULL, NOW()))
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), environment = VALUES(environment), tz = COALESCE(VALUES(tz), tz),
           app_version = COALESCE(VALUES(app_version), app_version),
           marketing_opt_in = IF(? IS NULL, marketing_opt_in, ?), marketing_changed_at = IF(? IS NULL, marketing_changed_at, NOW()),
           disabled_at = NULL, disabled_reason = NULL`,
        [userId, token, environment, tz, appVersion, mk, mk, mk, mk, mk],
      );
    },
    async disableDevice(token, reason) {
      await this.ensureSchema();
      await q('UPDATE push_devices SET disabled_at = NOW(), disabled_reason = ? WHERE token = ? AND disabled_at IS NULL', [reason, token]);
    },
    async disableUserDevices(userId, reason, token = null) {
      await this.ensureSchema();
      await q(`UPDATE push_devices SET disabled_at = NOW(), disabled_reason = ? WHERE user_id = ? AND disabled_at IS NULL${token ? ' AND token = ?' : ''}`, token ? [reason, userId, token] : [reason, userId]);
    },
    async setMarketingOptIn(userId, optIn) {
      await this.ensureSchema();
      await q('UPDATE push_devices SET marketing_opt_in = ?, marketing_changed_at = NOW() WHERE user_id = ?', [optIn ? 1 : 0, userId]);
    },
    async recordEvent(userId, event, sendId = null) {
      await this.ensureSchema();
      await q('INSERT INTO push_events (user_id, event, send_id) VALUES (?, ?, ?)', [userId, event, sendId]);
    },
    async publicPrefs(userId) {
      await this.ensureSchema();
      const rows = await q('SELECT marketing_opt_in AS m, disabled_at AS d FROM push_devices WHERE user_id = ? ORDER BY updated_at DESC', [userId]);
      return { registered: rows.some((r) => !r.d), marketingOptIn: rows.some((r) => !r.d && r.m) };
    },
    async listCandidates(limit = 5000) {
      await this.ensureSchema();
      const rows = await q(
        `SELECT d.user_id AS userId, d.token, d.environment, d.tz, d.marketing_opt_in AS marketingOptIn,
                u.created_at AS createdAt, u.has_subscription AS hasSubscription, u.device_install_id AS installId
           FROM push_devices d JOIN users u ON u.id = d.user_id
          WHERE d.disabled_at IS NULL ORDER BY d.user_id LIMIT ?`, [limit]);
      const by = new Map();
      for (const r of rows) {
        const c = by.get(r.userId) || { userId: r.userId, installId: r.installId, createdAt: r.createdAt, hasSubscription: Boolean(r.hasSubscription), devices: [] };
        c.devices.push({ token: r.token, environment: r.environment, tz: r.tz, marketingOptIn: Boolean(r.marketingOptIn) });
        by.set(r.userId, c);
      }
      return [...by.values()];
    },
    async loadActivity(userIds, now = new Date()) {
      await this.ensureSchema();
      const out = new Map(userIds.map((id) => [id, { edits: [], events: [], lastSessionAt: null }]));
      if (!userIds.length) return out;
      const since = new Date(now.getTime() - 60 * DAY);
      for (const r of await q('SELECT user_id AS u, DATE_FORMAT(usage_date, "%Y-%m-%d") AS day, inference_count AS count, updated_at AS lastAt FROM daily_inference_usage WHERE user_id IN (?) AND usage_date >= ?', [userIds, since])) out.get(r.u)?.edits.push({ day: r.day, count: r.count, lastAt: r.lastAt });
      for (const r of await q('SELECT user_id AS u, event, created_at AS at FROM push_events WHERE user_id IN (?) AND created_at >= ?', [userIds, since])) out.get(r.u)?.events.push({ event: r.event, at: r.at });
      for (const r of await q('SELECT user_id AS u, MAX(created_at) AS at FROM api_tokens WHERE user_id IN (?) GROUP BY user_id', [userIds])) { const a = out.get(r.u); if (a) a.lastSessionAt = r.at; }
      return out;
    },
    async sendHistory(userId, dryRun, now = new Date()) {
      await this.ensureSchema();
      return q('SELECT dedupe_key AS dedupeKey, segment, status, created_at AS at FROM push_sends WHERE user_id = ? AND dry_run = ? AND created_at >= ?', [userId, dryRun ? 1 : 0, new Date(now.getTime() - 120 * DAY)]);
    },
    /** Claims the dedupe slot first (unique key = lock across processes). false if already claimed. */
    async claimSend(row) {
      await this.ensureSchema();
      try {
        await q('INSERT INTO push_sends (send_id, user_id, segment, dedupe_key, dry_run, mode, status, reason, source, model, title, body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [row.sendId, row.userId, row.segment, row.dedupeKey, row.dryRun ? 1 : 0, row.mode, row.status, row.reason ?? null, row.source ?? null, row.model ?? null, row.title ?? null, row.body ?? null]);
        return true;
      } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') return false;
        throw e;
      }
    },
    async finishSend(sendId, status, reason = null) {
      await q('UPDATE push_sends SET status = ?, reason = ? WHERE send_id = ?', [status, reason, sendId]);
    },
    async getOps() {
      await this.ensureSchema();
      return Object.fromEntries((await q('SELECT k, v FROM push_ops')).map((r) => [r.k, r.v]));
    },
    async setOp(k, v) {
      await this.ensureSchema();
      if (v === null) await q('DELETE FROM push_ops WHERE k = ?', [k]);
      else await q('REPLACE INTO push_ops (k, v) VALUES (?, ?)', [k, String(v)]);
    },
    /** Retention: events and the send log older than 13 months (matches the privacy page). */
    async purgeOld(now = new Date()) {
      await this.ensureSchema();
      const cutoff = new Date(now.getTime() - 396 * DAY);
      await q('DELETE FROM push_events WHERE created_at < ?', [cutoff]);
      await q('DELETE FROM push_sends WHERE created_at < ?', [cutoff]);
    },
    async reportRows(sinceDate) {
      await this.ensureSchema();
      const sends = await q('SELECT send_id AS sendId, user_id AS userId, segment, dry_run AS dryRun, status, reason, source, title, body, created_at AS at FROM push_sends WHERE created_at >= ? ORDER BY created_at DESC', [sinceDate]);
      const events = await q('SELECT user_id AS userId, event, send_id AS sendId, created_at AS at FROM push_events WHERE created_at >= ?', [sinceDate]);
      const [dev] = await q('SELECT SUM(disabled_at IS NULL) AS active, SUM(disabled_at IS NULL AND marketing_opt_in = 1) AS marketing, SUM(disabled_at >= ?) AS disabledInWindow FROM push_devices', [sinceDate]);
      return { sends, events, devices: { active: Number(dev?.active || 0), marketingOptIn: Number(dev?.marketing || 0), disabledInWindow: Number(dev?.disabledInWindow || 0) } };
    },
  };
}

/** In-memory store with the same interface (tests / local dry runs). */
export function createMemoryPushStore({ users = [], activity = new Map() } = {}) {
  const devices = new Map();
  const events = [];
  const sends = [];
  const ops = {};
  return {
    _devices: devices, _events: events, _sends: sends,
    async ensureSchema() {},
    async upsertDevice({ userId, token, environment, tz, marketingOptIn }) {
      const prev = devices.get(token) || {};
      devices.set(token, { ...prev, userId, token, environment, tz: tz ?? prev.tz ?? null, marketingOptIn: marketingOptIn === undefined ? Boolean(prev.marketingOptIn) : Boolean(marketingOptIn), disabledAt: null, disabledReason: null });
    },
    async disableDevice(token, reason) { const d = devices.get(token); if (d && !d.disabledAt) Object.assign(d, { disabledAt: new Date(), disabledReason: reason }); },
    async disableUserDevices(userId, reason, token = null) { for (const d of devices.values()) if (d.userId === userId && (!token || d.token === token) && !d.disabledAt) Object.assign(d, { disabledAt: new Date(), disabledReason: reason }); },
    async setMarketingOptIn(userId, optIn) { for (const d of devices.values()) if (d.userId === userId) d.marketingOptIn = Boolean(optIn); },
    async recordEvent(userId, event, sendId = null, at = new Date()) { events.push({ userId, event, sendId, at }); },
    async publicPrefs(userId) { const ds = [...devices.values()].filter((d) => d.userId === userId && !d.disabledAt); return { registered: ds.length > 0, marketingOptIn: ds.some((d) => d.marketingOptIn) }; },
    async listCandidates() {
      const by = new Map();
      for (const d of devices.values()) {
        if (d.disabledAt) continue;
        const u = users.find((x) => x.id === d.userId);
        if (!u) continue;
        const c = by.get(d.userId) || { userId: d.userId, installId: u.installId, createdAt: u.createdAt, hasSubscription: Boolean(u.hasSubscription), devices: [] };
        c.devices.push({ token: d.token, environment: d.environment, tz: d.tz, marketingOptIn: d.marketingOptIn });
        by.set(d.userId, c);
      }
      return [...by.values()];
    },
    async loadActivity(userIds) {
      return new Map(userIds.map((id) => {
        const a = activity.get(id) || { edits: [], lastSessionAt: null };
        return [id, { edits: a.edits || [], lastSessionAt: a.lastSessionAt || null, events: [...(a.events || []), ...events.filter((e) => e.userId === id)] }];
      }));
    },
    async sendHistory(userId, dryRun) { return sends.filter((s) => s.userId === userId && s.dryRun === Boolean(dryRun)); },
    async claimSend(row) {
      if (sends.some((s) => s.userId === row.userId && s.dedupeKey === row.dedupeKey && s.dryRun === Boolean(row.dryRun))) return false;
      sends.push({ ...row, dryRun: Boolean(row.dryRun), at: row.at || new Date() });
      return true;
    },
    async finishSend(sendId, status, reason = null) { const s = sends.find((x) => x.sendId === sendId); if (s) Object.assign(s, { status, reason }); },
    async purgeOld() {},
    async getOps() { return { ...ops }; },
    async setOp(k, v) { if (v === null) delete ops[k]; else ops[k] = String(v); },
    async reportRows(since) {
      const ds = [...devices.values()];
      return { sends: sends.filter((s) => s.at >= since), events: events.filter((e) => e.at >= since),
        devices: { active: ds.filter((d) => !d.disabledAt).length, marketingOptIn: ds.filter((d) => !d.disabledAt && d.marketingOptIn).length, disabledInWindow: ds.filter((d) => d.disabledAt && d.disabledAt >= since).length } };
    },
  };
}
