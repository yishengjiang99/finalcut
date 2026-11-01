// add_soundtrack on the web: consumes the SSE progress stream (stages reach the chat), still
// accepts a raw WAV from an older server, and the chat label shows the stage with elapsed seconds.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as engine from '../wasm/ffmpegEngine.js';

vi.mock('../wasm/ffmpegEngine.js', async (importOriginal) => (await import('./helpers/noWasmEngine.js')).noWasmEngine(importOriginal));

import { toolFunctions, setToolStatusListener } from '../toolFunctions.js';
import { typingStageText } from '../App.jsx';

global.fetch = vi.fn();
global.URL.createObjectURL = vi.fn(() => 'mock-url');

const sse = (body) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });

describe('add_soundtrack progress (web)', () => {
  let statuses;
  beforeEach(() => {
    vi.mocked(engine.addAudioTrack).mockReset().mockResolvedValue(new Uint8Array([9]));
    global.fetch.mockReset();
    statuses = [];
    setToolStatusListener(s => statuses.push(s));
  });

  it('shows server stages, then the local mix stage, and mixes the streamed WAV', async () => {
    global.fetch.mockResolvedValue(sse(
      'event: progress\ndata: {"type":"progress","stage":"rendering","label":"Rendering audio…"}\n\n'
      + 'event: heartbeat\ndata: {"type":"heartbeat","elapsed":4}\n\n'
      + 'event: result\ndata: {"type":"result","audioBase64":"UklGRg=="}\n\n'));
    const result = await toolFunctions.add_soundtrack({ prompt: 'calm', duration_seconds: 10 }, new Uint8Array([1]), vi.fn(), vi.fn());
    expect(result).toMatch(/generated and added/);
    expect(global.fetch.mock.calls[0][1].headers.Accept).toMatch(/text\/event-stream/);
    expect(statuses.filter(s => s.stage).map(s => s.text)).toEqual(['Composing track…', 'Rendering audio…', 'Mixing into video…']);
    expect([...vi.mocked(engine.addAudioTrack).mock.calls[0][3].bytes]).toEqual([82, 73, 70, 70]);
  });

  it('still accepts a raw WAV response (older server)', async () => {
    global.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { 'Content-Type': 'audio/wav' } }));
    await toolFunctions.add_soundtrack({ prompt: 'calm', duration_seconds: 10 }, new Uint8Array([1]), vi.fn(), vi.fn());
    expect([...vi.mocked(engine.addAudioTrack).mock.calls[0][3].bytes]).toEqual([1, 2]);
  });

  it('reports a streamed error as a failed tool result', async () => {
    global.fetch.mockResolvedValue(sse('event: error\ndata: {"type":"error","error":"Music render failed","code":"soundtrack_failed"}\n\n'));
    const result = await toolFunctions.add_soundtrack({ prompt: 'calm', duration_seconds: 10 }, new Uint8Array([1]), vi.fn(), vi.fn());
    expect(result).toBe('Failed to add soundtrack: Music render failed');
  });
});

describe('typingStageText', () => {
  it('prefers measured progress, then stage + elapsed, then the tool stage', () => {
    expect(typingStageText({ turnStatus: { text: 'Captions 40%', progress: 0.4 }, stage: { label: 'x', startedAt: 0 }, now: 5000 })).toBe('Captions 40%');
    expect(typingStageText({ stage: { label: 'Rendering audio…', startedAt: 0 }, now: 12_400 })).toBe('Rendering audio… 12s');
    expect(typingStageText({ stage: { label: 'Composing track…', startedAt: 0 }, now: 300 })).toBe('Composing track…');
    expect(typingStageText({ toolStage: 'Processing with ffmpeg…' })).toBe('Processing with ffmpeg…');
    expect(typingStageText({})).toBe('Working…');
  });
});
