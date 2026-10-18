import { describe, expect, it } from 'vitest';
import express from 'express';
import session from 'express-session';
import { MySQLSessionStore } from '../server/sessionStore.js';

// Stands in for the mysql2 pool: just enough SQL for the four statements the store issues.
function fakePool() {
  const rows = new Map();
  return {
    rows,
    failing: false,
    async query(sql, params) {
      if (this.failing) throw new Error('db down');
      if (sql.startsWith('SELECT')) {
        const row = rows.get(params[0]);
        return [row && row.expires_at >= params[1] ? [{ data: row.data }] : []];
      }
      if (sql.startsWith('INSERT')) rows.set(params[0], { data: params[1], expires_at: params[2] });
      else if (sql.startsWith('UPDATE')) { const row = rows.get(params[1]); if (row) row.expires_at = params[0]; }
      else if (sql.startsWith('DELETE FROM web_sessions WHERE sid')) rows.delete(params[0]);
      return [{}];
    },
  };
}

const call = (store, method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
});

describe('MySQLSessionStore', () => {
  const newStore = pool => new MySQLSessionStore({ pool, cleanupIntervalMs: 0 });
  const sess = (expires = new Date(Date.now() + 60_000)) => ({ cookie: { expires }, passport: { user: 7 } });

  it('stores, reads, touches and destroys a session', async () => {
    const pool = fakePool();
    const store = newStore(pool);
    await call(store, 'set', 'a', sess());
    expect(await call(store, 'get', 'a')).toMatchObject({ passport: { user: 7 } });

    const later = new Date(Date.now() + 120_000);
    await call(store, 'touch', 'a', sess(later));
    expect(pool.rows.get('a').expires_at).toBe(later.getTime());

    await call(store, 'destroy', 'a');
    expect(await call(store, 'get', 'a')).toBeNull();
  });

  it('does not return an expired session', async () => {
    const store = newStore(fakePool());
    await call(store, 'set', 'old', sess(new Date(Date.now() - 1000)));
    expect(await call(store, 'get', 'old')).toBeNull();
  });

  it('reads as signed out when the database is unreachable', async () => {
    const pool = fakePool();
    const store = newStore(pool);
    pool.failing = true;
    expect(await call(store, 'get', 'a')).toBeNull();
    await expect(call(store, 'set', 'a', sess())).rejects.toThrow('db down');
  });

  it('keeps a login across a restart (a second store on the same table)', async () => {
    const pool = fakePool();
    const start = () => {
      const app = express();
      app.use(session({ store: newStore(pool), secret: 'test', resave: false, saveUninitialized: false }));
      app.get('/login', (req, res) => { req.session.userId = 7; res.end('ok'); });
      app.get('/me', (req, res) => res.json({ userId: req.session.userId ?? null }));
      return new Promise(resolve => { const server = app.listen(0, () => resolve(server)); });
    };

    let server = await start();
    const login = await fetch(`http://localhost:${server.address().port}/login`);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    server.close();

    server = await start();
    const me = await fetch(`http://localhost:${server.address().port}/me`, { headers: { cookie } });
    server.close();
    expect(await me.json()).toEqual({ userId: 7 });
  });
});
