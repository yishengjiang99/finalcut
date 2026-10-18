// Captioning never changes the video: the lines become the clip's caption track (live overlay, burned in on
// export), so "add captions" then "translate them" replaces the track instead of stacking text.
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { setUploadConsentHandler, setCloudCaptions } from '../engineMode.js';

vi.mock('../wasm/ffmpegEngine.js', async (importOriginal) => (await import('./helpers/noWasmEngine.js')).noWasmEngine(importOriginal));
beforeAll(() => {
  setUploadConsentHandler(() => true);
  setCloudCaptions(true);
});
const lyricWeb = vi.hoisted(() => ({ inputs: [], fail: null }));
vi.mock('../lyricCaptionsClient.js', async (importOriginal) => ({
  ...(await importOriginal()),
  describeSong: (song) => (song ? `Song: "${song.title}"` : 'No song identified.'),
  runLyricCaptionsWeb: async (args, bytes) => {
    if (lyricWeb.fail) throw lyricWeb.fail;
    lyricWeb.inputs.push(bytes);
    return { burned: new Uint8Array(20 + lyricWeb.inputs.length), audioBytes: 44, summary: { translatedCount: 1 }, result: { lines: [{}], language: 'de', targetLanguage: 'zh-Hans', mode: 'lyrics', song: { title: 'T' } } };
  },
}));
import { toolFunctions } from '../toolFunctions.js';
import * as engine from '../wasm/ffmpegEngine.js';
import { noteDerivedVideo, videoHasBurnedCaptions } from '../captionLineage.js';
import { getTrack } from '../captionTrack.js';

const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello world';
const forms = [];
const burnInputs = () => engine.burnSubtitles.mock.calls.map((c) => c[1]);

beforeEach(() => {
  forms.length = 0;
  engine.burnSubtitles.mockClear();
  global.URL.createObjectURL = vi.fn(() => 'blob:x');
  global.FormData = class { constructor() { this.data = {}; forms.push(this); } append(k, v) { this.data[k] = v; } };
  global.fetch = vi.fn(async (url) => {
    if (url === '/api/v2/transcribe-audio') return { ok: true, json: async () => ({ srt, vtt: 'WEBVTT' }) };
    if (url === '/api/translate-captions') return { ok: true, json: async () => ({ srt: srt.replace('Hello world', 'Hola mundo'), vtt: 'WEBVTT' }) };
    throw new Error(`unexpected ${url}`);
  });
});

async function caption(args, input) {
  let output = input;
  const result = await toolFunctions.generate_captions(args, input, (d) => { noteDerivedVideo(input, d); output = d; }, vi.fn());
  return { result, output };
}

describe('generate_captions attaches a caption track to the clip; nothing is burned at caption time', () => {
  it('the video is unchanged, the track is kept for the live overlay and the export, and a second call replaces it (no stacking)', async () => {
    const original = new Uint8Array([1, 2, 3]);
    const first = await caption({ language: 'en' }, original);
    expect(first.output).toBe(original); // no re-encoded video
    expect(engine.burnSubtitles).not.toHaveBeenCalled();
    expect(videoHasBurnedCaptions(first.output)).toBe(false);
    expect(getTrack(original).lines).toEqual([{ start: 0, end: 2, text: 'Hello world', translation: '' }]);
    expect(first.result).toMatch(/burn-in on export/);

    const second = await caption({ language: 'en', translate_language: 'es' }, first.output);
    expect(second.output).toBe(original);
    expect(getTrack(original).lines).toEqual([{ start: 0, end: 2, text: 'Hello world', translation: 'Hola mundo' }]);
    expect(engine.extractSpeechAudio.mock.calls.at(-1)[0]).toBe(original);
  });

  it('an edited clip gets its own track', async () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    noteDerivedVideo(a, b);
    const { result } = await caption({}, b);
    expect(result).toMatch(/Captions generated/);
    expect(getTrack(b).lines).toHaveLength(1);
    expect(getTrack(a)).toBeNull();
  });
});

describe('lyric_captions replaces the same clip\'s track', () => {
  it('uses the uncaptioned bytes every time and keeps the video unchanged', async () => {
    const original = new Uint8Array([1, 1, 1]);
    const { output: captioned } = await caption({}, original);
    expect(captioned).toBe(original);
    const set = vi.fn();
    const r1 = await toolFunctions.lyric_captions({ target_language: 'zh-Hans' }, captioned, set, vi.fn());
    expect(lyricWeb.inputs.at(-1)).toBe(original);
    expect(r1).toMatch(/1 lines, de → zh-Hans/);
    expect(set).not.toHaveBeenCalled();
    const r2 = await toolFunctions.lyric_captions({ target_language: 'es' }, original, set, vi.fn());
    expect(lyricWeb.inputs.at(-1)).toBe(original);
    expect(r2).toMatch(/de → zh-Hans/);
    expect(getTrack(original).targetLanguage).toBe('zh-Hans');
  });
});

describe('lyric_captions failures reach the user as one short message', () => {
  const run = async (error) => {
    lyricWeb.fail = error;
    const addMessage = vi.fn();
    try {
      const result = await toolFunctions.lyric_captions({ target_language: 'zh-Hans' }, new Uint8Array([1]), vi.fn(), addMessage);
      return { result, shown: addMessage.mock.calls.map(c => c[0].text) };
    } finally { lyricWeb.fail = null; }
  };
  const err = (message, extra = {}) => Object.assign(new Error(message), extra);

  it('job missing / poll failed: the Design message, never "Job not found" or "Error creating lyric captions"', async () => {
    for (const e of [err('Job not found', { code: 'job_lost', status: 404 }), err('Job poll failed (500)', { status: 500 }), err('Network error', { code: 'network' }), err('Lyric captions timed out', { code: 'timeout' })]) {
      const { result, shown } = await run(e);
      expect(shown).toEqual(["Captions couldn't finish. Nothing was changed. Try again."]);
      expect(result).toContain('"Captions couldn\'t finish. Nothing was changed. Try again."');
      expect(result).toMatch(/exactly this message and nothing else/);
      expect(JSON.stringify([shown, result])).not.toMatch(/Job not found|Error creating lyric captions|Sorry/);
    }
  });

  it('audio over the limit and unavailable service use their own messages', async () => {
    for (const e of [err('x', { code: 'audio_too_long', status: 413 }), err('x', { code: 'audio_too_large', status: 413 }), err('Lyric captions support up to 10 minutes of audio')]) {
      expect((await run(e)).shown).toEqual(["This video's audio is too long for translated captions. Try a clip under 10 minutes."]);
    }
    for (const e of [err('x', { code: 'lyric_captions_unavailable', status: 503 }), err('x', { status: 503 })]) {
      expect((await run(e)).shown).toEqual(["Translated captions aren't available right now. Try again later."]);
    }
  });

  it('actionable server messages are kept (no speech, no audio track)', async () => {
    expect((await run(err('No singing or speech detected in the audio', { code: 'no_speech' }))).shown).toEqual(['No singing or speech detected in the audio']);
  });
});
