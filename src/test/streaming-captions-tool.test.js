// The chat tool on web: a plain "add captions in Chinese" streams to ElevenLabs after an explicit
// "Send audio" (asked every time), translates, and burns in the browser with the agreed ASS style.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setUploadConsentHandler, setCloudCaptions } from '../engineMode.js';

const engineMock = vi.hoisted(() => ({ burnFails: false, burns: [] }));
vi.mock('../wasm/ffmpegEngine.js', async (importOriginal) => {
  const base = await (await import('./helpers/noWasmEngine.js')).noWasmEngine(importOriginal);
  return {
    ...base,
    burnAss: async (ass, bytes) => {
      if (engineMock.burnFails) throw Object.assign(new Error('no wasm'), { code: 'wasm_load_failed' });
      engineMock.burns.push({ ass, bytes });
      return new Uint8Array([9, 9, bytes.length]);
    },
  };
});
vi.mock('../streamingCaptions.js', async (importOriginal) => ({
  ...(await importOriginal()),
  streamingAvailable: vi.fn(),
  runStreamingCaptions: vi.fn(),
}));
vi.mock('../lyricCaptionsClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runLyricCaptionsWeb: vi.fn(async () => ({ burned: new Uint8Array([5]), audioBytes: 44, summary: { translatedCount: 1 }, result: { lines: [{}], language: 'en', targetLanguage: 'zh-Hans', mode: 'lyrics', song: null } })),
}));
import { toolFunctions } from '../toolFunctions.js';
import * as streaming from '../streamingCaptions.js';
import * as lyricClient from '../lyricCaptionsClient.js';
import { noteDerivedVideo, videoHasBurnedCaptions } from '../captionLineage.js';

const lines = [
  { start: 0.5, end: 2.5, text: 'Hello my friend', translation: '你好，我的朋友' },
  { start: 3, end: 5, text: 'See you soon', translation: '很快见' },
];
const streamed = { lines, language: 'en', targetLanguage: 'zh-Hans', translatedCount: 2, audioSeconds: 6, sessionId: 's' };
const requests = [];
let consent;
const tool = async (args, input = new Uint8Array([1, 2, 3])) => {
  const messages = [];
  let output = input;
  const result = await toolFunctions.lyric_captions(args, input, (d) => { noteDerivedVideo(input, d); output = d; }, (m) => messages.push(m));
  return { result, messages, output };
};

