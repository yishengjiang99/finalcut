// @vitest-environment node
// lyric_captions: audio in, captions out. STT, Grok, ffprobe and ffmpeg are mocked (CI has no
// model or API keys); the real-ffmpeg checks at the bottom skip when ffmpeg is missing.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { spawnSync } from 'child_process';
import { promises as fs, readdirSync, existsSync, mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  lyricCaptionsRouter,
  _setLyricCaptionsHooks,
  parseLyricOptions,
  buildLines,
  buildAss,
  assTime,
  escapeAssText,
  fontForLanguages,
  mergeCorrections,
  parseModelJson,
  runLyricCaptions,
  validateAudioUpload,
  summarizeResult,
  LYRIC_AUDIO_MAX_BYTES,
} from '../server/lyricCaptions.js';
import { jobsRouter, JOBS_DIR } from '../server/jobs.js';
import { issueSampleAccessToken, videoProcessLimiter, apiLimiter } from '../server/middleware.js';
import { tools } from '../tools.js';
import { offeredToolsFor, buildToolsSchema } from '../server/toolsSchema.js';
import { IOS_TOOL_ALLOWLIST } from '../server/iosToolAllowlist.js';
import { encodeWavMono16, runLyricCaptionsWeb, describeSong } from '../lyricCaptionsClient.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasAssFilter = hasFfmpeg && /\sass\s+V->V/.test(spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout?.toString() || '');

const TRANSCRIPT = {
  language: 'german',
  segments: [
    { start: 1.0, end: 3.2, text: 'Sieh die Schiebbel an' },
    { start: 4.0, end: 6.0, text: 'und tanz mit mir' },
  ],
  words: [
    { w: 'Sieh', start: 1.2, end: 1.5 }, { w: 'die', start: 1.5, end: 1.7 },
    { w: 'Schiebbel', start: 1.7, end: 2.4 }, { w: 'an', start: 2.4, end: 3.0 },
    { w: 'und', start: 4.1, end: 4.4 }, { w: 'tanz', start: 4.4, end: 4.9 },
    { w: 'mit', start: 4.9, end: 5.2 }, { w: 'mir', start: 5.2, end: 5.8 },
  ],
};
const MODEL_REPLY = {
  mode: 'lyrics',
  language: 'de',
  song: { title: 'Test Song', artist: 'Test Artist', url: 'https://example.com/song', confidence: 'high' },
  lines: [
    { i: 0, text: 'Zieh die Stiefel an', translation: '穿上靴子' },
    { i: 1, text: 'und tanz mit mir', translation: '和我跳舞' },
    { i: 2, text: 'an extra published line that was never sung', translation: 'x' },
  ],
};

describe('options', () => {
  it('defaults and validation', () => {
    const o = parseLyricOptions({ target_language: 'zh-Hans' });
    expect(o).toMatchObject({ targetLanguage: 'zh-Hans', sourceLanguage: 'auto', mode: 'auto', positionFromBottomPct: 20 });
    expect(parseLyricOptions({ target_language: 'Spanish' }).targetLanguage).toBe('es');
    expect(() => parseLyricOptions({})).toThrow(/target_language is required/);
    expect(() => parseLyricOptions({ target_language: 'es', mode: 'karaoke' })).toThrow(/mode/);
    expect(() => parseLyricOptions({ target_language: 'es', position_from_bottom_pct: 80 })).toThrow(/0 to 45/);
    expect(() => parseLyricOptions({ target_language: 'es', width: 720 })).toThrow(/together/);
    expect(parseLyricOptions({ target_language: 'es', width: '720', height: '1280', font_size: '40' })).toMatchObject({ width: 720, height: 1280, fontSize: 40 });
  });
});

