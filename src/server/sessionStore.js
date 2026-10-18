import session from 'express-session';
import { getPool } from '../db.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function expiryOf(sess) {
  const expires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : NaN;
  return Number.isFinite(expires) ? expires : Date.now() + DEFAULT_TTL_MS;
}

/**
 * express-session store backed by the `web_sessions` table (created in initDatabase).
 */
export class MySQLSessionStore extends session.Store {
  constructor({ pool = getPool(), cleanupIntervalMs = CLEANUP_INTERVAL_MS } = {}) {
    super();
    this.pool = pool;
    if (cleanupIntervalMs > 0) {
      const timer = setInterval(() => {
        this.pool.query('DELETE FROM web_sessions WHERE expires_at < ?', [Date.now()])
          .catch(error => console.error('Session cleanup failed:', error.message));
      }, cleanupIntervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  get(sid, callback) {
    this.pool.query('SELECT data FROM web_sessions WHERE sid = ? AND expires_at >= ?', [sid, Date.now()])
      .then(([rows]) => callback(null, rows.length ? JSON.parse(rows[0].data) : null))
      .catch(error => {
        // Treat an unreadable session as signed out, so a database outage does not turn every
        // request (sample mode and Bearer clients included) into a 500.
        console.error('Session lookup failed:', error.message);
        callback(null, null);
      });
  }

  set(sid, sess, callback) {
    this.pool.query(
      `INSERT INTO web_sessions (sid, data, expires_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), expires_at = VALUES(expires_at)`,
      [sid, JSON.stringify(sess), expiryOf(sess)]
    ).then(() => callback?.(null), error => callback?.(error));
  }

  touch(sid, sess, callback) {
    this.pool.query('UPDATE web_sessions SET expires_at = ? WHERE sid = ?', [expiryOf(sess), sid])
      .then(() => callback?.(null), error => callback?.(error));
  }

  destroy(sid, callback) {
    this.pool.query('DELETE FROM web_sessions WHERE sid = ?', [sid])
      .then(() => callback?.(null), error => callback?.(error));
  }
}
