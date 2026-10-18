// @vitest-environment node
// Browser-side debug log: batching, flush rules, window error capture, and the stage events the
// streaming flow emits (technical fields only: no audio, text or tokens).
import { describe, it, expect, vi } from 'vitest';
import { createClientLog } from '../clientLog.js';
import { runStreamingCaptions, SAMPLE_RATE } from '../streamingCaptions.js';
import { encodeWavMono16 } from '../lyricCaptionsClient.js';

const flushTimers = () => new Promise((r) => setTimeout(r, 1100));
const batches = (fetchImpl) => fetchImpl.mock.calls.map(([url, init]) => ({ url, init, body: JSON.parse(init.body) }));

describe('createClientLog', () => {
  it('sends events at once (a page that freezes right after has already reported), with the build id, headers and keepalive', () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    let t = 1000;
    const c = createClientLog({ headers: { 'sample-access-token': 'abc' }, fetchImpl, now: () => (t += 10) });
    c.log('extract_start', { n: 1 }); c.log('extract_end', { n: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [b1, b2] = batches(fetchImpl);
    expect(b1.url).toBe('/api/client-log');
    expect(b1.init.keepalive).toBe(true);
    expect(b1.init.headers['sample-access-token']).toBe('abc');
    expect(b1.body.sid).toMatch(/^[a-z0-9]{6,24}$/);
    expect(typeof b1.body.build).toBe('string');
    expect(b1.body.events.map(e => e.ev)).toEqual(['extract_start']);
    expect(b2.body.events[0].ms).toBeGreaterThan(b1.body.events[0].ms);
  });

  it('the chatty events (pct, ws_tick) wait and ride along with the next event', () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const c = createClientLog({ fetchImpl });
    c.log('pct', { p: 6 }); c.log('ws_tick', { rs: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    c.log('committed', { idx: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(batches(fetchImpl)[0].body.events.map(e => e.ev)).toEqual(['pct', 'ws_tick', 'committed']);
  });

  it('the env event carries the build id', () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    createClientLog({ fetchImpl }).env();
    expect(batches(fetchImpl)[0].body.events[0]).toMatchObject({ ev: 'env', build: expect.any(String) });
  });

  it('reports visibility, pageshow, freeze and resume while attached', () => {
    const handlers = {};
    const doc = { visibilityState: 'hidden', addEventListener: (k, f) => { handlers[`d:${k}`] = f; }, removeEventListener: (k) => { delete handlers[`d:${k}`]; } };
    const win = { document: doc, addEventListener: (k, f) => { handlers[`w:${k}`] = f; }, removeEventListener: (k) => { delete handlers[`w:${k}`]; } };
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const c = createClientLog({ fetchImpl, win });
    c.attach();
    handlers['d:visibilitychange']();
    doc.visibilityState = 'visible';
    handlers['d:visibilitychange']();
    handlers['d:freeze'](); handlers['d:resume'](); handlers['w:pageshow']({ persisted: true });
    const events = batches(fetchImpl).flatMap(b => b.body.events);
    expect(events.filter(e => e.ev === 'visibility').map(e => e.state)).toEqual(['hidden', 'visible']);
    for (const ev of ['freeze', 'resume', 'pageshow']) expect(events.some(e => e.ev === ev)).toBe(true);
    c.detach();
    expect(handlers['d:visibilitychange']).toBeUndefined();
  });

  it('captures window errors and unhandled rejections while attached, and stops after detach', () => {
    const listeners = {};
    const win = { addEventListener: (k, f) => { listeners[k] = f; }, removeEventListener: (k) => { delete listeners[k]; } };
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const c = createClientLog({ fetchImpl, win });
    c.attach();
    listeners.error({ message: 'boom', filename: 'https://grepawk.com/assets/app.js', lineno: 12 });
    listeners.unhandledrejection({ reason: new Error('nope') });
    const events = batches(fetchImpl).flatMap(b => b.body.events);
    expect(events.find(e => e.ev === 'window_error')).toMatchObject({ msg: 'boom', src: 'app.js', line: 12 });
    expect(events.find(e => e.ev === 'unhandled_rejection')).toMatchObject({ msg: 'nope' });
    c.detach();
    expect(listeners.error).toBeUndefined();
  });

  it('never throws, even when fetch fails or throws', () => {
    const c1 = createClientLog({ fetchImpl: () => { throw new Error('x'); } });
    expect(() => { c1.log('ws_close'); c1.flush(); }).not.toThrow();
    const c2 = createClientLog({ fetchImpl: () => Promise.reject(new Error('offline')) });
    expect(() => c2.log('ws_close')).not.toThrow();
  });
});

describe('the streaming flow reports its stages', () => {
  const makeWav = (sec) => {
    const f = new Float32Array(Math.round(sec * SAMPLE_RATE));
    for (let i = 0; i < f.length; i++) f[i] = Math.sin(i / 7) * 0.3;
    return encodeWavMono16(f, SAMPLE_RATE);
  };
  class FakeSocket {
    constructor(url) { this.url = url; this.bufferedAmount = 0; queueMicrotask(() => { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ message_type: 'session_started' }) }); }); }
    send(raw) {
      const m = JSON.parse(raw);
      if (m.commit) queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ message_type: 'partial_transcript', text: 'SECRET SPOKEN WORDS' }) });
        this.onmessage?.({ data: JSON.stringify({ message_type: 'committed_transcript_with_timestamps', text: 'SECRET SPOKEN WORDS', language_code: 'en', words: [{ text: 'SECRET', start: 0.1, end: 0.4, type: 'word' }] }) });
      });
    }
    close() { this.onclose?.({ code: 1000, reason: '', wasClean: true }); }
  }

  it('token, ws open/close, first chunk, first partial, committed, translate and percent, with no content or token in any event', async () => {
    const events = [];
    const fetchImpl = vi.fn(async (u, init) => ({ ok: true, status: 200, json: async () => ({ lines: JSON.parse(init.body).segments.map(s => ({ i: s.i, text: s.text, translation: 'X' })) }) }));
    await runStreamingCaptions({ target_language: 'es' }, makeWav(6), {
      sleep: async () => {}, WebSocketImpl: FakeSocket, fetchImpl,
      mint: async () => ({ token: 'sutkn_SECRETTOKEN0123456789abcdefghijklmnop', sessionId: 's1', wsUrl: 'wss://x/y', query: {} }),
      log: (ev, data) => events.push({ ev, ...data }),
    });
    const names = events.map(e => e.ev);
    for (const n of ['plan', 'token_req', 'token_res', 'ws_new', 'ws_session_started', 'ws_first_msg', 'first_chunk', 'first_partial', 'committed', 'tr_req', 'tr_res', 'pct', 'run_end']) expect(names).toContain(n);
    expect(events.find(e => e.ev === 'plan')).toMatchObject({ dur: 6, samples: 6 * SAMPLE_RATE, ranges: 1 });
    expect(events.find(e => e.ev === 'token_res')).toMatchObject({ ok: true });
    expect(events.find(e => e.ev === 'committed')).toMatchObject({ idx: 0, wc: 1 });
    expect(names.indexOf('token_req')).toBeLessThan(names.indexOf('ws_new'));
    expect(names.indexOf('first_chunk')).toBeLessThan(names.indexOf('committed'));
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('SECRET');
  });

  it('a socket that closes before opening is reported with its code and reason', async () => {
    const events = [];
    class DeadSocket { constructor() { this.bufferedAmount = 0; queueMicrotask(() => this.onclose?.({ code: 1006, reason: '', wasClean: false })); } send() {} close() {} }
    await runStreamingCaptions({ target_language: 'es' }, makeWav(6), {
      sleep: async () => {}, WebSocketImpl: DeadSocket, fetchImpl: vi.fn(), autoResumes: 0,
      mint: async () => ({ token: 't', sessionId: 's1', wsUrl: 'wss://x/y', query: {} }),
      log: (ev, data) => events.push({ ev, ...data }),
    }).catch(() => {});
    expect(events.find(e => e.ev === 'ws_close')).toMatchObject({ code: 1006, clean: false, opened: false });
  });
});
