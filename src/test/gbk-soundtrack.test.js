// add_soundtrack server flow against a mocked GBK MCP (no network, no credentials).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateSoundtrack, parseSoundtrackRequest, SoundtrackError, _clearSoundtrackCache,
} from '../../server/tools/gbk-soundtrack-tool.js';
import { soundtrackEnabled } from '../server/soundtrackTool.js';
import { offeredToolsFor } from '../server/toolsSchema.js';
import { soundtrackPrompt } from '../soundtrackPrompt.js';

const WAV = new Uint8Array([82, 73, 70, 70]);

function mockGbk({ toolResults = {}, renderStatuses = ['running', 'completed'] } = {}) {
  const calls = [];
  let statusIdx = 0;
  const reply = (id, result, sse) => ({
    ok: true, status: 200, headers: { get: (h) => (h === 'mcp-session-id' ? 'sess-1' : null) },
    text: async () => {
      const json = JSON.stringify({ jsonrpc: '2.0', id, result });
      return sse ? `event: message\ndata: ${json}\n\n` : json;
    },
  });
  const tool = (data) => ({ structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });
  const fetchImpl = vi.fn(async (url, init) => {
    if (url === 'https://gbk.test/a.wav') return { ok: true, arrayBuffer: async () => WAV.buffer };
    const msg = JSON.parse(init.body);
    calls.push({ msg, headers: init.headers });
    if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: '2025-06-18' });
    if (!msg.id) return { ok: true, status: 202, headers: { get: () => null } };
    const name = msg.params.name;
    if (toolResults[name]) return reply(msg.id, toolResults[name], true);
    const data = {
      gbk_create_composition: { compositionId: 'c1', revision: 1, bars: 8 },
      gbk_edit_composition: { compositionId: 'c1', revision: 2 },
      gbk_render_composition: { jobId: 'j1', status: 'queued' },
      gbk_get_render_status: () => ({ jobId: 'j1', status: renderStatuses[statusIdx++] ?? 'completed' }),
      gbk_get_artifacts: { latest: { wav: { downloadUrl: 'https://gbk.test/a.wav', mimeType: 'audio/wav', sha256: 'abc' } } },
    }[name];
    return reply(msg.id, tool(typeof data === 'function' ? data() : data), true);
  });
  return { fetchImpl, calls };
}

const deps = (m) => ({ fetchImpl: m.fetchImpl, token: 'svc-token', url: 'https://gbk.test/mcp', sleep: async () => {}, env: {} });
const req = (over = {}) => parseSoundtrackRequest({ prompt: 'calm piano', style: 'ambient', duration_seconds: 20, ...over });

describe('add_soundtrack (GBK MCP)', () => {
  beforeEach(() => _clearSoundtrackCache());

  it('runs create → edit → render → status → artifacts and returns the WAV', async () => {
    const m = mockGbk();
    const out = await generateSoundtrack(req(), deps(m));
    expect(Buffer.from(out.bytes)).toEqual(Buffer.from(WAV));
    expect(out).toMatchObject({ mimeType: 'audio/wav', durationSeconds: 20, cached: false });
    const tools = m.calls.filter(c => c.msg.method === 'tools/call').map(c => c.msg.params.name);
    expect(tools).toEqual(['gbk_create_composition', 'gbk_edit_composition', 'gbk_render_composition',
      'gbk_get_render_status', 'gbk_get_render_status', 'gbk_get_artifacts']);
    const create = m.calls.find(c => c.msg.params?.name === 'gbk_create_composition');
    expect(create.headers.Authorization).toBe('Bearer svc-token');
    expect(create.headers['mcp-session-id']).toBe('sess-1');
    expect(create.msg.params.arguments).toMatchObject({ style: 'ambient', durationSeconds: 20 });
    const edit = m.calls.find(c => c.msg.params?.name === 'gbk_edit_composition').msg.params.arguments;
    expect(edit).toMatchObject({ compositionId: 'c1', expectedRevision: 1, operations: [{ type: 'generate_arrangement', style: 'ambient', bars: 8 }] });
  });

  it('reuses an identical request from cache', async () => {
    const m = mockGbk();
    await generateSoundtrack(req(), deps(m));
    const n = m.fetchImpl.mock.calls.length;
    expect((await generateSoundtrack(req({ prompt: 'other words' }), deps(m))).cached).toBe(true);
    expect(m.fetchImpl.mock.calls.length).toBe(n);
  });

  it('maps GBK QUOTA_EXCEEDED to a friendly 429', async () => {
    const m = mockGbk({ toolResults: { gbk_create_composition: { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'QUOTA_EXCEEDED', message: 'daily renders used' } }) }] } } });
    await expect(generateSoundtrack(req(), deps(m))).rejects.toMatchObject({ code: 'soundtrack_limit', status: 429 });
  });

  it('fails with a render error and without a token', async () => {
    const m = mockGbk({ renderStatuses: ['failed'] });
    await expect(generateSoundtrack(req(), deps(m))).rejects.toMatchObject({ code: 'soundtrack_failed' });
    await expect(generateSoundtrack(req(), { ...deps(m), token: undefined })).rejects.toMatchObject({ code: 'soundtrack_unavailable', status: 503 });
  });

  it('validates and clamps the request', () => {
    expect(() => parseSoundtrackRequest({ duration_seconds: 10 })).toThrow(SoundtrackError);
    expect(() => parseSoundtrackRequest({ prompt: 'x' })).toThrow(SoundtrackError);
    expect(parseSoundtrackRequest({ prompt: 'x', duration_seconds: 9999, style: 'metal' })).toMatchObject({ durationSeconds: 300, style: 'pop' });
  });
});

describe('add_soundtrack off switch and gating', () => {
  const names = (opts) => offeredToolsFor(opts).map(t => t.function.name);
  it('SOUNDTRACK_ENABLED is on by default, off only for 0/false/off', () => {
    expect(soundtrackEnabled({})).toBe(true);
    expect(soundtrackEnabled({ SOUNDTRACK_ENABLED: '1' })).toBe(true);
    for (const v of ['0', 'false', 'OFF']) expect(soundtrackEnabled({ SOUNDTRACK_ENABLED: v })).toBe(false);
  });
  it('offered to web and iOS build >= 21, removed when switched off', () => {
    expect(names({ userAgent: 'Mozilla/5.0', mediaType: 'video' })).toContain('add_soundtrack');
    expect(names({ userAgent: 'Mozilla/5.0', mediaType: 'image' })).not.toContain('add_soundtrack');
    expect(names({ userAgent: 'FinalCap-iOS/21' })).toContain('add_soundtrack');
    expect(names({ userAgent: 'FinalCap-iOS/20' })).not.toContain('add_soundtrack');
    vi.stubEnv('SOUNDTRACK_ENABLED', '0');
    try {
      expect(names({ userAgent: 'Mozilla/5.0' })).not.toContain('add_soundtrack');
      expect(names({ userAgent: 'FinalCap-iOS/21' })).not.toContain('add_soundtrack');
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('soundtrackPrompt (composer prefill)', () => {
  it('references the video duration when known', () => {
    expect(soundtrackPrompt(31.6)).toContain('about 32 seconds long');
    expect(soundtrackPrompt(NaN)).toContain('about as long as the video');
  });
});
