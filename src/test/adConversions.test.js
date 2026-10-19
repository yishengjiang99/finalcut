// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import { forwardConversion, oauth1Header, hashEmail, stableEventId, _resetLogLimiter, conversionsEnabled } from '../server/adConversions.js';
import { createTelemetryRouter, extractClickIds, sanitizeTelemetryEvent } from '../server/telemetry.js';

const KEYS = ['X_ADS_PIXEL_ID', 'X_ADS_EVENT_IDS', 'X_ADS_CONSUMER_KEY', 'X_ADS_CONSUMER_SECRET', 'X_ADS_ACCESS_TOKEN', 'X_ADS_ACCESS_TOKEN_SECRET', 'REDDIT_ADS_PIXEL_ID', 'REDDIT_ADS_ACCESS_TOKEN', 'REDDIT_ADS_TEST_ID', 'REDDIT_ADS_EVENTS'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/127 Safari/537.36';
const row = { event: 'signup', anon_id: '1b2c3d4e-aaaa-bbbb-cccc-1234567890ab', session_id: 'sess-12345678', platform: 'web', props: { method: 'google' } };
const ctx = (fetchImpl, extra = {}) => ({ clickIds: { twclid: 'tw123', rdt_cid: 'rd456' }, ip: '203.0.113.9', userAgent: UA, fetchImpl, now: 1760000000000, ...extra });
function setAll() {
  Object.assign(process.env, {
    X_ADS_PIXEL_ID: 'oka17', X_ADS_EVENT_IDS: JSON.stringify({ signup: 'ol288' }), X_ADS_CONSUMER_KEY: 'ck', X_ADS_CONSUMER_SECRET: 'cs', X_ADS_ACCESS_TOKEN: 'at', X_ADS_ACCESS_TOKEN_SECRET: 'ats',
    REDDIT_ADS_PIXEL_ID: 't2_pix', REDDIT_ADS_ACCESS_TOKEN: 'rtok', REDDIT_ADS_TEST_ID: 't2_test',
  });
}
afterEach(() => { for (const k of KEYS) delete process.env[k]; _resetLogLimiter(); vi.restoreAllMocks(); });

describe('ad conversions', () => {
  it('is a no-op with env unset: no fetch, no logs', async () => {
    const fetchImpl = vi.fn(); const warn = vi.spyOn(console, 'warn');
    expect(conversionsEnabled()).toBe(false);
    await forwardConversion(row, ctx(fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled();
  });

  it('posts the X and Reddit payloads with the right headers', async () => {
    setAll();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    await forwardConversion(row, ctx(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [xUrl, xInit] = fetchImpl.mock.calls.find(c => c[0].includes('x.com'));
    expect(xUrl).toBe('https://ads-api.x.com/12/measurement/conversions/oka17');
    expect(xInit.headers.Authorization).toMatch(/^OAuth oauth_consumer_key="ck", oauth_nonce="[0-9a-f]{32}", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="at", oauth_version="1.0", oauth_signature="[A-Za-z0-9%]+"$/);
    const xb = JSON.parse(xInit.body).conversions[0];
    expect(xb).toEqual({ conversion_time: new Date(1760000000000).toISOString(), event_id: 'ol288', conversion_id: stableEventId(row), identifiers: [{ twclid: 'tw123' }, { ip_address: '203.0.113.9', user_agent: UA }] });
    const [rUrl, rInit] = fetchImpl.mock.calls.find(c => c[0].includes('reddit.com'));
    expect(rUrl).toBe('https://ads-api.reddit.com/api/v3/pixels/t2_pix/conversion_events');
    expect(rInit.headers.Authorization).toBe('Bearer rtok');
    expect(JSON.parse(rInit.body)).toEqual({ data: { test_id: 't2_test', events: [{ event_at: 1760000000000, action_source: 'WEBSITE', type: { tracking_type: 'SIGN_UP' }, click_id: 'rd456', metadata: { conversion_id: stableEventId(row) }, user: { ip_address: '203.0.113.9', user_agent: UA } }] } });
  });

  it('OAuth1 signature matches a reference HMAC-SHA1 computation', () => {
    const h = oauth1Header({ method: 'POST', url: 'https://ads-api.x.com/12/measurement/conversions/oka17', consumerKey: 'ck', consumerSecret: 'cs', token: 'at', tokenSecret: 'ats', nonce: 'n1', timestamp: 1700000000 });
    const params = 'oauth_consumer_key=ck&oauth_nonce=n1&oauth_signature_method=HMAC-SHA1&oauth_timestamp=1700000000&oauth_token=at&oauth_version=1.0';
    const base = `POST&${encodeURIComponent('https://ads-api.x.com/12/measurement/conversions/oka17')}&${encodeURIComponent(params)}`;
    const sig = crypto.createHmac('sha1', 'cs&ats').update(base).digest('base64');
    expect(h).toContain(`oauth_signature="${encodeURIComponent(sig)}"`);
  });

  it('skips Reddit when there is no rdt_cid', async () => {
    setAll();
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await forwardConversion(row, ctx(fetchImpl, { clickIds: { twclid: 'tw123' } }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('x.com');
    fetchImpl.mockClear();
    await forwardConversion(row, ctx(fetchImpl, { clickIds: {} }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses CUSTOM names, skips unmapped events, X without twclid, bots and test traffic', async () => {
    setAll();
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    await forwardConversion({ ...row, event: 'first_edit' }, ctx(fetchImpl, { clickIds: { rdt_cid: 'rd456' } }));
    expect(fetchImpl).toHaveBeenCalledTimes(1); // reddit only; X has no mapping/twclid
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).data.events[0].type).toEqual({ tracking_type: 'CUSTOM', custom_event_name: 'first_edit' });
    fetchImpl.mockClear();
    await forwardConversion({ ...row, event: 'tool_executed' }, ctx(fetchImpl, { clickIds: {} }));
    await forwardConversion(row, ctx(fetchImpl, { userAgent: 'Googlebot/2.1' }));
    await forwardConversion(row, ctx(fetchImpl, { testHeader: true }));
    await forwardConversion({ ...row, platform: 'ios' }, ctx(fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('failures and timeouts never throw and log at most once per minute per provider', async () => {
    setAll();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => { throw new Error('boom'); });
    await expect(forwardConversion(row, ctx(fetchImpl))).resolves.toBeDefined();
    await forwardConversion(row, ctx(vi.fn(async () => ({ ok: false, status: 500 }))));
    expect(warn).toHaveBeenCalledTimes(2); // one for x, one for reddit
  });

  it('stable event ids and hashed email normalization', () => {
    expect(stableEventId(row)).toBe(stableEventId({ ...row }));
    expect(stableEventId(row)).not.toBe(stableEventId({ ...row, event: 'upgrade' }));
    expect(hashEmail('  Test@X.com ')).toBe(crypto.createHash('sha256').update('test@x.com').digest('hex'));
  });

  it('telemetry route strips click ids before storing and forwards them without blocking', async () => {
    const rows = []; const forwarded = [];
    const app = express();
    app.use(createTelemetryRouter({ insert: async (r) => rows.push(r), limiter: (q, s, n) => n(), forward: (r, c) => { forwarded.push([r, c]); return new Promise(() => {}); } }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/telemetry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...row, props: { method: 'google', twclid: 'tw123', rdt_cid: 'rd456', utm_source: 'x' } }) });
    await new Promise(r => server.close(r));
    expect(res.status).toBe(204);
    expect(rows[0].props).toEqual({ method: 'google', utm_source: 'x' });
    expect(forwarded[0][1].clickIds).toEqual({ twclid: 'tw123', rdt_cid: 'rd456' });
    expect(extractClickIds(sanitizeTelemetryEvent({ ...row, props: { twclid: 'a' } }).row)).toEqual({ twclid: 'a' });
  });
});