beforeEach(() => {
  requests.length = 0;
  engineMock.burnFails = false;
  engineMock.burns.length = 0;
  consent = vi.fn(async () => true);
  setUploadConsentHandler(consent);
  setCloudCaptions(true); // a stored "cloud captions" opt-in must not skip the ElevenLabs prompt
  global.URL.createObjectURL = vi.fn(() => 'blob:x');
  streaming.streamingAvailable.mockReset().mockResolvedValue(true);
  streaming.runStreamingCaptions.mockReset().mockResolvedValue(streamed);
  lyricClient.runLyricCaptionsWeb.mockClear();
  global.FormData = class { constructor() { this.data = {}; requests.push(this); } append(k, v) { this.data[k] = v; } };
  global.fetch = vi.fn(async (url) => {
    if (url === '/api/streaming-captions/burn') return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([7, 7]).buffer };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => setUploadConsentHandler(null));

describe('streaming lyric_captions on web', () => {
  it('asks "Send the audio to ElevenLabs?" with the Design wording, every time', async () => {
    await tool({ target_language: 'zh-Hans' });
    await tool({ target_language: 'zh-Hans' });
    const asks = consent.mock.calls.map(c => c[0]).filter(r => r.kind === 'streaming_audio');
    expect(asks).toHaveLength(2);
    expect(asks[0]).toMatchObject({
      title: 'Send the audio to ElevenLabs?',
      body: "FinalCap will stream this video's audio, but not the picture, to ElevenLabs to transcribe it. ElevenLabs may keep the audio and the transcript, and FinalCap can't delete them. The text is then sent to FinalCap, which sends it to xAI (Grok) to translate.",
      privacyLabel: 'Privacy details',
      privacyHref: '/legal/privacy.html#streaming-captions',
      confirmLabel: 'Send audio',
      declineLabel: 'Not now',
      provider: 'elevenlabs',
      uploads: 'audio',
    });
  });

  it('"Not now": nothing is extracted, streamed or changed', async () => {
    consent.mockResolvedValue(false);
    const { result, messages } = await tool({ target_language: 'zh-Hans' });
    expect(streaming.runStreamingCaptions).not.toHaveBeenCalled();
    expect(messages.map(m => m.text)).toEqual(['Audio not sent. Nothing was changed.']);
    expect(result).toContain('Audio not sent. Nothing was changed.');
  });

  it('streams, translates and burns in the browser with the agreed style (one two-line Dialogue per caption)', async () => {
    const { result, messages, output } = await tool({ target_language: 'zh-Hans' });
    expect(streaming.runStreamingCaptions).toHaveBeenCalledTimes(1);
    expect(streaming.runStreamingCaptions.mock.calls[0][0]).toMatchObject({ target_language: 'zh-Hans' });
    expect(engineMock.burns).toHaveLength(1);
    const ass = engineMock.burns[0].ass;
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toMatch(/Style: Default,[^,]+,\d+,/);
    expect(ass).toMatch(/,-1,0,0,0,100,100,0,0,1,3,1,2,\d+,\d+,216,1/); // bold, outline 3, shadow 1, Alignment 2, MarginV 20% of 1080
    const dialogues = ass.split('\n').filter(l => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(2);
    expect(dialogues[0]).toContain('Hello my friend\\N你好，我的朋友');
    expect(output).toEqual(new Uint8Array([9, 9, 3]));
    expect(videoHasBurnedCaptions(output)).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toMatch(/Bilingual captions burned in \(2 lines, en → zh-Hans\)/);
    expect(result).toMatch(/streamed/);
    expect(result).toMatch(/ElevenLabs may keep it, so do not tell the user it was deleted/);
    expect(result).toMatch(/burn-in: on this device/);
    expect(lyricClient.runLyricCaptionsWeb).not.toHaveBeenCalled();
  });

  it('a second call replaces the captions: the burn starts from the uncaptioned video (no double burn)', async () => {
    const original = new Uint8Array([1, 2, 3]);
    const first = await tool({ target_language: 'zh-Hans' }, original);
    const second = await tool({ target_language: 'zh-Hans' }, first.output);
    expect(second.result).toMatch(/Replaced the captions burned earlier/);
    expect(engineMock.burns[1].bytes).toBe(original);
  });

  it('falls back to the consented server burn (video upload) when the browser cannot burn', async () => {
    engineMock.burnFails = true;
    const { result } = await tool({ target_language: 'zh-Hans' });
    const asks = consent.mock.calls.map(c => c[0]);
    expect(asks.some(r => r.uploads === 'video' && r.tool === 'lyric_captions')).toBe(true);
    const form = requests.find(f => f.data.lines);
    expect(JSON.parse(form.data.lines)).toHaveLength(2);
    expect(form.data.target_language).toBe('zh-Hans');
    expect(result).toMatch(/burn-in: server/);
  });

  it('shows one short message for any streaming failure and tells the model to say only that', async () => {
    const cases = [
      [Object.assign(new Error('Job not found'), { code: 'job_lost' }), "Captions couldn't finish because the service restarted. Nothing was changed. Try again."],
      [new streaming.StreamingCaptionsError('x', { code: 'ranges_failed' }), "Captions couldn't finish. Nothing was changed. Try again."],
      [Object.assign(new Error('x'), { status: 503, code: 'streaming_captions_unavailable' }), "Translated captions aren't available right now. Try again later."],
      [new streaming.StreamingCaptionsError('The connection dropped at 0:34. Captions up to there are kept.', { code: 'declined_continue' }), 'The connection dropped at 0:34. Captions up to there are kept.'],
      [new streaming.StreamingCaptionsError('x', { code: 'audio_too_long' }), "This video's audio is too long for translated captions. Try a clip under 10 minutes."],
    ];
    for (const [error, message] of cases) {
      streaming.runStreamingCaptions.mockRejectedValueOnce(error);
      const { result, messages } = await tool({ target_language: 'zh-Hans' });
      expect(messages.map(m => m.text)).toEqual([message]);
      expect(result).toContain(`"${message}"`);
      expect(JSON.stringify([messages, result])).not.toMatch(/Job not found|Error creating lyric captions|Sorry/);
    }
  });

  it('cancel is not an error message: it is rethrown so the job shows as cancelled', async () => {
    streaming.runStreamingCaptions.mockRejectedValueOnce(Object.assign(new Error('Job cancelled'), { code: 'cancelled' }));
    await expect(tool({ target_language: 'zh-Hans' })).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('routing', () => {
  it('songs (mode "lyrics") keep the upload-based flow with lyric lookup', async () => {
    await tool({ target_language: 'zh-Hans', mode: 'lyrics' });
    expect(streaming.runStreamingCaptions).not.toHaveBeenCalled();
    expect(lyricClient.runLyricCaptionsWeb).toHaveBeenCalledTimes(1);
    expect(consent.mock.calls.some(c => c[0].kind === 'streaming_audio')).toBe(false);
  });

  it('when streaming is not configured (no ELEVENLABS_API_KEY) the older flow runs', async () => {
    streaming.streamingAvailable.mockResolvedValue(false);
    await tool({ target_language: 'zh-Hans' });
    expect(streaming.runStreamingCaptions).not.toHaveBeenCalled();
    expect(lyricClient.runLyricCaptionsWeb).toHaveBeenCalledTimes(1);
  });
});
