// The chat tool on web: a plain "add captions in Chinese" streams to ElevenLabs (no prompt), translates,
// and shows the captions as a live overlay. Nothing is burned until the user exports.
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
import { toolFunctions, setToolStatusListener, canFallBackToUpload, isRetryable, KEEP_OPEN_HINT, PICKING_UP_HINT, burnCaptionTrack, chooseBurnRoute, languageLabel } from '../toolFunctions.js';
import { getTrack, setTrack } from '../captionTrack.js';
import * as streaming from '../streamingCaptions.js';
import * as lyricClient from '../lyricCaptionsClient.js';
import { noteDerivedVideo, videoHasBurnedCaptions, recordCaptionBurn } from '../captionLineage.js';

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
  it('starts at once: no "Send the audio to ElevenLabs?" prompt, nothing asked before streaming', async () => {
    await tool({ target_language: 'zh-Hans' });
    expect(consent.mock.calls.map(c => c[0]).filter(r => r.kind === 'streaming_audio' || r.provider === 'elevenlabs')).toHaveLength(0);
    expect(consent).not.toHaveBeenCalled();
    expect(streaming.runStreamingCaptions).toHaveBeenCalledTimes(1);
  });

  it('streams and translates, then attaches a live overlay track: nothing is burned and the video is untouched', async () => {
    const input = new Uint8Array([1, 2, 3]);
    const { result, messages, output } = await tool({ target_language: 'zh-Hans' }, input);
    expect(streaming.runStreamingCaptions).toHaveBeenCalledTimes(1);
    expect(streaming.runStreamingCaptions.mock.calls[0][0]).toMatchObject({ target_language: 'zh-Hans' });
    expect(engineMock.burns).toHaveLength(0);
    expect(output).toBe(input); // no new bytes: no re-encode at caption time
    expect(videoHasBurnedCaptions(output)).toBe(false);
    const captionTrack = getTrack(input);
    expect(captionTrack.lines).toHaveLength(2);
    expect(captionTrack.lines[0]).toMatchObject({ start: 0.5, end: 2.5, text: 'Hello my friend', translation: '你好，我的朋友' });
    expect(captionTrack.style).toMatchObject({ positionFromBottomPct: 20, sizeScale: 1 }); // the agreed style is the default
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: 'Captions · English → Chinese', captions: { bytes: input, lines: 2 } });
    expect(result).toMatch(/streamed/);
    expect(result).toMatch(/NOT burned into the video yet/);
    expect(result).toMatch(/ElevenLabs may keep it, so do not tell the user it was deleted/);
    expect(lyricClient.runLyricCaptionsWeb).not.toHaveBeenCalled();
  });

  it('percent reaches 100 when the lines are ready (there is no burn step in the caption flow)', async () => {
    const seen = [];
    setToolStatusListener((st) => seen.push(st));
    try { await tool({ target_language: 'zh-Hans' }); } finally { setToolStatusListener(null); }
    expect(seen.at(-1)).toMatchObject({ text: 'Captions ready', progress: 1 });
    expect(seen.some(st => /Burning/.test(st.text))).toBe(false);
  });

  it('captioning a clip that already has burned-in captions puts the overlay on the uncaptioned source (no double text)', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const burnedOutput = new Uint8Array([9, 9]);
    recordCaptionBurn(source, burnedOutput);
    const { result, messages } = await tool({ target_language: 'zh-Hans' }, burnedOutput);
    expect(getTrack(source)).not.toBeNull();
    expect(getTrack(burnedOutput)).toBeNull();
    expect(messages[0].captions.bytes).toBe(source);
    expect(result).toMatch(/replace the captions burned earlier/);
    expect(engineMock.burns).toHaveLength(0);
  });

  it('language labels', () => {
    expect(languageLabel('en')).toBe('English');
    expect(languageLabel('zh-Hans')).toBe('Chinese');
    expect(languageLabel('zh-Hant')).toBe('Chinese (Traditional)');
    expect(languageLabel('auto')).toBe('Original');
    expect(languageLabel('xx')).toBe('xx');
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


describe('streaming that cannot start, retry, and the on-screen hints', () => {
  it('falls back to the upload-based flow (which asks before uploading) when no streaming session was ever accepted', async () => {
    streaming.runStreamingCaptions.mockRejectedValue(new streaming.StreamingCaptionsError("Captions couldn't finish. Nothing was changed. Try again.", { code: 'ranges_failed', neverStarted: true }));
    const { result, messages } = await tool({ target_language: 'zh-Hans' });
    expect(lyricClient.runLyricCaptionsWeb).toHaveBeenCalledTimes(1);
    expect(messages.some(m => /couldn't finish/.test(m.text || ''))).toBe(false);
    expect(result).not.toMatch(/^Failed/);
  });

  it('a failure after streaming started does not fall back: one message with a Retry offer', async () => {
    streaming.runStreamingCaptions.mockRejectedValue(new streaming.StreamingCaptionsError('x', { code: 'ranges_failed', neverStarted: false }));
    const { messages } = await tool({ target_language: 'zh-Hans' });
    expect(lyricClient.runLyricCaptionsWeb).not.toHaveBeenCalled();
    expect(messages).toEqual([{ text: "Captions couldn't finish. Nothing was changed. Try again.", retry: true }]);
  });

  it('the stalled error says so, with Retry; declining Continue and "too long" offer no Retry', async () => {
    streaming.runStreamingCaptions.mockRejectedValue(new streaming.StreamingCaptionsError('x', { code: 'stalled', neverStarted: false }));
    const stalled = await tool({ target_language: 'zh-Hans' });
    expect(stalled.messages).toEqual([{ text: 'Captions stopped making progress. Nothing was changed. Try again.', retry: true }]);
    expect(isRetryable({ code: 'declined_continue' })).toBe(false);
    expect(isRetryable({ code: 'audio_too_long' })).toBe(false);
    expect(isRetryable({ code: 'ranges_failed' })).toBe(true);
    expect(canFallBackToUpload({ code: 'stalled', neverStarted: true })).toBe(true);
    expect(canFallBackToUpload({ code: 'stalled', neverStarted: false })).toBe(false);
    expect(canFallBackToUpload({ code: 'cancelled', neverStarted: true })).toBe(false);
    expect(canFallBackToUpload({ status: 429, neverStarted: true })).toBe(false);
  });

  it('shows "Keep this tab open…" on a phone while streaming, and "Picking up where we left off…" after the tab was away', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari' });
    const seen = [];
    setToolStatusListener((s) => seen.push(s));
    streaming.runStreamingCaptions.mockImplementation(async (args, wav, deps) => {
      deps.onProgress({ percent: 12, text: 'Listening…', pickingUp: false });
      deps.onProgress({ percent: 30, text: 'Listening…', pickingUp: true });
      return streamed;
    });
    try {
      await tool({ target_language: 'zh-Hans' });
    } finally { setToolStatusListener(null); vi.unstubAllGlobals(); }
    expect(seen.find(s => s.text === 'Listening… 12%')).toMatchObject({ progress: 0.12, hint: KEEP_OPEN_HINT });
    expect(seen.find(s => s.text === 'Listening… 30%')).toMatchObject({ hint: PICKING_UP_HINT });
    expect(KEEP_OPEN_HINT).toBe('Keep this tab open until captions finish');
    expect(PICKING_UP_HINT).toBe('Picking up where we left off…');
  });
});


describe('export: burning the overlay in (the only re-encode)', () => {
  const src = () => new Uint8Array([1, 2, 3]);
  const makeTrack = (bytes, style) => setTrack(bytes, { lines, language: 'en', targetLanguage: 'zh-Hans', style }, { persist: false });
  const logs = () => { const events = []; return { events, clog: { log: (ev, d) => events.push({ ev, ...d }) } }; };

  it('burns in the browser with the track style (position and size carried into the ASS)', async () => {
    const bytes = src();
    const t = makeTrack(bytes, { positionFromBottomPct: 30, sizeScale: 1.4 });
    const { events, clog } = logs();
    const out = await burnCaptionTrack({ bytes, track: t, clog });
    expect(out.on).toBe('browser');
    const ass = engineMock.burns[0].ass;
    expect(ass).toContain('PlayResX: 1920');
    expect(ass).toMatch(/Style: Default,[^,]+,57,/); // 1080 × 48/1280 × 1.4 ≈ 57
    expect(ass).toMatch(/,-1,0,0,0,100,100,0,0,1,3,1,2,\d+,\d+,324,1/); // MarginV 30% of 1080
    expect(ass.split('\n').filter(l => l.startsWith('Dialogue:'))).toHaveLength(2);
    expect(videoHasBurnedCaptions(out.bytes)).toBe(true); // lineage: export never double-burns
    expect(events.map(e => e.ev)).toEqual(expect.arrayContaining(['export_start', 'burn_start', 'burn_progress', 'burn_end']));
    expect(events.find(e => e.ev === 'export_start')).toMatchObject({ route: 'browser', lines: 2 });
  });

  it('refuses to burn onto a clip that already carries burned captions', async () => {
    const bytes = src();
    const out = new Uint8Array([8]);
    recordCaptionBurn(bytes, out);
    await expect(burnCaptionTrack({ bytes: out, track: makeTrack(out), clog: logs().clog })).rejects.toMatchObject({ code: 'captions_already_burned' });
    expect(engineMock.burns).toHaveLength(0);
  });

  it('when the browser cannot burn, asks before uploading and burns on the server with the style args', async () => {
    engineMock.burnFails = true;
    const bytes = src();
    const t = makeTrack(bytes, { positionFromBottomPct: 10, sizeScale: 1 });
    const out = await burnCaptionTrack({ bytes, track: t, clog: logs().clog });
    expect(consent.mock.calls.some(c => c[0].uploads === 'video')).toBe(true);
    const form = requests.find(f => f.data.lines);
    expect(JSON.parse(form.data.args)).toEqual({ position_from_bottom_pct: 10, font_size: 41 });
    expect(out.on).toBe('server');
  });

  it('logs burn_error with an ASCII-only ffmpeg tail when the burn fails and the upload is declined', async () => {
    engineMock.burnFails = true;
    consent.mockResolvedValue(false);
    const bytes = src();
    const { events, clog } = logs();
    await expect(burnCaptionTrack({ bytes, track: makeTrack(bytes), clog })).rejects.toMatchObject({ name: 'UploadDeclinedError' });
    expect(events.find(e => e.ev === 'burn_error')).toMatchObject({ name: 'UploadDeclinedError' });
  });

  it('an iPhone with a big or HD clip goes to the server route (after consent); decline uploads nothing', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari', platform: 'iPhone', maxTouchPoints: 5 });
    try {
      const bytes = src();
      const t = makeTrack(bytes);
      const { events, clog } = logs();
      consent.mockResolvedValue(false);
      await expect(burnCaptionTrack({ bytes, track: t, clog })).rejects.toMatchObject({ name: 'UploadDeclinedError' });
      expect(engineMock.burns).toHaveLength(0);
      expect(requests.find(f => f.data.lines)).toBeUndefined();
      expect(events.find(e => e.ev === 'export_start')).toMatchObject({ route: 'server', ios: true });
      consent.mockResolvedValue(true);
      const out = await burnCaptionTrack({ bytes, track: t, clog });
      expect(out.on).toBe('server');
      expect(engineMock.burns).toHaveLength(0); // never ran ffmpeg.wasm on the phone
    } finally { vi.unstubAllGlobals(); }
  });

  it('route choice: only iOS is limited (over 20 MB or short side over 720 px)', () => {
    const MB = 1024 * 1024;
    expect(chooseBurnRoute({ ios: false, bytes: 500 * MB, width: 3840, height: 2160 })).toBe('browser');
    expect(chooseBurnRoute({ ios: true, bytes: 5 * MB, width: 1280, height: 720 })).toBe('browser');
    expect(chooseBurnRoute({ ios: true, bytes: 5 * MB, width: 720, height: 1280 })).toBe('browser');
    expect(chooseBurnRoute({ ios: true, bytes: 21 * MB, width: 720, height: 1280 })).toBe('server');
    expect(chooseBurnRoute({ ios: true, bytes: 5 * MB, width: 1080, height: 1920 })).toBe('server');
  });
});
