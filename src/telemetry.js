// Tiny first-party tracker for the FinalCap web app → POST /api/telemetry (src/server/telemetry.js).
// Anonymous: a random install id in localStorage and a per-tab session id in sessionStorage.
// No cookies, no third-party scripts. Never pass prompt text, file names, media or account data:
// only the short allowlisted props the server accepts (tool names, buckets, formats).
// Honors Global Privacy Control / Do Not Track by sending nothing.

const INSTALL_KEY = 'finalcap.telemetry.install';
const SESSION_KEY = 'finalcap.telemetry.session';
const ENDPOINT = '/api/telemetry';

function randomId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function stored(storage, key) {
  try {
    let id = storage.getItem(key);
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      id = randomId();
      storage.setItem(key, id);
    }
    return id;
  } catch {
    return null; // storage blocked (private mode): fall back to a per-page id
  }
}

const ATTRIB_KEY = 'finalcap.telemetry.attrib';
const ATTRIB_TTL_MS = 28 * 24 * 60 * 60 * 1000; // matches the ad platforms' default click windows
const ATTRIB_PARAMS = ['twclid', 'rdt_cid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const ATTRIB_VALUE = /^[A-Za-z0-9_.:\-/+ ]{1,128}$/;

/**
 * Ad attribution: copy X `twclid`, Reddit `rdt_cid` and utm_* from the landing URL into first-party
 * localStorage (28 days) so they can ride along with later telemetry events. The server forwards
 * click ids to the ad platform's Conversions API and never stores them. Nothing captured under GPC/DNT.
 */
export function captureAttribution() {
  try {
    if (telemetryDisabled()) return;
    const params = new URLSearchParams(window.location.search);
    const fresh = {};
    for (const key of ATTRIB_PARAMS) {
      const v = params.get(key);
      if (v && ATTRIB_VALUE.test(v)) fresh[key] = v;
    }
    if (!Object.keys(fresh).length) return;
    window.localStorage.setItem(ATTRIB_KEY, JSON.stringify({ at: Date.now(), ...fresh }));
  } catch { /* storage blocked */ }
}

export function attributionProps() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(ATTRIB_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return {};
    if (!(Date.now() - Number(saved.at) < ATTRIB_TTL_MS)) { window.localStorage.removeItem(ATTRIB_KEY); return {}; }
    const out = {};
    for (const key of ATTRIB_PARAMS) if (typeof saved[key] === 'string' && ATTRIB_VALUE.test(saved[key])) out[key] = saved[key];
    return out;
  } catch {
    return {};
  }
}

let pageId = null;
const onceFlags = new Set();

export function telemetryDisabled() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  if (typeof process !== 'undefined' && process.env && process.env.VITEST) return true; // unit tests
  return navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1';
}

export function track(event, props) {
  try {
    send(event, props);
  } catch { /* telemetry must never break the app */ }
}

function send(event, props) {
  if (telemetryDisabled()) return;
  pageId = pageId || randomId();
  const attrib = attributionProps();
  if (Object.keys(attrib).length) props = { ...attrib, ...(props || {}) };
  const body = JSON.stringify({
    event,
    platform: 'web',
    anon_id: stored(window.localStorage, INSTALL_KEY) || pageId,
    session_id: stored(window.sessionStorage, SESSION_KEY) || pageId,
    props: props || undefined,
  });
  try {
    if (typeof navigator.sendBeacon === 'function'
      && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))) return;
  } catch { /* fall back to fetch */ }
  try {
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'omit' }).catch(() => {});
  } catch { /* never let telemetry break the app */ }
}

/** Track an event at most once per page load (e.g. first_prompt). */
export function trackOnce(event, props) {
  if (onceFlags.has(event)) return;
  onceFlags.add(event);
  track(event, props);
}

// ---- prop helpers: coarse buckets only ----
export function sizeBucket(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const mb = bytes / (1024 * 1024);
  if (mb < 10) return '<10MB';
  if (mb < 50) return '10-50MB';
  if (mb < 200) return '50-200MB';
  if (mb < 1024) return '200MB-1GB';
  return '1GB+';
}

export function msBucket(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 1000) return '<1s';
  if (ms < 5000) return '1-5s';
  if (ms < 15000) return '5-15s';
  if (ms < 60000) return '15-60s';
  return '60s+';
}

export function lengthBucket(n) {
  if (n < 20) return '<20';
  if (n < 60) return '20-60';
  if (n < 150) return '60-150';
  return '150+';
}

/** Landing context: path, referrer host and UTM tags (never the full referrer URL). */
export function landingProps() {
  try {
    return readLandingProps();
  } catch {
    return {};
  }
}

function readLandingProps() {
  if (typeof window === 'undefined') return {};
  const props = { path: String(window.location?.pathname || '/').slice(0, 64) };
  try {
    if (document.referrer) {
      const host = new URL(document.referrer).hostname.toLowerCase();
      if (host && host !== window.location.hostname) props.ref = host.slice(0, 64);
    }
  } catch { /* ignore */ }
  const params = new URLSearchParams(window.location.search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = params.get(key);
    if (value && /^[A-Za-z0-9_.:\-/+ ]{1,64}$/.test(value)) props[key] = value;
  }
  props.is_mobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;
  if (navigator.language) props.lang = String(navigator.language).slice(0, 16);
  return props;
}
