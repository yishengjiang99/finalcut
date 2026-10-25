// youtube_soundtrack in the web editor: the tool fetches the audio from
// POST /api/youtube-audio/fetch (fetch mocked — no network, no YouTube) and mixes it with the
// existing ffmpeg.wasm add-audio path (engine mocked via noWasmEngine). The argv builder tests
// pin the soundtrack extensions (start offset, original-audio scaling, pad-to-video-end) and that
// the defaults reproduce the add_audio_track argv exactly.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as engine from '../wasm/ffmpegEngine.js';

vi.mock('../wasm/ffmpegEngine.js', async (importOriginal) => (await import('./helpers/noWasmEngine.js')).noWasmEngine(importOriginal));

import { toolFunctions, getLastExecution, resetLastExecution } from '../toolFunctions.js';
import { buildAddAudioTrackArgs } from '../wasm/ops/multi.js';

global.fetch = vi.fn();
global.URL.createObjectURL = vi.fn(() => 'mock-url');

const AUDIO_BYTES = new Uint8Array([1, 2, 3, 4]);

function fetchOk({ duration = '180', title = 'Smoke%20Song', videoId = 'dQw4w9WgXcQ' } = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => ({
        'X-Audio-Duration': duration,
        'X-Audio-Title': title,
        'X-Video-Id': videoId,
        'X-Audio-Cached': 'false',
      })[name] ?? null,
    },
    arrayBuffer: async () => AUDIO_BYTES.buffer,
    json: async () => ({}),
  };
}

function fetchError(status, body) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => body,
  };
}

describe('buildAddAudioTrackArgs soundtrack options', () => {
  const io = { video: 'video.mp4', audio: 'track.m4a', output: 'out.mp4', sourceHasAudio: true };

  it('defaults reproduce the historical add_audio_track argv exactly', () => {
    expect(buildAddAudioTrackArgs({ mode: 'replace', volume: 1 }, io)).toEqual([
      '-hide_banner', '-nostdin', '-y', '-i', 'video.mp4', '-i', 'track.m4a',
      '-filter_complex', '[1:a]volume=1[outaudio]',
      '-map', '0:v:0', '-map', '[outaudio]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', 'out.mp4',
    ]);
    expect(buildAddAudioTrackArgs({ mode: 'mix', volume: 0.8 }, io)).toContain(
      '[1:a]volume=0.8[newaudio];[0:a][newaudio]amix=inputs=2:duration=first:dropout_transition=2[outaudio]'
    );
  });

  it('startOffset seeks into the audio input only', () => {
    const argv = buildAddAudioTrackArgs({ mode: 'replace', volume: 1, startOffset: 42 }, io);
    const audioInput = argv.indexOf('track.m4a');
    expect(argv.slice(audioInput - 3, audioInput + 1)).toEqual(['-ss', '42', '-i', 'track.m4a']);
    expect(argv.filter(a => a === '-ss')).toHaveLength(1);
  });

  it('originalVolume scales the original track in the mix graph', () => {
    const argv = buildAddAudioTrackArgs({ mode: 'mix', volume: 1, originalVolume: 0.25 }, io);
    expect(argv).toContain('[1:a]volume=1[newaudio];[0:a]volume=0.25[origaudio];[origaudio][newaudio]amix=inputs=2:duration=first:dropout_transition=2[outaudio]');
  });

  it('padToVideoEnd pads a shorter soundtrack with silence (replace graph only)', () => {
    expect(buildAddAudioTrackArgs({ mode: 'replace', volume: 1, padToVideoEnd: true }, io)).toContain('[1:a]volume=1,apad[outaudio]');
    expect(buildAddAudioTrackArgs({ mode: 'mix', volume: 1, padToVideoEnd: true }, io)).not.toContain('apad');
  });

  it('rejects invalid soundtrack options', () => {
    expect(() => buildAddAudioTrackArgs({ mode: 'replace', volume: 1, startOffset: -1 }, io)).toThrow(/startOffset/);
    expect(() => buildAddAudioTrackArgs({ mode: 'mix', volume: 1, originalVolume: 1.5 }, io)).toThrow(/originalVolume/);
  });
});

