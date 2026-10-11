// APNs provider (token-based .p8 auth, HTTP/2) for FinalCap (topic com.ragnus.w2).
// Env: APNS_KEY_ID, APNS_TEAM_ID, APNS_P8_PATH or APNS_P8_CONTENTS (literal \n ok),
// optional FINALCAP_APNS_TOPIC (default com.ragnus.w2). Unset → isApnsConfigured() false and the
// lifecycle stays in would_send. Never logs key material or full device tokens.
import crypto from 'crypto';
import fs from 'fs';
import http2 from 'http2';

export const APNS_TOPIC = () => (process.env.FINALCAP_APNS_TOPIC || 'com.ragnus.w2').trim();
const TIMEOUT_MS = 12_000;

export function isApnsConfigured(env = process.env) {
  return Boolean(env.APNS_KEY_ID?.trim() && env.APNS_TEAM_ID?.trim() && (env.APNS_P8_CONTENTS?.trim() || env.APNS_P8_PATH?.trim()));
}

function readP8() {
  const c = process.env.APNS_P8_CONTENTS?.trim();
  if (c) return c.replace(/\\n/g, '\n');
  const p = process.env.APNS_P8_PATH?.trim();
  return p ? fs.readFileSync(p, 'utf8') : null;
}

let cachedJwt = null;
function providerToken() {
  if (cachedJwt && cachedJwt.exp > Date.now() + 60_000) return cachedJwt.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'ES256', kid: process.env.APNS_KEY_ID.trim() })}.${b64({ iss: process.env.APNS_TEAM_ID.trim(), iat: Math.floor(Date.now() / 1000) })}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: crypto.createPrivateKey(readP8()), dsaEncoding: 'ieee-p1363' });
  cachedJwt = { token: `${input}.${sig.toString('base64url')}`, exp: Date.now() + 50 * 60 * 1000 };
  return cachedJwt.token;
}

export function apnsHost(environment) {
  return environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
}

async function http2Post({ host, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { client.close(); client.destroy(); } catch { /* ignore */ } fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('apns_timeout')), TIMEOUT_MS);
    client.on('error', (e) => finish(reject, e));
    const req = client.request({ ':method': 'POST', ':path': path, ...headers });
    let status = 0;
    const chunks = [];
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.on('data', (c) => chunks.push(c));
    req.on('error', (e) => finish(reject, e));
    req.on('end', () => finish(resolve, { status, body: Buffer.concat(chunks).toString('utf8') }));
    req.end(body);
  });
}

let postImpl = http2Post;
export function setApnsPostForTests(fn) { postImpl = fn || http2Post; cachedJwt = null; }

/** @returns {Promise<{ok:boolean,status?:number,reason?:string}>} */
export async function sendApns(token, payload, { environment = 'production' } = {}) {
  if (!isApnsConfigured()) return { ok: false, reason: 'apns_not_configured' };
  const t = String(token || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64,200}$/.test(t)) return { ok: false, reason: 'BadDeviceToken' };
  try {
    const res = await postImpl({
      host: apnsHost(environment),
      path: `/3/device/${t}`,
      headers: {
        authorization: `bearer ${providerToken()}`,
        'apns-topic': APNS_TOPIC(),
        'apns-push-type': 'alert',
        'apns-priority': '5',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (res.status === 200) return { ok: true, status: 200 };
    let reason = `http_${res.status}`;
    try { reason = JSON.parse(res.body || '{}').reason || reason; } catch { /* keep */ }
    return { ok: false, status: res.status, reason };
  } catch (err) {
    return { ok: false, reason: err?.message || 'apns_error' };
  }
}

/** 410 / Unregistered / BadDeviceToken → the token is dead (uninstalled or wrong env). */
export function isDeadTokenResult(r) {
  return !r.ok && (r.status === 410 || /Unregistered|BadDeviceToken/.test(r.reason || ''));
}
