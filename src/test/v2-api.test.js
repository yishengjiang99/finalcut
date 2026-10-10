// @vitest-environment node
// /api/v2: the web app's in-browser editor routes. They must offer the web toolset, answer
// capability lookups on the server, never accept video, and leave /api/chat (iOS) untouched.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../server/config.js', () => ({
  XAI_API_TOKEN: 'test-token',
  PORT: 3001,
  TMP_DIR: '/tmp',
  IS_PRODUCTION: false,
  OPENAI_API_KEY: null,
  SESSION_SECRET: 'test-secret',
  APP_BASE_URL: null,
  ALLOW_UNAUTH_SAMPLE_MODE: true,
  SAMPLE_TOKEN_TTL_MS: 600000,
  IOS_FREE_DAILY_INFERENCE_LIMIT: 3,
}));

const db = vi.hoisted(() => ({
  enqueueChatInteraction: vi.fn(),
  findUserByApiToken: vi.fn(),
  consumeDailyInference: vi.fn(),
}));
vi.mock('../db.js', () => db);

// The help lookup asks the server's FFmpeg for help text only; here it gets a canned answer.
const helpRuns = vi.hoisted(() => []);
vi.mock('../../server/ffmpeg/ffmpeg-executor.js', () => ({
  FFMPEG_BIN: 'ffmpeg',
  runProcess: async (bin, args) => { helpRuns.push(args); return { stdout: 'Encoders:\n V....D gif   GIF (Graphics Interchange Format)\n', stderr: '', code: 0 }; },
}));

// Guard: no /api/v2 route may process media with ffmpeg on the server.
const ffmpegSpy = vi.hoisted(() => vi.fn());
vi.mock('fluent-ffmpeg', () => {
  const fn = (...a) => { ffmpegSpy(...a); throw new Error('ffmpeg must not run for /api/v2'); };
  fn.ffprobe = (...a) => { ffmpegSpy(...a); };
  fn.getAvailableEncoders = (cb) => cb(null, {});
  return { default: fn };
});

import express from 'express';
import { chatRouter } from '../server/chat.js';
import {
  v2Router, clientFFmpegFlag, searchCapabilities, webToolsFor, isWav,
  RUN_FFMPEG_TOOL_NAME, SEARCH_CAPABILITIES_TOOL_NAME,
} from '../server/v2.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { tools } from '../tools.js';

const realFetch = globalThis.fetch;
const xaiCalls = [];
let xaiResponder = null;
let server;
let base;
let token;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (message) => ({ id: 'cmpl', choices: [{ index: 0, message: { role: 'assistant', ...message } }] });
const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).startsWith('https://api.x.ai/')) {
      const body = JSON.parse(init.body);
      xaiCalls.push(body);
      return xaiResponder(body);
    }
    return realFetch(url, init);
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(chatRouter);
  app.use(v2Router);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  xaiCalls.length = 0;
  xaiResponder = null;
  ffmpegSpy.mockClear();
  token = issueSampleAccessToken();
});

