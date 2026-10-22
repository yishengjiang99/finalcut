// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createFilmcraftAgentRouter, selectTools, validateCalls, parsePlan, CATALOG } from '../server/filmcraftAgent.js';

const pass = (req, res, next) => next();
const tc = (name, args) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function serve(opts) {
  const app = express();
  app.use(createFilmcraftAgentRouter({ limiter: pass, token: () => 'k', ...opts }));
  app.use(express.json());
  app.post('/api/other', (req, res) => res.json({ ok: true }));
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}
const post = (base, body, path = '/api/filmcraft/agent') => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('filmcraft agent catalog', () => {
  it('ships core commands only, with execute and request kinds', () => {
    expect(CATALOG.length).toBeGreaterThan(500);
    expect(CATALOG.find(e => e.id === 'timeline.razor').kind).toBe('execute');
    expect(CATALOG.find(e => e.id === 'ui.inspect').kind).toBe('request');
  });
  it('retrieval keeps the prompt small and relevant', () => {
    const ids = selectTools('cut the clip at 5 seconds and add a fade').map(e => e.id);
    expect(ids.length).toBeLessThanOrEqual(40);
    expect(ids).toContain('timeline.razor');
    expect(ids).toContain('sequence.applyVideoTransition');
    expect(selectTools('export as 1080p mp4').map(e => e.id)).toContain('export.quick');
  });
});

describe('validateCalls', () => {
  it('accepts known calls, repairs kind/prefix, rejects unknown ids and missing required args', () => {
    const { calls, rejected } = validateCalls([
      { kind: 'execute', id: 'timeline.razor', params: { time: 5 } },
      { kind: 'execute', id: 'control.ui.inspect' },
      { kind: 'execute', id: 'made.up' },
      { kind: 'execute', id: 'timeline.razor', params: {} },
      { kind: 'execute', id: 'playhead.set', params: { seconds: 5 } },
    ]);
    expect(calls).toEqual([
      { kind: 'execute', id: 'timeline.razor', params: { time: 5 } },
      { kind: 'request', method: 'ui.inspect', params: {} },
      { kind: 'execute', id: 'playhead.set', params: { seconds: 5 } },
    ]);
    expect(rejected.map(r => r.reason)).toEqual(['unknown command made.up', 'missing required time for timeline.razor']);
  });
  it('treats a|b required names as alternatives', () => {
    expect(validateCalls([{ id: 'captions.setTimes', params: { startSeconds: 0, endSeconds: 2 } }]).calls).toHaveLength(1);
  });
  it('parsePlan reads finish + calls', () => {
    const p = parsePlan({ tool_calls: [tc('filmcraft_call', { kind: 'execute', id: 'x' }), tc('finish', { explanation: 'ok', needsResults: true })] });
    expect(p).toEqual({ raw: [{ kind: 'execute', id: 'x' }], explanation: 'ok', needsResults: true });
  });
});

describe('POST /api/filmcraft/agent', () => {
  let srv;
  afterEach(async () => { if (srv) await srv.close(); srv = null; });

  it('returns validated calls from the LLM plan', async () => {
    let seen;
    srv = await serve({ llm: async (m) => { seen = m; return { tool_calls: [
      tc('filmcraft_call', { kind: 'execute', id: 'captions.add', params: { text: 'Hello', seconds: 0 } }),
      tc('filmcraft_call', { kind: 'execute', id: 'nope' }), tc('finish', { explanation: 'Added caption.' })] }; } });
    const res = await post(srv.base, { prompt: 'add a caption saying Hello at the start', state: { clips: [] } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.calls).toEqual([{ kind: 'execute', id: 'captions.add', params: { text: 'Hello', seconds: 0 } }]);
    expect(body.done).toBe(true);
    expect(body.explanation).toBe('Added caption.');
    expect(body.rejected).toHaveLength(1);
    expect(seen.some(m => m.content.includes('Editor state'))).toBe(true);
  });
  it('validates input sizes', async () => {
    srv = await serve({ llm: async () => ({}) });
    expect((await post(srv.base, {})).status).toBe(400);
    expect((await post(srv.base, { prompt: 'x'.repeat(2001) })).status).toBe(413);
    expect((await post(srv.base, { prompt: 'hi', history: 'no' })).status).toBe(400);
  });
  it('kill switch returns 503 and leaves other routes alone', async () => {
    srv = await serve({ env: { FILMCRAFT_AGENT_DISABLED: 'true' }, llm: async () => { throw new Error('should not run'); } });
    expect((await post(srv.base, { prompt: 'hi' })).status).toBe(503);
    expect(await (await post(srv.base, { a: 1 }, '/api/other')).json()).toEqual({ ok: true });
  });
  it('503 without an LLM key, 502 when the LLM fails', async () => {
    srv = await serve({ token: () => '', llm: async () => ({}) });
    expect((await post(srv.base, { prompt: 'hi' })).status).toBe(503);
    await srv.close();
    srv = await serve({ llm: async () => { throw new Error('boom'); } });
    expect((await post(srv.base, { prompt: 'hi' })).status).toBe(502);
  });
});