describe('lines and ASS', () => {
  it('times lines from the first/last word and keeps segment text', () => {
    const lines = buildLines(TRANSCRIPT);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ start: 1.2, end: 3, text: 'Sieh die Schiebbel an' });
    expect(lines[0].words.map(w => w.w)).toEqual(['Sieh', 'die', 'Schiebbel', 'an']);
    expect(lines[1]).toMatchObject({ start: 4.1, end: 5.8 });
  });

  it('splits long segments and long pauses; joins CJK without spaces; never overlaps', () => {
    const words = 'one two three four five six seven eight nine ten eleven twelve'.split(' ')
      .map((w, i) => ({ w, start: i * 0.5, end: i * 0.5 + 0.4 }));
    const lines = buildLines({ segments: [{ start: 0, end: 6, text: words.map(w => w.w).join(' ') }], words }, { maxChars: 20 });
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(20);
    for (let i = 1; i < lines.length; i++) expect(lines[i].start).toBeGreaterThanOrEqual(lines[i - 1].end);

    const gap = buildLines({ segments: [{ start: 0, end: 5, text: 'a b' }], words: [{ w: 'a', start: 0, end: 0.5 }, { w: 'b', start: 3, end: 3.5 }] });
    expect(gap.map(l => l.text)).toEqual(['a', 'b']);

    const cjk = buildLines({ segments: [{ start: 0, end: 2, text: '你好世界' }], words: [{ w: '你好', start: 0, end: 1 }, { w: '世界', start: 1, end: 2 }] }, { maxChars: 2 });
    expect(cjk.map(l => l.text)).toEqual(['你好', '世界']);
  });

  it('ASS [V4+ Styles] line matches the style spec exactly at 720x1280', () => {
    const ass = buildAss({ lines: [{ start: 0, end: 1, text: 'a', translation: 'b' }], width: 720, height: 1280 });
    const styles = ass.split('[V4+ Styles]')[1].split('[Events]')[0].trim().split('\n');
    expect(styles).toEqual([
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,Noto Sans CJK SC,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,48,48,256,1',
    ]);
    expect(ass).toContain('PlayResX: 720\nPlayResY: 1280\nWrapStyle: 0');
  });

  it('scales the spec to other sizes; one Dialogue per line with original \\N translation', () => {
    const ass = buildAss({
      lines: [{ start: 1.2, end: 3.0, text: 'Zieh die {\\b1}Stiefel an', translation: '穿上靴子' }],
      width: 1080, height: 1920,
    });
    expect(ass).toMatch(/^Style: Default,Noto Sans CJK SC,72,.*,-1,0,0,0,100,100,0,0,1,3,1,2,72,72,384,1$/m);
    expect(ass).toContain('Dialogue: 0,0:00:01.20,0:00:03.00,Default,,0,0,0,,Zieh die (/b1)Stiefel an\\N穿上靴子');
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
    const custom = buildAss({ lines: [{ start: 0, end: 1, text: 'a', translation: '' }], width: 1920, height: 1080, fontSize: 60, positionFromBottomPct: 10 });
    expect(custom).toMatch(/Style: Default,Noto Sans CJK SC,60,.*,128,128,108,1$/m);
    expect(custom).toMatch(/,,a$/m);
  });

  it('breaks lines at sentence ends and clause commas rather than mid-phrase', () => {
    const text = 'Hello my friend. Let us dance tonight, the stars are shining bright';
    const words = text.split(' ').map((w, i) => ({ w, start: i * 0.4, end: i * 0.4 + 0.35 }));
    const lines = buildLines({ segments: [{ start: 0, end: 6, text }], words });
    expect(lines.map(l => l.text)).toEqual(['Hello my friend.', 'Let us dance tonight,', 'the stars are shining bright']);
  });

  it('never draws the same text twice (double-caption regression)', () => {
    // A translation that only repeats the original line is dropped from the event.
    const ass = buildAss({ lines: [{ start: 0, end: 1, text: 'Hallo Welt', translation: 'hallo welt!' }, { start: 1, end: 2, text: 'OK', translation: 'Gut' }], width: 720, height: 1280 });
    expect(ass).toMatch(/,,Hallo Welt$/m);
    expect(ass.split('Hallo Welt').length - 1).toBe(1);
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(2);
    // A transcriber duplicate (same text, overlapping in time) collapses to one line...
    const dup = buildLines({ segments: [{ start: 0, end: 2, text: 'Let it go' }, { start: 0.5, end: 2, text: 'Let it go.' }], words: [] });
    expect(dup.map(l => l.text)).toEqual(['Let it go']);
    // ...but a line really sung twice in a row stays twice.
    const chorus = buildLines({ segments: [{ start: 0, end: 2, text: 'Let it go' }, { start: 2, end: 4, text: 'Let it go' }], words: [] });
    expect(chorus.map(l => l.text)).toEqual(['Let it go', 'Let it go']);
    // Duplicate word entries at the same timestamp are ignored.
    const words = buildLines({ segments: [{ start: 0, end: 1, text: 'hi there' }], words: [{ w: 'hi', start: 0, end: 0.4 }, { w: 'hi', start: 0, end: 0.4 }, { w: 'there', start: 0.4, end: 0.9 }] });
    expect(words[0].words.map(w => w.w)).toEqual(['hi', 'there']);
  });

  it('helpers', () => {
    expect(assTime(3725.456)).toBe('1:02:05.46');
    expect(escapeAssText('a\\Nb {x}\nc')).toBe('a/Nb (x) c');
    for (const langs of [['en', 'zh-Hans'], ['ja', 'en'], ['en', 'zh-Hant'], ['ko']]) expect(fontForLanguages(...langs)).toBe('Noto Sans CJK SC');
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a":2} hope it helps')).toEqual({ a: 2 });
    expect(parseModelJson('nope')).toBeNull();
  });
});

