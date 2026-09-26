// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  saveLesson: vi.fn().mockResolvedValue(undefined),
  enqueueChatInteraction: vi.fn(),
  findUserByApiToken: vi.fn(),
  consumeDailyInference: vi.fn(),
}));
vi.mock('../db.js', () => db);

// Guard: client mode must never touch ffmpeg.
const ffmpegSpy = vi.hoisted(() => vi.fn());
vi.mock('fluent-ffmpeg', () => {
  const fn = (...a) => { ffmpegSpy(...a); throw new Error('ffmpeg must not run in client mode'); };
  fn.ffprobe = (...a) => { ffmpegSpy(...a); };
  fn.getAvailableEncoders = (cb) => cb(null, {});
  return { default: fn };
});

import express from 'express';
import { chatRouter, restrictStreamingBodyForIos } from '../server/chat.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { buildToolsSchema } from '../server/toolsSchema.js';
import { tools } from '../tools.js';
import {
  annotateToolResult,
  isUnsupportedOnDevice,
  normalizeClientMessages,
  unsupportedToolsInTurn,
} from '../server/clientExecution.js';
import { toolsForMediaType } from '../server/toolsSchema.js';
import {
  IOS_TOOL_ALLOWLIST,
  filterToolsForUserAgent,
  iosBuildRange,
  isToolAllowedForIosBuild,
  parseFinalCapIosUserAgent,
} from '../server/iosToolAllowlist.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch;
const xaiCalls = [];
let xaiResponder = null;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function completion(message) {
  return { id: 'cmpl', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] };
}

let server;
let base;
let token;

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
  db.consumeDailyInference.mockReset();
  db.findUserByApiToken.mockReset();
  token = issueSampleAccessToken();
});

function postChat(body, headers = { 'sample-access-token': token }) {
  return realFetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}


const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const OLD_IOS_UA = 'FinalCap/9 CFNetwork/1498.700.2 Darwin/23.6.0'; // default URLSession UA (build 9)
const ios = (build) => `FinalCap-iOS/${build}`;
const names = (list) => list.map(t => t.function.name);
// Build 10's allowlist (the grouped effect tools are gated separately; see ios-grouped-tools.test.js).
const allowlisted = Object.keys(IOS_TOOL_ALLOWLIST).filter(n => isToolAllowedForIosBuild(n, 10));

function chatAs(ua, body) {
  return postChat(body, { 'sample-access-token': token, 'User-Agent': ua });
}

describe('User-Agent parsing', () => {
  it('reads the build from FinalCap-iOS/<build>', () => {
    expect(parseFinalCapIosUserAgent('FinalCap-iOS/10')).toEqual({ isFinalCapIos: true, build: 10 });
    expect(parseFinalCapIosUserAgent('FinalCap-iOS/123 (iPhone; iOS 18.1)')).toEqual({ isFinalCapIos: true, build: 123 });
    expect(parseFinalCapIosUserAgent('FinalCap-iOS/10.2')).toEqual({ isFinalCapIos: true, build: 10 });
  });

  it('treats a FinalCap-iOS UA with a missing/unparseable build as build null', () => {
    for (const ua of ['FinalCap-iOS', 'FinalCap-iOS/', 'FinalCap-iOS/abc', 'FinalCap-iOS (iPhone)', 'FinalCap-iOS/ 10']) {
      expect(parseFinalCapIosUserAgent(ua)).toEqual({ isFinalCapIos: true, build: null });
    }
  });

  it('does not match web, old iOS builds, or other clients', () => {
    for (const ua of [WEB_UA, OLD_IOS_UA, 'node', '', undefined, null, 'curl/8.5', 'finalcap-ios/10', 'X FinalCap-iOS/10']) {
      expect(parseFinalCapIosUserAgent(ua)).toEqual({ isFinalCapIos: false, build: null });
    }
  });
});

