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
import { chatRouter, cleanFinalText } from '../server/chat.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { buildToolsSchema, TOOLS_SCHEMA_VERSION } from '../server/toolsSchema.js';
import { tools } from '../tools.js';
import {
  MAX_THUMBNAIL_BYTES,
  MAX_TOOL_ROUNDS,
  annotateToolResult,
  parseThumbnails,
  skippedToolsInTurn,
  normalizeClientMessages,
} from '../server/clientExecution.js';

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

const smallJpegBase64 = readFileSync(path.join(here, 'fixtures', 'photo-64x48.jpg')).toString('base64');

describe('client execution mode', () => {
  it('first turn returns tool_calls (parsed arguments) without running ffmpeg or needing a file', async () => {
    xaiResponder = () => jsonResponse(completion({
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'apply_color_filter', arguments: '{"filter":"red","intensity":0.8}' } }],
    }));
    const res = await postChat({
      execution: 'client',
      messages: [{ role: 'user', content: 'Apply red filter' }],
      media: { type: 'image', width: 4032, height: 3024 },
      thumbnails: [smallJpegBase64],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      schemaVersion: '1',
      status: 'tool_calls',
      toolCalls: [{ id: 'call_1', name: 'apply_color_filter', arguments: { filter: 'red', intensity: 0.8 } }],
      thumbnailsSentAsImages: false,
    });
    expect(body.messages.at(-1)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] });
    expect(ffmpegSpy).not.toHaveBeenCalled();

    const sent = xaiCalls[0];
    expect(sent.stream).toBe(false);
    expect(sent.model).toBe('grok-3');
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages[0].content).toContain('type=image, resolution=4032x3024');
    // Photo → only photo-capable tools are offered.
    const offered = sent.tools.map(t => t.function.name);
    expect(offered).toContain('apply_color_filter');
    expect(offered).not.toContain('trim_video');
    // grok-3 has no image input → thumbnails not forwarded as images.
    expect(JSON.stringify(sent.messages)).not.toContain('image_url');
  });

  it('sends thumbnails as image inputs when a vision model is configured', async () => {
    process.env.XAI_CLIENT_MODEL = 'grok-4.3';
    try {
      xaiResponder = () => jsonResponse(completion({ content: 'Answer:\nLooks great.' }));
      const res = await postChat({
        execution: 'client',
        messages: [{ role: 'user', content: 'What is in this video?' }],
        media: { type: 'video', duration: 12.5, width: 1920, height: 1080, fps: 30, hasAudio: true, codec: 'h264' },
        thumbnails: [smallJpegBase64, `data:image/jpeg;base64,${smallJpegBase64}`],
      });
      const body = await res.json();
      expect(body.thumbnailsSentAsImages).toBe(true);
      const imageParts = xaiCalls[0].messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(p => p.type === 'image_url');
      expect(imageParts).toHaveLength(2);
      expect(imageParts[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
      expect(xaiCalls[0].messages.at(-1)).toEqual({ role: 'user', content: 'What is in this video?' });
    } finally {
      delete process.env.XAI_CLIENT_MODEL;
    }
  });

  it('a turn with tool results continues to a final answer', async () => {
    xaiResponder = () => jsonResponse(completion({ content: '- Answer:\n  Applied a red filter.\n- Lesson:\n  Red tints work well on photos.' }));
    const res = await postChat({
      execution: 'client',
      media: { type: 'image', width: 100, height: 100 },
      messages: [
        { role: 'user', content: 'Apply red filter' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'apply_color_filter', arguments: '{"filter":"red"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: { ok: true, executedOn: 'device', output: { width: 100, height: 100 } } },
      ],
    });
    const body = await res.json();
    expect(body).toMatchObject({ schemaVersion: '1', status: 'final', message: 'Applied a red filter.' });
    const toolMsg = xaiCalls[0].messages.find(m => m.role === 'tool');
    expect(typeof toolMsg.content).toBe('string');
    expect(JSON.parse(toolMsg.content)).toMatchObject({ ok: true, executedOn: 'device' });
    expect(db.saveLesson).not.toHaveBeenCalled(); // sample mode has no user id
  });

  it('skipped_by_user is not a failure: annotated, tool withheld, continues to final', async () => {
    xaiResponder = () => jsonResponse(completion({ content: 'Answer:\nOkay, left the colors as they were and brightened it.' }));
    const res = await postChat({
      execution: 'client',
      media: { type: 'image' },
      messages: [
        { role: 'user', content: 'Red filter then brighten' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'apply_color_filter', arguments: '{"filter":"red"}' } },
          { id: 'c2', type: 'function', function: { name: 'adjust_brightness', arguments: '{"brightness":0.1}' } },
        ] },
        { role: 'tool', tool_call_id: 'c1', content: '{"ok":false,"error":"skipped_by_user","executedOn":"device"}' },
        { role: 'tool', tool_call_id: 'c2', content: '{"ok":true,"executedOn":"device"}' },
      ],
    });
    const body = await res.json();
    expect(body.status).toBe('final');
    const sent = xaiCalls[0];
    const skippedMsg = sent.messages.find(m => m.role === 'tool' && m.tool_call_id === 'c1');
    const parsed = JSON.parse(skippedMsg.content);
    expect(parsed).toMatchObject({ ok: false, error: 'skipped_by_user', skipped: true });
    expect(parsed.note).toContain('NOT a failure');
    expect(parsed.note).toContain('Do not call apply_color_filter again');
    expect(sent.messages[0].content).toContain('declined these steps this turn (not failures): apply_color_filter');
    expect(sent.tools.map(t => t.function.name)).not.toContain('apply_color_filter');
  });

  it('drops model re-calls of a skipped tool and finishes instead of looping', async () => {
    xaiResponder = () => jsonResponse(completion({
      content: 'Answer:\nSkipped as requested.',
      tool_calls: [{ id: 'c9', type: 'function', function: { name: 'apply_color_filter', arguments: '{"filter":"red"}' } }],
    }));
    const res = await postChat({
      execution: 'client',
      media: { type: 'image' },
      messages: [
        { role: 'user', content: 'Red filter' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_color_filter', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: { ok: false, error: 'skipped_by_user', executedOn: 'device' } },
      ],
    });
    const body = await res.json();
    expect(body).toMatchObject({ status: 'final', message: 'Skipped as requested.' });
  });

  it(`caps tool rounds per turn at ${MAX_TOOL_ROUNDS}`, async () => {
    const messages = [{ role: 'user', content: 'keep trying' }];
    for (let i = 0; i < MAX_TOOL_ROUNDS; i += 1) {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'adjust_brightness', arguments: '{"brightness":0.1}' } }] });
      messages.push({ role: 'tool', tool_call_id: `c${i}`, content: { ok: false, error: 'boom', executedOn: 'device' } });
    }
    xaiResponder = () => jsonResponse(completion({
      content: 'Answer:\nI could not apply it.',
      tool_calls: [{ id: 'cx', type: 'function', function: { name: 'adjust_brightness', arguments: '{}' } }],
    }));
    const res = await postChat({ execution: 'client', media: { type: 'video' }, messages });
    const body = await res.json();
    expect(body.status).toBe('final');
    expect(xaiCalls[0].tools).toBeUndefined();
    expect(xaiCalls[0].messages[0].content).toContain(`Tool-call limit (${MAX_TOOL_ROUNDS} rounds) reached`);
  });

  it('enforces thumbnail limits (count → 400, size → 413) before calling xAI', async () => {
    const five = await postChat({ execution: 'client', messages: [{ role: 'user', content: 'x' }], thumbnails: Array(5).fill(smallJpegBase64) });
    expect(five.status).toBe(400);
    const big = Buffer.alloc(MAX_THUMBNAIL_BYTES + 10, 0);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    const tooBig = await postChat({ execution: 'client', messages: [{ role: 'user', content: 'x' }], thumbnails: [big.toString('base64')] });
    expect(tooBig.status).toBe(413);
    const notImage = await postChat({ execution: 'client', messages: [{ role: 'user', content: 'x' }], thumbnails: [Buffer.from('hello world').toString('base64')] });
    expect(notImage.status).toBe(400);
    const badMedia = await postChat({ execution: 'client', messages: [{ role: 'user', content: 'x' }], media: { type: 'gif' } });
    expect(badMedia.status).toBe(400);
    const badMode = await postChat({ execution: 'server', messages: [{ role: 'user', content: 'x' }] });
    expect(badMode.status).toBe(400);
    expect(xaiCalls).toHaveLength(0);
  });

  it('uses the same auth + daily quota as chat (Bearer device user consumes one inference)', async () => {
    db.findUserByApiToken.mockResolvedValue({ id: 7, has_subscription: 0, device_install_id: 'dev-1' });
    db.consumeDailyInference.mockResolvedValue({ allowed: true, limit: 3, used: 1, remaining: 2, resetsAt: 'x' });
    xaiResponder = () => jsonResponse(completion({ content: 'Answer:\nHi' }));
    const res = await postChat({ execution: 'client', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer abc' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-inference-daily-remaining')).toBe('2');
    expect(db.consumeDailyInference).toHaveBeenCalledWith(7, 3);

    db.consumeDailyInference.mockResolvedValue({ allowed: false, limit: 3, used: 3, remaining: 0, resetsAt: 'x' });
    const limited = await postChat({ execution: 'client', messages: [{ role: 'user', content: 'hi' }] }, { Authorization: 'Bearer abc' });
    expect(limited.status).toBe(429);

    const anon = await postChat({ execution: 'client', messages: [{ role: 'user', content: 'hi' }] }, {});
    expect(anon.status).toBe(401);
  });
});

