// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createTelemetryRouter, sanitizeTelemetryEvent, TELEMETRY_EVENTS } from '../server/telemetry.js';

const passLimiter = (req, res, next) => next();
async function serve(router) {
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}
const valid = { event: 'tool_executed', anon_id: '1b2c3d4e-aaaa-bbbb-cccc-1234567890ab', session_id: 'sess-12345678', platform: 'web', props: { tool: 'trim_video', ok: true, ms_bucket: '1-5s' } };

describe('sanitizeTelemetryEvent', () => {
  it('accepts the 10 funnel events', () => {
    expect([...TELEMETRY_EVENTS]).toEqual(['landing_view', 'cta_click', 'video_loaded', 'first_prompt', 'tool_executed', 'upload_consent', 'export', 'app_store_click', 'signup', 'upgrade']);
    expect(sanitizeTelemetryEvent(valid).row).toMatchObject({ event: 'tool_executed', platform: 'web', props: { tool: 'trim_video', ok: true, ms_bucket: '1-5s' } });
  });
  it('rejects unknown events and bad ids', () => {
    expect(sanitizeTelemetryEvent({ ...valid, event: 'whatever' }).error).toBeTruthy();
    expect(sanitizeTelemetryEvent({ ...valid, anon_id: 'x' }).error).toBeTruthy();
    expect(sanitizeTelemetryEvent({ ...valid, platform: 'android' }).error).toBeTruthy();
  });
  it('drops prompt text, file names, emails and any non-allowlisted prop', () => {
    const { row } = sanitizeTelemetryEvent({ ...valid, props: { prompt: 'make it moody', file_name: 'secret.mov', email: 'a@b.c', tool: 'Trim Video!', path: 'not-a-path', ok: 'yes', ref: 'news.ycombinator.com' } });
    expect(row.props).toEqual({ ref: 'news.ycombinator.com' });
  });
});

describe('POST /api/telemetry', () => {
  let srv;
  afterEach(async () => { if (srv) await srv.close(); srv = null; delete process.env.TELEMETRY_READ_KEY; });

  it('stores a valid event (sendBeacon text/plain too) and never sets a cookie', async () => {
    const rows = [];
    srv = await serve(createTelemetryRouter({ insert: async (row) => rows.push(row), limiter: passLimiter }));
    let res = await fetch(`${srv.base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBeNull();
    res = await fetch(`${srv.base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ ...valid, event: 'export' }) });
    expect(res.status).toBe(204);
    expect(rows.map(r => r.event)).toEqual(['tool_executed', 'export']);
    expect(JSON.stringify(rows)).not.toMatch(/127\.0\.0\.1|ip/);
  });

  it('rejects invalid events with 400, oversized bodies with 413, and reports DB failure as 202', async () => {
    srv = await serve(createTelemetryRouter({ insert: async () => { throw new Error('db down'); }, limiter: passLimiter }));
    expect((await fetch(`${srv.base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'nope' }) })).status).toBe(400);
    expect((await fetch(`${srv.base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...valid, pad: 'x'.repeat(5000) }) })).status).toBe(413);
    const res = await fetch(`${srv.base}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid) });
    expect(res.status).toBe(202);
  });

  it('summary is 404 without TELEMETRY_READ_KEY and 401 with a wrong key', async () => {
    srv = await serve(createTelemetryRouter({ insert: async () => {}, limiter: passLimiter, summary: async () => ({ events: [], tools: [] }) }));
    expect((await fetch(`${srv.base}/api/telemetry/summary`)).status).toBe(404);
    process.env.TELEMETRY_READ_KEY = 'k'.repeat(32);
    expect((await fetch(`${srv.base}/api/telemetry/summary`, { headers: { 'X-Telemetry-Read-Key': 'wrong' } })).status).toBe(401);
    const ok = await fetch(`${srv.base}/api/telemetry/summary?days=3`, { headers: { 'X-Telemetry-Read-Key': 'k'.repeat(32) } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ days: 3, events: [], tools: [] });
  });
});
