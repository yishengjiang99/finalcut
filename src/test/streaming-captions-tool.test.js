// The chat tool on web: a plain "add captions in Chinese" streams to ElevenLabs (no prompt), translates,
// and shows the captions as a live overlay. Nothing is burned until the user exports.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setUploadConsentHandler, setCloudCaptions } from '../engineMode.js';

const engineMock = vi.hoisted(() => ({ burnFails: false, burns: [], muxes: [], muxFails: false, probe: null }));
vi.mock('../wasm/ffmpegEngine.js', async (importOriginal) => {
  const base = await (await import('./helpers/noWasmEngine.js')).noWasmEngine(importOriginal);
  return {
    ...base,
    probeMedia: async (...a) => engineMock.probe || base.probeMedia(...a),
    muxSoftSubtitles: async (opts, bytes) => {
      if (engineMock.muxFails) throw Object.assign(new Error('out of memory'), { code: 'wasm_exec_failed' });
      engineMock.muxes.push({ ...opts, bytes });
      return new Uint8Array([4, 4, bytes.length]);
    },
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
import { toolFunctions, setToolStatusListener, canFallBackToUpload, isRetryable, KEEP_OPEN_HINT, PICKING_UP_HINT, muxCaptionTrack, trackLanguageCode, languageLabel } from '../toolFunctions.js';
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
  engineMock.muxes.length = 0;
  engineMock.muxFails = false;
  engineMock.probe = null;
  consent = vi.fn(async () => true);
  setUploadConsentHandler(consent);
  setCloudCaptions(true); // a stored "cloud captions" opt-in must not skip the ElevenLabs prompt
  global.URL.createObjectURL = vi.fn(() => 'blob:x');
  streaming.streamingAvailable.mockReset().mockResolvedValue(true);
  streaming.runStreamingCaptions.mockReset().mockResolvedValue(streamed);
  lyricClient.runLyricCaptionsWeb.mockClear();
  global.FormData = class { constructor() { this.data = {}; requests.push(this); } append(k, v) { this.data[k] = v; } };
  global.fetch = vi.fn(async (url) => { throw new Error(`unexpected ${url}`); });
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
    expect(result).toMatch(/burned into the video frames in the browser/);
    expect(result).toMatch(/Photos and every player/);
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


describe('export: the captions become a caption track (mov_text, -c copy), in the browser', () => {
  const src = () => new Uint8Array([1, 2, 3]);
  const makeTrack = (bytes, style) => setTrack(bytes, { lines, language: 'en', targetLanguage: 'zh-Hans', style }, { persist: false });
  const logs = () => { const events = []; return { events, clog: { log: (ev, d) => events.push({ ev, ...d }) } }; };
  const probe = (video = 'h264', audio = 'aac') => ({ format: { duration: 10 }, streams: [{ codec_type: 'video', width: 1080, height: 1920, codec_name: video }, ...(audio ? [{ codec_type: 'audio', codec_name: audio }] : [])] });

  it('muxes an SRT with both lines as a track tagged with the target language: nothing burned, nothing uploaded', async () => {
    const bytes = src();
    const { events, clog } = logs();
    engineMock.probe = probe();
    const out = await muxCaptionTrack({ bytes, mime: 'video/mp4', track: makeTrack(bytes), clog });
    expect(out.mime).toBe('video/mp4');
    expect(engineMock.muxes).toHaveLength(1);
    expect(engineMock.muxes[0].language).toBe('zho');
    expect(engineMock.muxes[0].srt).toContain('1\n00:00:00,500 --> 00:00:02,500\nHello my friend\n你好，我的朋友\n');
    expect(engineMock.burns).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(videoHasBurnedCaptions(out.bytes)).toBe(false); // the picture is untouched
    expect(events.map(e => e.ev)).toEqual(['export_start', 'mux_end']);
    expect(events[0]).toMatchObject({ mode: 'soft_track', lines: 2 });
  });

  it('a .mov from an iPhone stays a .mov; a clip with no audio is fine', async () => {
    const bytes = src();
    engineMock.probe = probe('hevc', null);
    const out = await muxCaptionTrack({ bytes, mime: 'video/quicktime', track: makeTrack(bytes), clog: logs().clog });
    expect(out.mime).toBe('video/quicktime');
  });

  it('formats and codecs mp4 cannot hold without re-encoding are refused (the caller saves an SRT), with no burn and no upload', async () => {
    const bytes = src();
    for (const [mime, pr] of [['video/webm', probe('vp9', 'opus')], ['video/mp4', probe('vp9', 'aac')], ['video/mp4', probe('h264', 'opus')]]) {
      engineMock.probe = pr;
      const { events, clog } = logs();
      await expect(muxCaptionTrack({ bytes, mime, track: makeTrack(bytes), clog })).rejects.toMatchObject({ code: 'soft_track_unsupported' });
      expect(events.at(-1).ev).toBe('mux_error');
    }
    expect(engineMock.muxes).toHaveLength(0);
    expect(engineMock.burns).toHaveLength(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a mux failure (for example out of memory) is logged and thrown; there is no server or burn fallback', async () => {
    engineMock.probe = probe();
    engineMock.muxFails = true;
    const bytes = src();
    const { events, clog } = logs();
    await expect(muxCaptionTrack({ bytes, track: makeTrack(bytes), clog })).rejects.toMatchObject({ code: 'wasm_exec_failed' });
    expect(events.at(-1)).toMatchObject({ ev: 'mux_error', code: 'wasm_exec_failed' });
    expect(consent).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('language tags are ISO 639-2, und when unknown', () => {
    expect(trackLanguageCode('zh-Hans')).toBe('zho');
    expect(trackLanguageCode('es')).toBe('spa');
    expect(trackLanguageCode('xx')).toBe('und');
    expect(trackLanguageCode(null)).toBe('und');
  });
});


describe('style the model chose in chat reaches the overlay track', () => {
  it('"caption in Chinese, bottom, large" → bottom, Alignment 2, 1.4x, default font and 20% up', async () => {
    const input = new Uint8Array([5, 5]);
    await tool({ target_language: 'zh-Hans', position: 'bottom', size: 'large' }, input);
    expect(getTrack(input).style).toMatchObject({ alignment: 2, sizeScale: 1.4, font: 'Noto Sans CJK SC', positionFromBottomPct: 20 });
  });
  it('top, xl, Inter, 30% → carried exactly; the tool result names the style', async () => {
    const input = new Uint8Array([6, 6]);
    const { result } = await tool({ target_language: 'zh-Hans', position: 'top', size: 'xl', font: 'Inter', position_from_bottom_pct: 30 }, input);
    expect(getTrack(input).style).toMatchObject({ alignment: 8, sizeScale: 1.8, font: 'Inter', positionFromBottomPct: 30 });
    expect(result).toMatch(/style: Inter, size x1.8, top/);
  });
  it('no style params → the agreed default (Noto Sans CJK SC, 1x, Alignment 2, 20%)', async () => {
    const input = new Uint8Array([7, 7]);
    await tool({ target_language: 'zh-Hans' }, input);
    expect(getTrack(input).style).toMatchObject({ alignment: 2, sizeScale: 1, font: 'Noto Sans CJK SC', positionFromBottomPct: 20 });
  });
  it('invalid values are dropped to the default, never an error', async () => {
    const input = new Uint8Array([8, 8]);
    await tool({ target_language: 'zh-Hans', font: 'Comic Sans', size: 'gigantic', position: 'sideways', position_from_bottom_pct: 999 }, input);
    expect(getTrack(input).style).toMatchObject({ alignment: 2, sizeScale: 1, font: 'Noto Sans CJK SC', positionFromBottomPct: 45 });
  });
  it('font_size in pixels is converted with the video height (1080 px tall: 57 px = 1.4x)', async () => {
    const input = new Uint8Array([9, 9]);
    await tool({ target_language: 'zh-Hans', font_size: 57 }, input);
    expect(getTrack(input).style.sizeScale).toBeCloseTo(1.4, 1);
  });
});