describe('allowlist thresholds', () => {
  const list = { a: 10, b: 12 };
  const defs = [{ function: { name: 'a' } }, { function: { name: 'b' } }, { function: { name: 'c' } }];

  it('offers a tool only when listed and build >= minBuild', () => {
    expect(names(filterToolsForUserAgent(defs, ios(9), list))).toEqual([]);
    expect(names(filterToolsForUserAgent(defs, ios(10), list))).toEqual(['a']);
    expect(names(filterToolsForUserAgent(defs, ios(11), list))).toEqual(['a']);
    expect(names(filterToolsForUserAgent(defs, ios(12), list))).toEqual(['a', 'b']);
    expect(names(filterToolsForUserAgent(defs, ios(999), list))).toEqual(['a', 'b']); // c is never listed
  });

  it('a missing build gets no tools (never all tools)', () => {
    expect(filterToolsForUserAgent(defs, 'FinalCap-iOS', list)).toEqual([]);
    expect(filterToolsForUserAgent(defs, 'FinalCap-iOS/xyz', list)).toEqual([]);
    expect(isToolAllowedForIosBuild('a', null, list)).toBe(false);
    expect(isToolAllowedForIosBuild('toString', 99, list)).toBe(false); // no prototype keys
  });

  it('web and other UAs get the same array back untouched', () => {
    expect(filterToolsForUserAgent(tools, WEB_UA)).toBe(tools);
    expect(filterToolsForUserAgent(tools, OLD_IOS_UA)).toBe(tools);
    expect(filterToolsForUserAgent(tools, undefined)).toBe(tools);
    expect(tools).toHaveLength(46);
  });

  it('seed: the "iOS allowlist (build 10)" block in docs/ios/native-tools.md + generate_captions, at minBuild 10', () => {
    const doc = readFileSync(path.join(here, '..', '..', 'docs', 'ios', 'native-tools.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## iOS allowlist (build 10)'));
    const block = section.slice(section.indexOf('```') + 3, section.indexOf('```', section.indexOf('```') + 3));
    const documented = block.split('\n').map(l => l.trim()).filter(Boolean);
    expect(documented).toHaveLength(20);
    expect([...allowlisted].sort()).toEqual([...documented, 'generate_captions'].sort());
    expect(allowlisted).toHaveLength(21);
    for (const serverOnly of ['translate_captions', 'burn_subtitles']) expect(allowlisted).not.toContain(serverOnly);
    for (const name of allowlisted) {
      expect(names(tools)).toContain(name);
      expect(iosBuildRange(IOS_TOOL_ALLOWLIST[name]).minBuild).toBe(10);
    }
    expect(Object.isFrozen(IOS_TOOL_ALLOWLIST)).toBe(true);
  });

  it('narrows device-limited arguments on copies, never on the shared (web) definitions', () => {
    const filtered = filterToolsForUserAgent(tools, ios(10));
    const byName = Object.fromEntries(filtered.map(t => [t.function.name, t.function.parameters.properties]));
    expect(byName.convert_video_format.format.enum).toEqual(['mp4', 'mov']);
    expect(byName.convert_image_format.format.enum).toEqual(['jpg', 'png']);
    expect(byName.adjust_speed.speed).toMatchObject({ type: 'number', minimum: 0.25, maximum: 4 });
    const shared = Object.fromEntries(tools.map(t => [t.function.name, t.function.parameters.properties]));
    expect(shared.convert_video_format.format.enum).toEqual(['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv']);
    expect(shared.convert_image_format.format.enum).toEqual(['jpg', 'png', 'webp']);
    expect(shared.adjust_speed.speed.minimum).toBeUndefined();
    // generate_captions: translation removed, server/FFmpeg wording replaced; web copy intact.
    const iosCaptions = filtered.find(t => t.function.name === 'generate_captions').function;
    expect(Object.keys(iosCaptions.parameters.properties)).toEqual(['language', 'style', 'position', 'burn_in']);
    expect(iosCaptions.parameters.required).toEqual([]);
    expect(JSON.stringify(iosCaptions)).not.toMatch(/translat(e|ion)_language|OpenAI|Grok|FFmpeg|server/);
    expect(iosCaptions.description).toMatch(/on-device speech recognition/);
    const web = tools.find(t => t.function.name === 'generate_captions').function;
    expect(Object.keys(web.parameters.properties)).toEqual(['language', 'translate_language', 'style', 'position', 'burn_in']);
    expect(web.description).toMatch(/OpenAI transcription on the server/);
    // Tools without overrides are passed through as-is.
    expect(filtered.find(t => t.function.name === 'trim_video')).toBe(tools.find(t => t.function.name === 'trim_video'));
  });
});

