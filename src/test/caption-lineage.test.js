// Regression: captioning a video that already had burned captions (e.g. "add captions" then
// "translate them") burned the text a second time, because each tool gets the previous output.
import { describe, it, expect, vi, beforeEach } from 'vitest';
const lyricWeb = vi.hoisted(() => ({ inputs: [] }));
vi.mock('../lyricCaptionsClient.js', () => ({
  describeSong: (song) => (song ? `Song: "${song.title}"` : 'No song identified.'),
  runLyricCaptionsWeb: async (args, bytes) => {
    lyricWeb.inputs.push(bytes);
    return { burned: new Uint8Array(20 + lyricWeb.inputs.length), audioBytes: 44, summary: { translatedCount: 1 }, result: { lines: [{}], language: 'de', targetLanguage: 'zh-Hans', mode: 'lyrics', song: { title: 'T' } } };
  },
}));
import { toolFunctions } from '../toolFunctions.js';
import { noteDerivedVideo, videoHasBurnedCaptions, CAPTIONS_ALREADY_BURNED } from '../captionLineage.js';

const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello world';
const forms = [];

function streamResponse(bytes) {
  let done = false;
  return {
    ok: true,
    body: { getReader: () => ({ read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })) }) },
  };
}

beforeEach(() => {
  forms.length = 0;
  global.URL.createObjectURL = vi.fn(() => 'blob:x');
  global.FormData = class { constructor() { this.data = {}; forms.push(this); } append(k, v) { this.data[k] = v; } };
  global.fetch = vi.fn(async (url) => {
    if (url === '/api/generate-captions') return { ok: true, json: async () => ({ srt, vtt: 'WEBVTT' }) };
    if (url === '/api/translate-captions') return { ok: true, json: async () => ({ srt: srt.replace('Hello world', 'Hola mundo'), vtt: 'WEBVTT' }) };
    if (url === '/api/process-video') return streamResponse(new Uint8Array(10 + forms.length)); // burned output
    throw new Error(`unexpected ${url}`);
  });
});

async function caption(args, input) {
  let output = input;
  const result = await toolFunctions.generate_captions(args, input, (d) => { noteDerivedVideo(input, d); output = d; }, vi.fn());
  return { result, output };
}

describe('generate_captions never burns on top of burned captions', () => {
  it('a second caption call re-burns from the uncaptioned source (replace, not stack)', async () => {
    const original = new Uint8Array([1, 2, 3]);
    const first = await caption({ language: 'en' }, original);
    expect(videoHasBurnedCaptions(first.output)).toBe(true);
    expect(forms[0].data.video.size).toBe(3);

    const second = await caption({ language: 'en', translate_language: 'es' }, first.output);
    expect(second.result).toMatch(/Replaced the captions burned earlier/);
    // The burn uploaded the original 3 bytes, not the already-captioned output.
    expect(forms[1].data.video.size).toBe(3);
    expect(global.fetch.mock.calls[2][0]).toBe('/api/generate-captions');
    expect(global.fetch.mock.calls[2][1].body).toBe(original);

    // Two caption calls in one model response chain the same way.
    const third = await caption({ language: 'en' }, second.output);
    expect(forms[2].data.video.size).toBe(3);
    expect(third.result).toMatch(/Replaced/);
  });

  it('refuses when other edits were applied on top of burned captions', async () => {
    const original = new Uint8Array([4, 5, 6, 7]);
    const { output: captioned } = await caption({}, original);
    const brightened = new Uint8Array([8, 8, 8]);
    noteDerivedVideo(captioned, brightened);
    global.fetch.mockClear();
    const { result } = await caption({}, brightened);
    expect(result).toBe(`Failed to generate captions: ${CAPTIONS_ALREADY_BURNED}`);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uncaptioned videos and their edits caption normally', async () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    noteDerivedVideo(a, b);
    const { result } = await caption({}, b);
    expect(result).toMatch(/with burn-in\.$/);
  });
});

describe('lyric_captions follows the same rule', () => {
  it('re-burns from the uncaptioned source after generate_captions or a previous lyric_captions', async () => {
    const original = new Uint8Array([1, 1, 1]);
    const { output: captioned } = await caption({}, original);
    let out = captioned;
    const set = (d) => { noteDerivedVideo(out, d); out = d; };
    const r1 = await toolFunctions.lyric_captions({ target_language: 'zh-Hans' }, captioned, set, vi.fn());
    expect(lyricWeb.inputs.at(-1)).toBe(original);
    expect(r1).toMatch(/Replaced the captions burned earlier/);
    expect(r1).toMatch(/1 lines, de → zh-Hans/);
    const r2 = await toolFunctions.lyric_captions({ target_language: 'es' }, out, set, vi.fn());
    expect(lyricWeb.inputs.at(-1)).toBe(original);
    expect(r2).toMatch(/Replaced/);
    const edited = new Uint8Array([2]);
    noteDerivedVideo(out, edited);
    const r3 = await toolFunctions.lyric_captions({ target_language: 'es' }, edited, set, vi.fn());
    expect(r3).toContain(CAPTIONS_ALREADY_BURNED);
  });
});
