// Opt-in SSE progress events + heartbeat for long tool endpoints (add_soundtrack).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { openProgressStream, wantsProgressStream, HEARTBEAT_MS } from '../server/progressStream.js';
import { generateSoundtrack, _clearSoundtrackCache, SOUNDTRACK_STAGES, parseSoundtrackRequest } from '../../server/tools/gbk-soundtrack-tool.js';
import { parseSseEvents, readProgressStream } from '../progressStream.js';

function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, { chunks: [], headers: {}, ended: false,
    status(c) { this.code = c; return this; }, set(h) { Object.assign(this.headers, h); return this; },
    write(c) { this.chunks.push(c); }, end() { this.ended = true; } });
  return res;
}
const events = (res) => parseSseEvents(res.chunks.join('')).events;

afterEach(() => vi.useRealTimers());

describe('openProgressStream', () => {
  it('emits progress, a heartbeat with elapsed seconds every 4s, then the result', () => {
    vi.useFakeTimers({ now: 0 });
    const res = fakeRes();
    const s = openProgressStream(res);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    s.progress('rendering', 'Rendering audio…');
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    s.result({ audioBase64: 'UklGRg==' });
    vi.advanceTimersByTime(HEARTBEAT_MS * 3); // no heartbeats after close
    expect(events(res)).toEqual([
      { event: 'progress', data: { type: 'progress', stage: 'rendering', label: 'Rendering audio…', elapsed: 0 } },
      { event: 'heartbeat', data: { type: 'heartbeat', elapsed: 4 } },
      { event: 'heartbeat', data: { type: 'heartbeat', elapsed: 8 } },
      { event: 'result', data: { type: 'result', audioBase64: 'UklGRg==', elapsed: 8 } },
    ]);
    expect(res.ended).toBe(true);
  });

  it('stops the heartbeat when the client disconnects', () => {
    vi.useFakeTimers({ now: 0 });
    const res = fakeRes();
    openProgressStream(res);
    res.emit('close');
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(res.chunks).toEqual([]);
  });

  it('is opt-in via the Accept header', () => {
    expect(wantsProgressStream({ get: () => 'text/event-stream' })).toBe(true);
    expect(wantsProgressStream({ get: () => '*/*' })).toBe(false);
    expect(wantsProgressStream({ get: () => undefined })).toBe(false);
  });
});

describe('generateSoundtrack stages', () => {
  it('reports composing → rendering → downloading, each with a label', async () => {
    _clearSoundtrackCache();
    const data = {
      gbk_create_composition: { compositionId: 'c1', revision: 1 }, gbk_edit_composition: { revision: 2 },
      gbk_render_composition: { jobId: 'j1', status: 'completed' },
      gbk_get_artifacts: { latest: { wav: { downloadUrl: 'https://gbk.test/a.wav' } } },
    };
    const fetchImpl = async (url, init) => {
      if (url.endsWith('.wav')) return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
      const msg = JSON.parse(init.body);
      const result = msg.method === 'tools/call' ? { structuredContent: data[msg.params.name] } : {};
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) };
    };
    const stages = [];
    await generateSoundtrack(parseSoundtrackRequest({ prompt: 'x', duration_seconds: 9 }), { fetchImpl, token: 't', url: 'https://gbk.test/mcp', env: {}, onStage: s => stages.push(s) });
    expect(stages).toEqual(['composing', 'rendering', 'downloading']);
    expect(stages.every(s => SOUNDTRACK_STAGES[s].endsWith('…'))).toBe(true);
  });
});

describe('client SSE parsing', () => {
  it('parses events split across chunks and ignores unknown events and comments', async () => {
    const body = 'event: progress\ndata: {"type":"progress","label":"Rendering audio…"}\n\n: ping\n\nevent: future\ndata: {"type":"future"}\n\nevent: heartbeat\ndata: {"type":"heartbeat","elapsed":4}\n\nevent: result\ndata: {"type":"result","audioBase64":"AQID"}\n\n';
    const enc = new TextEncoder().encode(body);
    const parts = [enc.slice(0, 7), enc.slice(7, 60), enc.slice(60)];
    const response = new Response(new ReadableStream({ start(c) { parts.forEach(p => c.enqueue(p)); c.close(); } }));
    const seen = [];
    const result = await readProgressStream(response, e => seen.push(e.type));
    expect(seen).toEqual(['progress', 'future', 'heartbeat']);
    expect(result.audioBase64).toBe('AQID');
  });

  it('throws the server error with its code', async () => {
    const response = new Response('event: error\ndata: {"type":"error","error":"Music render failed","code":"soundtrack_failed"}\n\n');
    await expect(readProgressStream(response, () => {})).rejects.toMatchObject({ message: 'Music render failed', code: 'soundtrack_failed' });
  });

  it('fails when the stream ends without a result', async () => {
    await expect(readProgressStream(new Response('event: heartbeat\ndata: {"elapsed":4}\n\n'), () => {})).rejects.toThrow(/ended/);
  });
});