describe('POST /api/chat execution:"client" with a FinalCap-iOS UA', () => {
  const finalAnswer = () => jsonResponse(completion({ content: 'Answer:\nOk.' }));

  it('build 10, video: offers exactly the allowlisted video tools', async () => {
    xaiResponder = finalAnswer;
    const res = await chatAs(ios(10), { execution: 'client', media: { type: 'video' }, messages: [{ role: 'user', content: 'x' }] });
    expect(res.status).toBe(200);
    const offered = names(xaiCalls[0].tools);
    expect(offered).toEqual(names(toolsForMediaType('video')).filter(n => allowlisted.includes(n)));
    expect(offered).toContain('trim_video');
    expect(offered).toContain('audio_fade');
    expect(offered).toContain('convert_video_format');
    expect(offered).toContain('generate_captions');
    expect(offered).not.toContain('audio_highpass');
    expect(offered).not.toContain('convert_image_format'); // photo-only
  });

  it('build 10, photo: intersects with photo-capable tools', async () => {
    xaiResponder = finalAnswer;
    await chatAs(ios(10), { execution: 'client', media: { type: 'image' }, messages: [{ role: 'user', content: 'x' }] });
    const offered = names(xaiCalls[0].tools);
    expect(offered).toEqual(names(toolsForMediaType('image')).filter(n => allowlisted.includes(n)));
    expect(offered).toContain('apply_color_filter');
    expect(offered).not.toContain('trim_video');
    expect(offered).toContain('convert_image_format');
    expect(xaiCalls[0].tools.find(t => t.function.name === 'convert_image_format').function.parameters.properties.format.enum).toEqual(['jpg', 'png']);
  });

  for (const ua of [ios(9), ios(1), 'FinalCap-iOS', 'FinalCap-iOS/abc']) {
    it(`${ua}: below every minBuild / no build → no tools offered at all`, async () => {
      xaiResponder = finalAnswer;
      const res = await chatAs(ua, { execution: 'client', media: { type: 'video' }, messages: [{ role: 'user', content: 'x' }] });
      expect(res.status).toBe(200);
      expect(xaiCalls[0].tools).toBeUndefined();
      expect(xaiCalls[0].tool_choice).toBeUndefined();
    });
  }

  it('drops a model call to a non-allowlisted tool', async () => {
    xaiResponder = () => jsonResponse(completion({
      content: 'Answer:\nChorus is not available here.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'audio_chorus', arguments: '{}' } }],
    }));
    const res = await chatAs(ios(10), { execution: 'client', media: { type: 'video' }, messages: [{ role: 'user', content: 'add chorus' }] });
    expect(await res.json()).toMatchObject({ status: 'final', message: 'Chorus is not available here.' });
  });

  it('web and old-iOS UAs still get every media-valid tool', async () => {
    for (const ua of [WEB_UA, OLD_IOS_UA]) {
      xaiCalls.length = 0;
      xaiResponder = finalAnswer;
      await chatAs(ua, { execution: 'client', media: { type: 'video' }, messages: [{ role: 'user', content: 'x' }] });
      expect(names(xaiCalls[0].tools)).toEqual(names(toolsForMediaType('video')));
    }
    xaiCalls.length = 0;
    xaiResponder = finalAnswer;
    await chatAs(WEB_UA, { execution: 'client', messages: [{ role: 'user', content: 'x' }] });
    expect(xaiCalls[0].tools).toHaveLength(46);
  });
});

describe('POST /api/chat streaming mode with a FinalCap-iOS UA', () => {
  const sse = () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  const trim = tools.find(t => t.function.name === 'trim_video');
  const chorus = tools.find(t => t.function.name === 'audio_chorus');

  it('build 10: forwards only allowlisted client tools', async () => {
    xaiResponder = sse;
    const res = await chatAs(ios(10), { messages: [{ role: 'user', content: 'x' }], tools: [trim, chorus], tool_choice: 'auto' });
    expect(res.status).toBe(200);
    await res.text();
    expect(names(xaiCalls[0].tools)).toEqual(['trim_video']);
    expect(xaiCalls[0].tool_choice).toBe('auto');
  });

  it('build 9 / no build: removes tools and tool_choice entirely', async () => {
    for (const ua of [ios(9), 'FinalCap-iOS']) {
      xaiCalls.length = 0;
      xaiResponder = sse;
      const res = await chatAs(ua, { messages: [{ role: 'user', content: 'x' }], tools: [trim, chorus], tool_choice: 'auto' });
      await res.text();
      expect('tools' in xaiCalls[0]).toBe(false);
      expect('tool_choice' in xaiCalls[0]).toBe(false);
    }
  });

  it('drops a forced tool_choice that names a removed tool', () => {
    const out = restrictStreamingBodyForIos({ tools: [trim, chorus], tool_choice: { type: 'function', function: { name: 'audio_chorus' } } }, ios(10));
    expect(names(out.tools)).toEqual(['trim_video']);
    expect('tool_choice' in out).toBe(false);
  });

  it('web UA: the exact same body object is forwarded (byte-for-byte unchanged)', async () => {
    const reqBody = { messages: [{ role: 'user', content: 'hi' }], tools: [chorus, trim], tool_choice: 'auto', temperature: 0.2 };
    const same = { a: 1 };
    expect(restrictStreamingBodyForIos(same, WEB_UA)).toBe(same);
    expect(restrictStreamingBodyForIos(same, undefined)).toBe(same);
    xaiResponder = sse;
    const res = await chatAs(WEB_UA, reqBody);
    await res.text();
    expect(Object.keys(xaiCalls[0])).toEqual(['messages', 'tools', 'tool_choice', 'temperature', 'model', 'stream']);
    expect(xaiCalls[0].tools).toEqual([chorus, trim]);
  });
});