describe('server (default) mode is unchanged', () => {
  it('streams SSE and forwards the original body with system message, grok-3 and stream:true', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"Hello there, this is a streamed reply."}}]}\n\ndata: [DONE]\n\n';
    xaiResponder = () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const reqBody = { messages: [{ role: 'user', content: 'hi' }], tools: [tools[0]], temperature: 0.2 };
    const res = await postChat(reqBody);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    // Exact bytes produced by the pre-existing streaming filter (32-char hold buffer).
    expect(text).toBe(
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"there, this is a streamed reply."}}]}\n\n'
      + 'data: [DONE]\n\n'
    );
    const sent = xaiCalls[0];
    expect(Object.keys(sent)).toEqual(['messages', 'tools', 'temperature', 'model', 'stream']);
    expect(sent).toMatchObject({ model: 'grok-3', stream: true, temperature: 0.2, tools: [tools[0]] });
    expect(sent.messages[0].role).toBe('system');
    expect(sent.messages.slice(1)).toEqual(reqBody.messages);
    expect(sent.messages[0].content).not.toContain('executed on the user');
  });
});

describe('tools schema contract', () => {
  it('GET /api/tools/schema returns version, tools and mediaTypes', async () => {
    const res = await realFetch(`${base}/api/tools/schema`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe('1');
    expect(body.tools).toEqual(JSON.parse(JSON.stringify(tools)));
    expect(body.mediaTypes.trim_video).toEqual(['video']);
    expect(body.mediaTypes.apply_color_filter).toEqual(['video', 'image']);
    expect(body.mediaTypes.convert_image_format).toEqual(['image']);
    expect(Object.keys(body.mediaTypes).sort()).toEqual(tools.map(t => t.function.name).sort());
  });

  it('committed docs/api/tools-schema.v<version>.json matches src/tools.js (bump version + `npm run schema:tools` on change)', () => {
    const file = path.join(here, '..', '..', 'docs', 'api', `tools-schema.v${TOOLS_SCHEMA_VERSION}.json`);
    const committed = JSON.parse(readFileSync(file, 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildToolsSchema())));
  });
});

describe('client execution helpers', () => {
  it('parseThumbnails accepts data URLs and raw base64', () => {
    const out = parseThumbnails([smallJpegBase64, `data:image/jpeg;base64,${smallJpegBase64}`]);
    expect(out.map(t => t.mime)).toEqual(['image/jpeg', 'image/jpeg']);
  });

  it('annotateToolResult leaves normal results untouched', () => {
    expect(annotateToolResult('{"ok":true}', 'x')).toBe('{"ok":true}');
    expect(annotateToolResult('not json', 'x')).toBe('not json');
  });

  it('skippedToolsInTurn only considers the current user turn', () => {
    const msgs = normalizeClientMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', tool_calls: [{ id: '1', function: { name: 'adjust_hue', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '1', content: { ok: false, error: 'skipped_by_user' } },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'b' },
    ]);
    expect(skippedToolsInTurn(msgs)).toEqual([]);
  });

  it('cleanFinalText strips Answer/Lesson sections', () => {
    expect(cleanFinalText('- Answer:\n  Done.\n- Lesson:\n  x')).toBe('Done.');
  });
});
