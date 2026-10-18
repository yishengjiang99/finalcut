// Technical stage events from the browser to POST /api/client-log (the server writes them to the journal as
// `client-log {json}` lines) so a hang on someone's phone can be diagnosed. Only technical fields are sent:
// never audio, transcript or caption text, tokens, keys or headers. Failures here never affect the flow.

const MAX_BATCH = 50;
const FLUSH_MS = 1000;
const TERMINAL = new Set(['ws_close', 'window_error', 'unhandled_rejection', 'run_fail', 'run_done', 'stall']);

function newSid() {
  const bytes = new Uint8Array(12);
  try { globalThis.crypto.getRandomValues(bytes); } catch { for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
}

const cut = (v, n = 120) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);

export function createClientLog({ headers = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), win = globalThis.window, enabled = true, debug } = {}) {
  const sid = newSid();
  const t0 = now();
  let buffer = [];
  let timer = null;
  let attached = null;
  const debugOn = debug ?? (() => { try { return Boolean(globalThis.localStorage?.getItem('fc.debug')); } catch { return false; } })();

  const send = (events, { beacon = false } = {}) => {
    if (!enabled || !events.length) return;
    const body = JSON.stringify({ sid, events });
    try {
      if (beacon && globalThis.navigator?.sendBeacon) {
        globalThis.navigator.sendBeacon('/api/client-log', new Blob([body], { type: 'application/json' }));
        return;
      }
      const p = fetchImpl?.('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body, keepalive: true });
      p?.catch?.(() => {});
    } catch { /* logging must never break the flow */ }
  };

  const flush = (opts) => {
    clearTimeout(timer);
    timer = null;
    const events = buffer;
    buffer = [];
    for (let i = 0; i < events.length; i += MAX_BATCH) send(events.slice(i, i + MAX_BATCH), opts);
  };

  const log = (ev, data = {}) => {
    try {
      const entry = { ev, ms: now() - t0, ...data };
      if (debugOn) console.debug('[fc]', ev, data);
      if (!enabled) return;
      buffer.push(entry);
      if (TERMINAL.has(ev) || buffer.length >= MAX_BATCH) flush();
      else if (!timer) timer = setTimeout(flush, FLUSH_MS);
    } catch { /* ignore */ }
  };

  /** Report uncaught errors and rejected promises while the flow runs, and flush with a beacon if the page goes away. */
  const attach = () => {
    if (attached || !win?.addEventListener) return;
    const onError = (e) => log('window_error', { msg: cut(e?.message), src: cut(String(e?.filename || '').split('/').pop(), 60), line: e?.lineno });
    const onRejection = (e) => log('unhandled_rejection', { msg: cut(e?.reason?.message ?? e?.reason) });
    const onHide = () => { log('pagehide'); flush({ beacon: true }); };
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);
    win.addEventListener('pagehide', onHide);
    attached = () => {
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
      win.removeEventListener('pagehide', onHide);
    };
  };
  const detach = () => { attached?.(); attached = null; flush(); };

  /** What this browser can do, once per flow. */
  const env = () => {
    const nav = globalThis.navigator || {};
    log('env', {
      cois: Boolean(globalThis.crossOriginIsolated),
      sab: typeof SharedArrayBuffer !== 'undefined',
      ws: typeof WebSocket !== 'undefined',
      ac: typeof (globalThis.AudioContext || globalThis.webkitAudioContext) !== 'undefined',
      net: nav.onLine,
      vis: globalThis.document?.visibilityState,
      mem: nav.deviceMemory,
      cores: nav.hardwareConcurrency,
    });
  };

  return { sid, log, flush, attach, detach, env };
}

/** A log that does nothing, for callers that do not pass one. */
export const noopLog = Object.assign(() => {}, { sid: null });
