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

import { compactSnapshot, checkRefs } from '../server/filmcraftAgent.js';
const snap = { tracks: [
  { id: 'V1', kind: 'video', index: 0, name: 'Video 1', clips: [{ id: 7, name: 'a.mp4', start: 0, end: 5 }, { id: 8, name: 'b.mp4', start: 5, end: 9 }] },
  { id: 'A1', kind: 'audio', index: 0, name: 'Music', clips: [{ id: 9, name: 'song.mp3', start: 0, end: 9 }] }],
  media: [{ name: 'a.mp4', type: 'video', duration: 5, junk: 'x' }] };

describe('project snapshot', () => {
  it('normalizes and drops unknown fields', () => {
    const s = compactSnapshot(snap);
    expect(s.tracks[1]).toMatchObject({ id: 'A1', kind: 'audio', name: 'Music' });
    expect(s.media[0]).toEqual({ name: 'a.mp4', type: 'video', duration: 5 });
    expect(compactSnapshot('nope')).toBeNull();
  });
  it('caps long timelines keeping head and tail clips', () => {
    const clips = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `clip-${i}-${'x'.repeat(60)}`, start: i, end: i + 1 }));
    const s = compactSnapshot({ tracks: [{ id: 'V1', clips }] });
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(10000);
    expect(s.tracks[0].clips[0].id).toBe(0);
    expect(s.tracks[0].clips.at(-1).id).toBe(499);
    expect(s.tracks[0].omittedClips).toBe(500 - s.tracks[0].clips.length);
  });
  it('checks clip and track refs against the snapshot', () => {
    const s = compactSnapshot(snap);
    expect(checkRefs({ clip: 8 }, s)).toBeNull();
    expect(checkRefs({ clips: [7, 99] }, s)).toMatch(/clip 99/);
    expect(checkRefs({ track: 'music' }, s)).toBeNull();
    expect(checkRefs({ track: 'V9' }, s)).toMatch(/track V9/);
    expect(checkRefs({ clip: 99 }, null)).toBeNull();
  });
  it('route injects the snapshot, rejects bad refs, and caps steps', async () => {
    let seen;
    const s2 = await serve({ llm: async (m) => { seen = m; return { tool_calls: [
      tc('filmcraft_call', { kind: 'execute', id: 'timeline.razor', params: { time: 1, clip: 8 } }),
      tc('filmcraft_call', { kind: 'execute', id: 'timeline.razor', params: { time: 1, clip: 42 } }),
      tc('finish', { explanation: 'cut', needsResults: true })] }; } });
    try {
      let body = await (await post(s2.base, { prompt: 'cut the second clip', snapshot: snap })).json();
      expect(seen.some(m => m.content.startsWith('Project snapshot') && m.content.includes('"Music"'))).toBe(true);
      expect(body.calls).toEqual([{ kind: 'execute', id: 'timeline.razor', params: { time: 1, clip: 8 } }]);
      expect(body.rejected[0].reason).toMatch(/clip 42/);
      expect(body).toMatchObject({ done: false, step: 1, maxSteps: 6 });
      const history = Array.from({ length: 5 }, () => ({ prompt: 'p', calls: [], results: [] }));
      body = await (await post(s2.base, { prompt: 'continue', snapshot: snap, history })).json();
      expect(body).toMatchObject({ done: true, step: 6 });
    } finally { await s2.close(); }
  });
});

describe('tool loop', () => {
  it('keeps asking until finish and lets the model repair a rejected call', async () => {
    const rounds = [
      { tool_calls: [{ id: 'a', ...tc('filmcraft_call', { kind: 'execute', id: 'timeline.razor', params: {} }) }] },
      { tool_calls: [{ id: 'b', ...tc('filmcraft_call', { kind: 'execute', id: 'timeline.razor', params: { seconds: 5, time: 1 } }) }] },
      { tool_calls: [{ id: 'c', ...tc('filmcraft_call', { kind: 'execute', id: 'sequence.applyVideoTransition', params: {} }) }, { id: 'd', ...tc('finish', { explanation: 'done' }) }] },
    ];
    const seen = [];
    const s2 = await serve({ llm: async (m) => { seen.push(m.at(-1)); return rounds.shift(); } });
    try {
      const body = await (await post(s2.base, { prompt: 'cut at 5 and fade' })).json();
      expect(body.calls.map(c => c.id)).toEqual(['timeline.razor', 'sequence.applyVideoTransition']);
      expect(body.explanation).toBe('done');
      expect(seen[1]).toMatchObject({ role: 'tool', tool_call_id: 'a' });
      expect(seen[1].content).toMatch(/rejected: missing required time/);
    } finally { await s2.close(); }
  });
});

describe('snapshot ids and engine fields', () => {
  it('keeps numeric ids numeric and passes item/link/enabled/markers', () => {
    const s = compactSnapshot({ tracks: [{ id: 15, kind: 'video', name: 'Video 1', clips: [{ id: 52, item: 48, link: '53', name: 'intro.mp4', source: 'intro.mp4', start: 30, end: 34, in: 0, out: 4, enabled: false }] }],
      media: [{ item: 48, name: 'intro.mp4', path: '/files/intro.mp4', duration: '00:00:04:00' }], markers: [{ name: 'Open', start: 0 }], selection: [52] });
    const c = s.tracks[0].clips[0];
    expect(s.tracks[0].id).toBe(15); expect(c.id).toBe(52); expect(c.item).toBe(48); expect(c.link).toBe(53); expect(c.enabled).toBe(false);
    expect(s.media[0]).toMatchObject({ item: 48, path: '/files/intro.mp4', duration: '00:00:04:00' });
    expect(s.markers).toEqual([{ name: 'Open', start: 0 }]); expect(s.selection).toEqual([52]);
  });
  it('coerces quoted ids in calls to numbers', () => {
    const snap = compactSnapshot({ tracks: [{ id: 18, kind: 'audio', clips: [{ id: 57, name: 'music.mp3' }] }] });
    const { calls, rejected } = validateCalls([{ kind: 'execute', id: 'clip.enable', params: { clips: ['57'] } },
      { kind: 'execute', id: 'timeline.setTrack', params: { track: '18', muted: true } }], snap);
    expect(rejected).toEqual([]);
    expect(calls[0].params.clips).toEqual([57]); expect(calls[1].params.track).toBe(18);
  });
  it('offers the clip-level commands for name-based edits', () => {
    const ids = selectTools('delete broll').map(e => e.id);
    for (const id of ['timeline.trim', 'edit.clear', 'clip.enable', 'timeline.setTrack']) expect(ids).toContain(id);
  });
});