describe('corrections', () => {
  it('keeps transcript lines and timestamps, drops extra model lines, caps confidence without search', () => {
    const lines = buildLines(TRANSCRIPT);
    const m = mergeCorrections(lines, MODEL_REPLY, { usedWebSearch: true });
    expect(m.lines).toHaveLength(2);
    expect(m.lines[0]).toMatchObject({ start: 1.2, end: 3, text: 'Zieh die Stiefel an', translation: '穿上靴子' });
    expect(m.song).toEqual({ title: 'Test Song', artist: 'Test Artist', url: 'https://example.com/song', confidence: 'high', source: 'web_search' });
    const noSearch = mergeCorrections(lines, MODEL_REPLY, { usedWebSearch: false });
    expect(noSearch.song).toMatchObject({ confidence: 'medium', source: 'model_knowledge' });
    expect(noSearch.song.url).toBeUndefined();
    const partial = mergeCorrections(lines, { lines: [{ i: 1, translation: 'y' }], song: null }, { usedWebSearch: false });
    expect(partial.lines[0]).toMatchObject({ text: 'Sieh die Schiebbel an', translation: '' });
    expect(partial).toMatchObject({ song: null, mode: 'speech' });
  });
});

describe('Grok calls (fetch mocked)', () => {
  const realFetch = globalThis.fetch;
  let calls;
  const baseHooks = {
    extractAudioToWav: async (_in, out) => fs.writeFile(out, 'wav'),
    transcribe: async () => TRANSCRIPT,
  };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function audioFile() {
    await fs.mkdir(JOBS_DIR, { recursive: true });
    const p = path.join(JOBS_DIR, `lyric-test-${Date.now()}-${Math.random()}.audio`);
    await fs.writeFile(p, 'audio');
    return p;
  }
  beforeEach(() => { calls = []; _setLyricCaptionsHooks(baseHooks); });
  afterEach(() => { globalThis.fetch = realFetch; _setLyricCaptionsHooks(); });

  it('lyrics/auto: Responses API with web_search, no inline citations; result carries the song', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return reply(200, { output: [{ type: 'web_search_call' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(MODEL_REPLY) }] }] });
    });
    const audioPath = await audioFile();
    const r = await runLyricCaptions({ audioPath, options: parseLyricOptions({ target_language: 'zh-Hans', width: 720, height: 1280 }) });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.x.ai/v1/responses');
    expect(calls[0].body.tools).toEqual([{ type: 'web_search' }]);
    expect(calls[0].body.include).toEqual(['no_inline_citations']);
    expect(calls[0].body.input[1].content).toContain('0 [1.20-3.00] Sieh die Schiebbel an');
    expect(r).toMatchObject({ webSearch: true, language: 'de', targetLanguage: 'zh-Hans', mode: 'lyrics' });
    expect(r.song.source).toBe('web_search');
    expect(r.ass).toContain('Zieh die Stiefel an\\N穿上靴子');
    expect(existsSync(audioPath)).toBe(false); // uploaded audio deleted
    const summary = summarizeResult(r);
    expect(JSON.stringify(summary)).not.toContain('Stiefel'); // chat-safe: no lyric text
  });

  it('falls back to chat completions (model knowledge) when web search fails; speech mode never searches', async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith('/responses')) return reply(400, { error: { message: 'model not found' } });
      return reply(200, { choices: [{ message: { content: JSON.stringify(MODEL_REPLY) } }] });
    });
    const r = await runLyricCaptions({ audioPath: await audioFile(), options: parseLyricOptions({ target_language: 'zh-Hans' }) });
    expect(calls.map(c => c.url)).toEqual(['https://api.x.ai/v1/responses', 'https://api.x.ai/v1/chat/completions']);
    expect(r).toMatchObject({ webSearch: false, song: { source: 'model_knowledge', confidence: 'medium' } });
    expect(r.ass).toBeUndefined(); // no width/height

    calls = [];
    await runLyricCaptions({ audioPath: await audioFile(), options: parseLyricOptions({ target_language: 'en', mode: 'speech' }) });
    expect(calls.map(c => c.url)).toEqual(['https://api.x.ai/v1/chat/completions']);
  });
});