describe('toolFunctions.youtube_soundtrack (web)', () => {
  let mockAddMessage;
  let mockSetVideoFileData;
  const videoData = new Uint8Array([9, 9, 9]);

  beforeEach(() => {
    vi.clearAllMocks();
    resetLastExecution();
    mockAddMessage = vi.fn();
    mockSetVideoFileData = vi.fn();
    global.fetch.mockResolvedValue(fetchOk());
  });

  it('fetches the audio and replaces the original by default', async () => {
    const result = await toolFunctions.youtube_soundtrack(
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      videoData, mockSetVideoFileData, mockAddMessage
    );
    expect(result).toContain('Soundtrack applied');
    expect(result).toContain('Smoke Song');
    expect(result).toContain('muted');
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('/api/youtube-audio/fetch');
    expect(JSON.parse(init.body)).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(engine.addAudioTrack).toHaveBeenCalledWith(
      { mode: 'replace', volume: 1, startOffset: 0, originalVolume: 0, padToVideoEnd: true },
      videoData,
      expect.any(String),
      { bytes: AUDIO_BYTES, extension: 'm4a' }
    );
    expect(mockSetVideoFileData).toHaveBeenCalledWith(new Uint8Array([7, 7, 7]));
    expect(getLastExecution().executedOn).toBe('browser');
  });

  it('mixes with the original kept under the music when original_volume > 0', async () => {
    const result = await toolFunctions.youtube_soundtrack(
      { url: 'https://youtu.be/dQw4w9WgXcQ', start_offset: 30, original_volume: 0.4 },
      videoData, mockSetVideoFileData, mockAddMessage
    );
    expect(result).toContain('starting at 30s');
    expect(result).toContain('kept at 40%');
    expect(engine.addAudioTrack).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'mix', startOffset: 30, originalVolume: 0.4 }),
      videoData, expect.any(String), expect.objectContaining({ extension: 'm4a' })
    );
  });

  it('requires a url and validates the numeric arguments before fetching', async () => {
    expect(await toolFunctions.youtube_soundtrack({}, videoData, mockSetVideoFileData, mockAddMessage)).toContain('Failed');
    expect(await toolFunctions.youtube_soundtrack({ url: 'x', original_volume: 2 }, videoData, mockSetVideoFileData, mockAddMessage)).toContain('Failed');
    expect(await toolFunctions.youtube_soundtrack({ url: 'x', start_offset: 601 }, videoData, mockSetVideoFileData, mockAddMessage)).toContain('Failed');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(engine.addAudioTrack).not.toHaveBeenCalled();
  });

  it('refuses a start offset past the end of the fetched audio', async () => {
    global.fetch.mockResolvedValue(fetchOk({ duration: '90' }));
    const result = await toolFunctions.youtube_soundtrack(
      { url: 'https://youtu.be/dQw4w9WgXcQ', start_offset: 120 },
      videoData, mockSetVideoFileData, mockAddMessage
    );
    expect(result).toContain('Failed');
    expect(result).toContain('past the end');
    expect(engine.addAudioTrack).not.toHaveBeenCalled();
  });

  it('surfaces the server error message and stable code', async () => {
    global.fetch.mockResolvedValue(fetchError(422, { error: 'That YouTube audio is 12 minutes long; the limit is 10 minutes.', code: 'youtube_audio_too_long' }));
    const result = await toolFunctions.youtube_soundtrack(
      { url: 'https://youtu.be/dQw4w9WgXcQ' },
      videoData, mockSetVideoFileData, mockAddMessage
    );
    expect(result).toContain('Failed to add YouTube soundtrack');
    expect(result).toContain('limit is 10 minutes');
    expect(getLastExecution().errorCode).toBe('youtube_audio_too_long');
    expect(engine.addAudioTrack).not.toHaveBeenCalled();
  });
});