const post = (path, body, headers = { 'sample-access-token': token }) => realFetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('clientFFmpeg feature flag', () => {
  it('defaults to on, and reads off and a percentage', () => {
    expect(clientFFmpegFlag(undefined)).toEqual({ mode: 'on', percent: 100 });
    expect(clientFFmpegFlag('on')).toEqual({ mode: 'on', percent: 100 });
    expect(clientFFmpegFlag('off')).toEqual({ mode: 'off', percent: 0 });
    expect(clientFFmpegFlag('25')).toEqual({ mode: 'percent', percent: 25 });
    expect(clientFFmpegFlag('5%')).toEqual({ mode: 'percent', percent: 5 });
    expect(clientFFmpegFlag('100')).toEqual({ mode: 'on', percent: 100 });
    expect(clientFFmpegFlag('nonsense')).toEqual({ mode: 'on', percent: 100 });
  });

  it('GET /api/v2/config returns the flag and the clip limits without auth', async () => {
    const res = await realFetch(`${base}/api/v2/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clientFFmpeg).toEqual({ mode: 'on', percent: 100 });
    expect(body.limits.clip.desktop).toEqual({ warnBytes: 1024 ** 3, blockBytes: Math.round(1.8 * 1024 ** 3) });
    expect(body.limits.clip.mobile).toEqual({ warnBytes: 300 * 1024 ** 2, blockBytes: 500 * 1024 ** 2 });
    expect(body.captions).toEqual({ onDevice: true, cloud: false });
  });
});

describe('web toolset', () => {
  it('offers every video tool in src/tools.js plus the FFmpeg fallback pair for a video', () => {
    const names = webToolsFor({ mediaType: 'video' }).map(t => t.function.name);
    const videoTools = tools.map(t => t.function.name).filter(n => n !== 'convert_image_format'); // photo-only
    expect(names).toEqual([...videoTools, SEARCH_CAPABILITIES_TOOL_NAME, RUN_FFMPEG_TOOL_NAME]);
    expect(tools).toHaveLength(47);
  });

  it('offers only single-frame tools, and no FFmpeg fallback, for a photo', () => {
    const names = webToolsFor({ mediaType: 'image' }).map(t => t.function.name);
    expect(names).toContain('convert_image_format');
    expect(names).not.toContain('trim_video');
    expect(names).not.toContain(RUN_FFMPEG_TOOL_NAME);
  });
});

describe('FFmpeg help lookup', () => {
  const HELP = {
    '-h': ['Per-file main options:', '-map [-]input_file_id[:stream_specifier]  set input stream mapping', '-disposition        disposition', '-frames number      set the number of frames to output'].join('\n'),
    '-h full': ['-disposition        disposition', 'AVOptions:', '  default      <flags> E..V..A.S...', '  attached_pic <flags> E..V.....S...', '  captions     <flags> E..V..A.S...', 'gif encoder AVOptions:'].join('\n'),
    '-h filter=gblur': 'Filter gblur\n  Apply Gaussian Blur filter.\n  sigma <float> ..FV.....T. set sigma (from 0 to 1024) (default 0.5)',
    '-version': 'ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers',
  };
  const calls = [];
  const run = async (bin, args) => { calls.push(args); return { stdout: HELP[args.slice(1).join(' ')] || '', stderr: 'Unknown filter', code: 0 }; };
  const search = args => searchCapabilities(args, { run, bin: 'ffmpeg' });

  it('greps the help of the server FFmpeg, case-insensitively, and echoes the command', async () => {
    const found = await search({ help: 'ffmpeg -h', pattern: 'THUMB|cover|dispos' });
    expect(calls).toContainEqual(['-hide_banner', '-h']);
    expect(found).toMatchObject({ ok: true, matches: 1, output: '-disposition        disposition', command: "ffmpeg -h | grep -i -E 'THUMB|cover|dispos'", ffmpegVersion: '4.4.2-0ubuntu0.22.04.1' });
  });

  it('prints context lines like grep -A/-B and reads -h full by default', async () => {
    const found = await search({ pattern: '-disposition', after: 3 });
    expect(found.command).toBe("ffmpeg -h full | grep -i -E '-disposition' -A 3");
    expect(found.output.split('\n')).toHaveLength(4);
    expect(found.output).toMatch(/attached_pic/);
    const two = await search({ help: '-h', pattern: 'Per-file|frames', before: 1 });
    expect(two.output.split('\n')).toEqual(['Per-file main options:', '--', '-disposition        disposition', '-frames number      set the number of frames to output']);
  });

  it('reads one filter, says when nothing matched, and still accepts keywords as "query"', async () => {
    expect((await search({ help: '-h filter=gblur' })).output).toMatch(/^Filter gblur/);
    expect(await search({ help: '-h', pattern: 'poster' })).toMatchObject({ ok: true, matches: 0, output: '' });
    const found = await search({ query: 'gif poster' });
    expect(found.matches).toBe(1);
    expect(found.recipes[0].command).toMatch(/output\.gif$/);
  });

  it('runs nothing but help commands, and survives bad patterns', async () => {
    const before = calls.length;
    for (const help of ['-i input -f null -', '-h filter=a;rm', '-version', '-h full | grep x']) expect((await search({ help })).ok).toBe(false);
    expect(calls).toHaveLength(before);
    expect((await search({ help: '-h', pattern: 'input_file_id[' })).matches).toBe(1);
    expect((await search({ help: '-h filter=nope' })).ok).toBe(false);
  });

  it('GET /api/v2/capabilities serves the catalog with recipes and output formats', async () => {
    const res = await realFetch(`${base}/api/v2/capabilities`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.filters)).toBe(true);
    expect(body.recipes.length).toBeGreaterThan(5);
    expect(body.outputFormats).toContain('gif');
  });
});

describe('POST /api/v2/chat', () => {
  it('requires auth', async () => {
    const res = await post('/api/v2/chat', { messages: [{ role: 'user', content: 'hi' }] }, {});
    expect(res.status).toBe(401);
  });

  it('returns tool calls for the browser, offering the web toolset, without running ffmpeg', async () => {
    xaiResponder = () => jsonResponse(completion({ content: null, tool_calls: [toolCall('c1', 'trim_video', { start: 1, end: 3 })] }));
    const res = await post('/api/v2/chat', {
      messages: [{ role: 'user', content: 'trim to 1-3s' }],
      media: { type: 'video', duration: 6, width: 320, height: 240, fps: 25, hasAudio: true },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'tool_calls', toolCalls: [{ id: 'c1', name: 'trim_video', arguments: { start: 1, end: 3 } }] });
    const offered = xaiCalls[0].tools.map(t => t.function.name);
    expect(offered).toContain(RUN_FFMPEG_TOOL_NAME);
    expect(offered).toContain('audio_chorus');
    expect(xaiCalls[0].messages[0].content).toMatch(/run in the user's browser/);
    expect(ffmpegSpy).not.toHaveBeenCalled();
  });

  it('answers search_ffmpeg_capabilities on the server and asks the model again', async () => {
    xaiResponder = () => (xaiCalls.length === 1
      ? jsonResponse(completion({ content: null, tool_calls: [toolCall('s1', SEARCH_CAPABILITIES_TOOL_NAME, { help: '-encoders', pattern: 'gif' })] }))
      : jsonResponse(completion({ content: null, tool_calls: [toolCall('r1', RUN_FFMPEG_TOOL_NAME, { command: 'ffmpeg -i input output.gif' })] })));
    const res = await post('/api/v2/chat', { messages: [{ role: 'user', content: 'make a gif' }], media: { type: 'video', duration: 6 } });
    const body = await res.json();
    expect(body.status).toBe('tool_calls');
    // Only the browser-run call reaches the client; the lookup was resolved here.
    expect(body.toolCalls.map(c => c.name)).toEqual([RUN_FFMPEG_TOOL_NAME]);
    expect(xaiCalls).toHaveLength(2);
    const lookupResult = xaiCalls[1].messages.find(m => m.role === 'tool' && m.tool_call_id === 's1');
    expect(JSON.parse(lookupResult.content)).toMatchObject({ ok: true, matches: 1, command: "ffmpeg -encoders | grep -i -E 'gif'" });
    expect(JSON.parse(lookupResult.content).output).toMatch(/Graphics Interchange Format/);
    expect(helpRuns).toContainEqual(['-hide_banner', '-encoders']);
    expect(helpRuns).toContainEqual(['-hide_banner', '-version']);
    // The conversation handed back includes the lookup exchange, so the next round is consistent.
    expect(body.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('lets the model search several times, then withdraws the lookup', async () => {
    xaiResponder = () => jsonResponse(completion({ content: null, tool_calls: [toolCall(`s${xaiCalls.length}`, SEARCH_CAPABILITIES_TOOL_NAME, { help: '-encoders', pattern: 'gif' })] }));
    const res = await post('/api/v2/chat', { messages: [{ role: 'user', content: 'add a cover image' }], media: { type: 'video', duration: 6 } });
    const body = await res.json();
    expect(xaiCalls).toHaveLength(7);
    expect(xaiCalls[5].tools.map(t => t.function.name)).toContain(SEARCH_CAPABILITIES_TOOL_NAME);
    const last = xaiCalls[6];
    expect(last.tools.map(t => t.function.name)).not.toContain(SEARCH_CAPABILITIES_TOOL_NAME);
    expect(last.tools.map(t => t.function.name)).toContain(RUN_FFMPEG_TOOL_NAME);
    expect(last.messages.at(-1)).toMatchObject({ role: 'system', content: expect.stringMatching(/Lookup limit/) });
    // A seventh search is not answered and nothing is sent to the browser.
    expect(body.status).toBe('final');
  });

  it('gives the final answer after browser tool results', async () => {
    xaiResponder = () => jsonResponse(completion({ content: 'Trimmed to 2 seconds.' }));
    const res = await post('/api/v2/chat', {
      messages: [
        { role: 'user', content: 'trim to 1-3s' },
        { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'trim_video', { start: 1, end: 3 })] },
        { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, executedOn: 'browser', output: { duration: 2, width: 320, height: 240 } }) },
      ],
      media: { type: 'video', duration: 2, width: 320, height: 240 },
    });
    expect(await res.json()).toMatchObject({ status: 'final', message: 'Trimmed to 2 seconds.' });
  });

  it('leaves /api/chat client execution (iOS) on its own toolset', async () => {
    xaiResponder = () => jsonResponse(completion({ content: 'ok' }));
    await post('/api/chat', { execution: 'client', messages: [{ role: 'user', content: 'hi' }], media: { type: 'video' } });
    const offered = xaiCalls[0].tools.map(t => t.function.name);
    expect(offered).not.toContain(RUN_FFMPEG_TOOL_NAME);
    expect(offered).not.toContain(SEARCH_CAPABILITIES_TOOL_NAME);
    expect(xaiCalls[0].messages[0].content).toMatch(/executed on the user's device/);
  });
});

describe('POST /api/v2/transcribe-audio (cloud captions opt-in)', () => {
  const wav = (() => {
    const b = Buffer.alloc(64);
    b.write('RIFF', 0, 'latin1'); b.write('WAVE', 8, 'latin1');
    return b;
  })();
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);

  const upload = (buffer, type) => {
    const form = new FormData();
    form.append('audio', new Blob([buffer], { type }), 'audio.wav');
    return realFetch(`${base}/api/v2/transcribe-audio`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
  };

  it('recognises WAV only', () => {
    expect(isWav(wav)).toBe(true);
    expect(isWav(mp4)).toBe(false);
    expect(isWav(null)).toBe(false);
  });

  it('is unavailable without the cloud key, and never runs ffmpeg', async () => {
    const res = await upload(wav, 'audio/wav');
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('cloud_transcription_unavailable');
    expect(ffmpegSpy).not.toHaveBeenCalled();
  });

  it('requires auth', async () => {
    const form = new FormData();
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    const res = await realFetch(`${base}/api/v2/transcribe-audio`, { method: 'POST', body: form });
    expect(res.status).toBe(401);
  });
});