describe('HTTP: POST /api/lyric-captions + jobs + burn', () => {
  let server;
  let base;
  let token;
  let correctCalls;
  let burnCalls;
  let hostTools;
  let hasKeys;
  let transcript;

  const hooks = () => ({
    hasApiKeys: () => hasKeys,
    probeHostTools: async () => hostTools,
    probeMedia: async (p) => {
      const head = (await fs.readFile(p, 'utf8')).slice(0, 12);
      if (head.startsWith('VIDEO')) {
        const rotate = head.includes('ROT');
        return { format: { duration: 8 }, streams: [{ codec_type: 'video', width: 1280, height: 720, side_data_list: rotate ? [{ rotation: -90 }] : [] }, { codec_type: 'audio', codec_name: 'aac' }] };
      }
      if (head.startsWith('LONG')) return { format: { duration: 601 }, streams: [{ codec_type: 'audio' }] };
      if (head.startsWith('SILENT')) return { format: { duration: 5 }, streams: [] };
      return { format: { duration: 8 }, streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le' }] };
    },
    extractAudioToWav: async (_in, out) => fs.writeFile(out, 'wav'),
    transcribe: async () => transcript,
    correct: async (args) => { correctCalls.push(args); return { parsed: MODEL_REPLY, usedWebSearch: true, model: 'grok-test' }; },
    burnAss: async ({ assPath, outputPath, copyAudio }) => {
      burnCalls.push({ ass: await fs.readFile(assPath, 'utf8'), copyAudio });
      await fs.writeFile(outputPath, 'BURNED');
    },
  });

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(jobsRouter);
    app.use(lyricCaptionsRouter);
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    _setLyricCaptionsHooks();
    await new Promise((r) => server.close(r));
  });
  beforeEach(async () => {
    // Every request here comes from 127.0.0.1; start each test with fresh rate-limit budgets.
    for (const limiter of [videoProcessLimiter, apiLimiter]) {
      for (const key of ['127.0.0.1', '::ffff:127.0.0.1']) await limiter.resetKey(key);
    }
    token = issueSampleAccessToken();
    correctCalls = [];
    burnCalls = [];
    hasKeys = true;
    transcript = TRANSCRIPT;
    hostTools = { ffmpeg: true, ffprobe: true, assFilter: true, fontFamilies: new Set(['Noto Sans CJK SC']) };
    _setLyricCaptionsHooks(hooks());
  });

  const post = (fields, file = 'RIFFaudio', name = 'audio.wav') => {
    const form = new FormData();
    if (file != null) form.append('audio', new Blob([file]), name);
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    return fetch(`${base}/api/lyric-captions`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
  };
  const get = (p) => fetch(`${base}${p}`, { headers: { 'sample-access-token': token } });
  async function waitJob(jobId) {
    for (let i = 0; i < 100; i++) {
      const body = await (await get(`/api/jobs/${jobId}`)).json();
      if (body.status === 'succeeded' || body.status === 'failed') return body;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('job did not finish');
  }

  it('202 → poll (song summary, no lyrics) → result JSON with lines, translations and ASS; audio deleted', async () => {
    const res = await post({ target_language: 'zh-Hans', width: 720, height: 1280 });
    expect(res.status).toBe(202);
    const started = await res.json();
    expect(started).toMatchObject({ status: 'queued', operation: 'lyric_captions', durationSec: 8 });
    expect(started.pollUrl).toMatch(/\/api\/jobs\//);
    const job = await waitJob(started.jobId);
    expect(job).toMatchObject({ status: 'succeeded', operation: 'lyric_captions', mediaType: 'audio', contentType: 'application/json' });
    expect(job.summary).toMatchObject({ song: { title: 'Test Song', artist: 'Test Artist' }, lineCount: 2, translatedCount: 2 });
    expect(JSON.stringify(job)).not.toContain('Stiefel');
    const result = await (await get(`/api/jobs/${started.jobId}/result`)).json();
    expect(result.lines).toEqual([
      { start: 1.2, end: 3, text: 'Zieh die Stiefel an', translation: '穿上靴子', words: expect.any(Array) },
      { start: 4.1, end: 5.8, text: 'und tanz mit mir', translation: '和我跳舞', words: expect.any(Array) },
    ]);
    expect(result.lines[0].words[0]).toEqual({ w: 'Sieh', start: 1.2, end: 1.5 });
    expect(result.ass).toContain('PlayResY: 1280');
    expect(result.style).toMatchObject({ fontName: 'Noto Sans CJK SC', fontSize: 48, alignment: 2, marginV: 256, marginLR: 48, outline: 3, shadow: 1 });
    expect(correctCalls[0]).toMatchObject({ targetLanguage: 'zh-Hans', sourceLanguage: 'auto', mode: 'auto' });
    const leftovers = readdirSync(JOBS_DIR).filter(f => f.startsWith('lyric-') && !f.startsWith('lyric-test-'));
    expect(leftovers).toEqual([]);
  });

  it('503 lyric_captions_unavailable when API keys or ffmpeg are missing', async () => {
    hasKeys = false;
    let res = await post({ target_language: 'es' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'lyric_captions_unavailable', error: expect.stringMatching(/OPENAI_API_KEY/) });
    hasKeys = true;
    hostTools = { ...hostTools, ffprobe: false };
    _setLyricCaptionsHooks(hooks());
    res = await post({ target_language: 'es' });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/ffprobe/);
  });

  it('rejects bad requests with codes', async () => {
    expect((await post({})).status).toBe(400);
    expect((await (await post({ target_language: 'es' }, null)).json()).error).toMatch(/audio/);
    let res = await post({ target_language: 'es' }, 'VIDEO data', 'clip.mp4');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('audio_only');
    res = await post({ target_language: 'es' }, 'LONG audio');
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('audio_too_long');
    res = await post({ target_language: 'es' }, 'SILENT');
    expect((await res.json()).code).toBe('no_audio');
    res = await post({ target_language: 'es' }, new Uint8Array(LYRIC_AUDIO_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe('audio_too_large');
  });

  it('job fails with no_speech when nothing was transcribed', async () => {
    transcript = { language: 'en', segments: [], words: [] };
    const started = await (await post({ target_language: 'es' })).json();
    const job = await waitJob(started.jobId);
    expect(job).toMatchObject({ status: 'failed', code: 'no_speech' });
    expect((await get(`/api/jobs/${started.jobId}/result`)).status).toBe(404);
  });

  it('burn fallback: ASS sized to the uploaded (rotated) video; 503 without libass; 404 unknown job', async () => {
    const started = await (await post({ target_language: 'zh-Hans', position_from_bottom_pct: 25 })).json();
    await waitJob(started.jobId);
    const burn = (content, args) => {
      const form = new FormData();
      form.append('video', new Blob([content], { type: 'video/mp4' }), 'in.mp4');
      if (args) form.append('args', JSON.stringify(args));
      return fetch(`${base}/api/lyric-captions/${started.jobId}/burn`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
    };
    let res = await burn('VIDEO ROT');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('x-lyric-captions-burn')).toBe('server');
    expect(await res.text()).toBe('BURNED');
    expect(burnCalls[0].ass).toContain('PlayResX: 720\nPlayResY: 1280'); // rotated portrait
    expect(burnCalls[0].ass).toMatch(/,2,48,48,320,1$/m); // 25% of 1280
    expect(burnCalls[0].copyAudio).toBe(true);

    res = await burn('VIDEO', { position_from_bottom_pct: 10 });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(burnCalls[1].ass).toContain('PlayResX: 1280\nPlayResY: 720');
    expect(burnCalls[1].ass).toMatch(/,72,1$/m);

    hostTools = { ...hostTools, assFilter: false };
    _setLyricCaptionsHooks(hooks());
    res = await burn('VIDEO');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/libass/);

    hostTools = { ...hostTools, assFilter: true, fontFamilies: new Set() };
    _setLyricCaptionsHooks(hooks());
    res = await burn('VIDEO');
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/fonts-noto-cjk/);

    const form = new FormData();
    form.append('video', new Blob(['VIDEO']), 'in.mp4');
    res = await fetch(`${base}/api/lyric-captions/nope/burn`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
    expect(res.status).toBe(404);
  });
});

describe('tool schema and clients', () => {
  it('web gets lyric_captions (video only, target_language required); iOS does not', () => {
    const def = tools.find(t => t.function.name === 'lyric_captions');
    expect(def.function.parameters.required).toEqual(['target_language']);
    expect(Object.keys(def.function.parameters.properties)).toEqual(['target_language', 'source_language', 'mode', 'position_from_bottom_pct', 'font_size']);
    expect(buildToolsSchema().mediaTypes.lyric_captions).toEqual(['video']);
    expect(offeredToolsFor({ mediaType: 'image' }).map(t => t.function.name)).not.toContain('lyric_captions');
    expect(IOS_TOOL_ALLOWLIST.lyric_captions).toBeUndefined();
    for (const build of [10, 11, 999]) {
      expect(offeredToolsFor({ userAgent: `FinalCap-iOS/${build}` }).map(t => t.function.name)).not.toContain('lyric_captions');
    }
  });

  it('WAV encoder writes a 16 kHz mono PCM header', () => {
    const wav = encodeWavMono16(new Float32Array([0, 1, -1]), 16000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(46, true)).toBe(32767);
  });

  it('web flow uploads only audio for transcription, then uses the server burn fallback', async () => {
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      seen.push({ url: String(url), fields: init.body instanceof FormData ? [...init.body.keys()] : [] });
      if (url === '/api/lyric-captions') return new Response(JSON.stringify({ jobId: 'j1', pollUrl: '/api/jobs/j1', resultUrl: '/api/jobs/j1/result' }), { status: 202 });
      if (url === '/api/jobs/j1/result') return new Response(JSON.stringify({ lines: [{ text: 'a' }], song: null, targetLanguage: 'es' }));
      if (url === '/api/lyric-captions/j1/burn') return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(`unexpected ${url}`);
    });
    try {
      const out = await runLyricCaptionsWeb({ target_language: 'es', mode: 'speech' }, new Uint8Array(1000), {
        extract: async () => new Uint8Array(44),
        poll: async () => ({ status: 'succeeded', summary: { lineCount: 1 } }),
      });
      expect(seen[0]).toEqual({ url: '/api/lyric-captions', fields: ['audio', 'target_language', 'mode'] });
      expect(seen[2]).toEqual({ url: '/api/lyric-captions/j1/burn', fields: ['video'] });
      expect([...out.burned]).toEqual([1, 2, 3]);
      expect(out.audioBytes).toBe(44);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(describeSong({ title: 'T', artist: 'A', confidence: 'high', source: 'web_search', url: 'https://x.test/' })).toBe('Song: "T" by A (high confidence, verified with web search) https://x.test/.');
  });
});

describe('real ffmpeg', () => {
  let dir;
  beforeAll(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'lyric-')); });
  afterAll(() => fs.rm(dir, { recursive: true, force: true }));

  it.skipIf(!hasFfmpeg)('ffprobe validation: audio passes with a duration, a video file is refused', async () => {
    _setLyricCaptionsHooks();
    const wav = path.join(dir, 'a.wav');
    const mp4 = path.join(dir, 'v.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', '-ar', '16000', '-ac', '1', wav]);
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=64x64:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', mp4]);
    expect(await validateAudioUpload(wav)).toBeCloseTo(1, 1);
    await expect(validateAudioUpload(mp4)).rejects.toMatchObject({ code: 'audio_only' });
  });

  it.skipIf(!hasAssFilter)('the generated ASS burns with the ass filter', async () => {
    const { default: ffmpeg } = await import('fluent-ffmpeg');
    const mp4 = path.join(dir, 'in.mp4');
    const assPath = path.join(dir, 'c.ass');
    const out = path.join(dir, 'out.mp4');
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=320x240:d=1', '-c:v', 'libx264', mp4]);
    await fs.writeFile(assPath, buildAss({ lines: [{ start: 0, end: 1, text: 'hello', translation: '你好' }], width: 320, height: 240 }));
    await new Promise((resolve, reject) => ffmpeg(mp4).videoFilters(`ass='${assPath}'`).outputOptions(['-c:v libx264']).on('end', resolve).on('error', reject).save(out));
    expect((await fs.stat(out)).size).toBeGreaterThan(0);
  });
});