describe('GET /api/tools/schema by User-Agent', () => {
  const getSchema = (ua) => realFetch(`${base}/api/tools/schema`, { headers: ua ? { 'User-Agent': ua } : {} });

  it('FinalCap-iOS/10 → the 21 allowlisted tools, schemaVersion "1", Vary: User-Agent', async () => {
    const res = await getSchema(ios(10));
    expect(res.headers.get('vary')).toMatch(/User-Agent/i);
    const body = await res.json();
    expect(body.schemaVersion).toBe('1');
    expect(names(body.tools).sort()).toEqual([...allowlisted].sort());
    expect(Object.keys(body.mediaTypes).sort()).toEqual([...allowlisted].sort());
    expect(body.mediaTypes.trim_video).toEqual(['video']);
  });

  it('FinalCap-iOS/9 and a missing build → no tools', async () => {
    for (const ua of [ios(9), 'FinalCap-iOS']) {
      const body = await (await getSchema(ua)).json();
      expect(body).toEqual({ schemaVersion: '1', tools: [], mediaTypes: {} });
    }
  });

  it('web UA → all 46 tools, identical to the committed schema', async () => {
    const body = await (await getSchema(WEB_UA)).json();
    expect(body).toEqual(JSON.parse(JSON.stringify(buildToolsSchema())));
    expect(body.tools).toHaveLength(46);
  });
});

describe('unsupported_on_device tool results (safety net)', () => {
  const turn = (resultContent) => ([
    { role: 'user', content: 'Reverse the audio then brighten' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'audio_reverse', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'adjust_brightness', arguments: '{"brightness":0.1}' } },
    ] },
    { role: 'tool', tool_call_id: 'c1', content: resultContent },
    { role: 'tool', tool_call_id: 'c2', content: '{"ok":true,"executedOn":"device"}' },
  ]);

  it('code:"unsupported_on_device" is annotated, the tool is withdrawn, and the model is told to explain', async () => {
    xaiResponder = () => jsonResponse(completion({ content: 'Answer:\nBrightened it. Reversing audio is not available on the phone yet.' }));
    const res = await chatAs(WEB_UA, { execution: 'client', media: { type: 'video' }, messages: turn({ ok: false, code: 'unsupported_on_device', executedOn: 'device' }) });
    const body = await res.json();
    expect(body.status).toBe('final');
    const sent = xaiCalls[0];
    const annotated = JSON.parse(sent.messages.find(m => m.role === 'tool' && m.tool_call_id === 'c1').content);
    expect(annotated).toMatchObject({ ok: false, code: 'unsupported_on_device', unsupportedOnDevice: true });
    expect(annotated.note).toContain('not available on the phone yet');
    expect(annotated.note).toContain('Do not call audio_reverse again');
    expect(sent.messages[0].content).toContain('not available on the phone yet: audio_reverse');
    expect(names(sent.tools)).not.toContain('audio_reverse');
    expect(names(sent.tools)).toContain('adjust_brightness');
  });

  it('accepts reason or error instead of code', () => {
    expect(isUnsupportedOnDevice({ ok: false, code: 'unsupported_on_device' })).toBe(true);
    expect(isUnsupportedOnDevice({ ok: false, reason: 'unsupported_on_device' })).toBe(true);
    expect(isUnsupportedOnDevice({ ok: false, error: 'unsupported_on_device' })).toBe(true);
    expect(isUnsupportedOnDevice({ ok: true, code: 'unsupported_on_device' })).toBe(false);
    expect(isUnsupportedOnDevice({ ok: false, code: 'boom' })).toBe(false);
    expect(annotateToolResult('{"ok":false,"code":"other"}', 'x')).toBe('{"ok":false,"code":"other"}');
  });

  it('only the current turn counts', () => {
    const messages = normalizeClientMessages([
      ...turn('{"ok":false,"reason":"unsupported_on_device"}'),
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'try again' },
    ]);
    expect(unsupportedToolsInTurn(messages)).toEqual([]);
    expect(unsupportedToolsInTurn(normalizeClientMessages(turn('{"ok":false,"reason":"unsupported_on_device"}')))).toEqual(['audio_reverse']);
  });

  it('drops a re-call of the unsupported tool and falls back to a short message', async () => {
    xaiResponder = () => jsonResponse(completion({
      content: '',
      tool_calls: [{ id: 'c9', type: 'function', function: { name: 'audio_reverse', arguments: '{}' } }],
    }));
    const res = await chatAs(ios(10), { execution: 'client', media: { type: 'video' }, messages: turn('{"ok":false,"error":"unsupported_on_device"}') });
    expect(await res.json()).toMatchObject({ status: 'final', message: "Sorry, that edit isn't available on the phone yet." });
  });
});
