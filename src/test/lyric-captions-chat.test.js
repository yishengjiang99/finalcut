// @vitest-environment node
// lyric_captions is an agentic chat tool: /api/chat offers it to the model (web, client mode and
// streaming), the model's call carries target_language/source_language, and the tool result the
// model sees afterwards is brief. The model is mocked.
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
vi.mock('../db.js', () => ({
  saveLesson: vi.fn().mockResolvedValue(undefined),
  enqueueChatInteraction: vi.fn(),
  findUserByApiToken: vi.fn(),
  consumeDailyInference: vi.fn(),
}));

import express from 'express';
import { chatRouter } from '../server/chat.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { tools } from '../tools.js';

const realFetch = globalThis.fetch;
const xaiCalls = [];
let reply;
let server;
let base;
let token;

const PROMPTS = [
  { text: 'add lyrics captions in Chinese', args: { target_language: 'zh-Hans' } },
  { text: 'subtitle the song in German and Chinese', args: { target_language: 'zh-Hans', source_language: 'de' } },
  { text: 'translate the lyrics on the video to Spanish', args: { target_language: 'es' } },
];

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).startsWith('https://api.x.ai/')) {
      const body = JSON.parse(init.body);
      xaiCalls.push(body);
      return reply(body);
    }
    return realFetch(url, init);
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(chatRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  xaiCalls.length = 0;
  token = issueSampleAccessToken();
});

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const postChat = (body, headers = {}) => realFetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'sample-access-token': token, ...headers },
  body: JSON.stringify(body),
});
const offeredNames = (call) => call.tools.map(t => t.function.name);

describe('lyric_captions in /api/chat', () => {
  it('description maps the user phrasings to the tool and says how to fill the languages', () => {
    const d = tools.find(t => t.function.name === 'lyric_captions').function.description;
    for (const phrase of ['add lyrics captions', 'subtitle the song in Chinese', 'translate the lyrics on the video']) expect(d).toContain(phrase);
    expect(d).toMatch(/Fill target_language/);
    expect(d).toMatch(/source_language only if they name the sung language/);
  });

  for (const { text, args } of PROMPTS) {
    it(`client mode: "${text}" → lyric_captions ${JSON.stringify(args)}`, async () => {
      reply = () => json({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'lc1', type: 'function', function: { name: 'lyric_captions', arguments: JSON.stringify(args) } }] } }] });
      const res = await postChat({ execution: 'client', messages: [{ role: 'user', content: text }], media: { type: 'video', width: 720, height: 1280, durationSec: 30 } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: 'tool_calls', toolCalls: [{ id: 'lc1', name: 'lyric_captions', arguments: args }] });
      expect(offeredNames(xaiCalls[0])).toContain('lyric_captions');
      expect(xaiCalls[0].messages.at(-1)).toMatchObject({ role: 'user', content: text });
    });
  }

  it('client mode continuation: the brief tool result (no lyrics) reaches the model', async () => {
    reply = () => json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '- Answer:\n  Added bilingual captions.\n- Lesson:\n  Ask for the language.' } }] });
    const toolResult = { ok: true, executedOn: 'device', output: { song: { title: 'T', artist: 'A', url: 'https://example.com/t', confidence: 'high' }, lineCount: 12, language: 'de', targetLanguage: 'zh-Hans' } };
    const res = await postChat({
      execution: 'client',
      media: { type: 'video', width: 720, height: 1280 },
      messages: [
        { role: 'user', content: 'subtitle the song in German and Chinese' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'lc1', type: 'function', function: { name: 'lyric_captions', arguments: '{"target_language":"zh-Hans","source_language":"de"}' } }] },
        { role: 'tool', tool_call_id: 'lc1', content: toolResult },
      ],
    });
    expect((await res.json()).status).toBe('final');
    const sentTool = xaiCalls[0].messages.find(m => m.role === 'tool');
    expect(JSON.parse(sentTool.content)).toMatchObject({ ok: true, output: { lineCount: 12, song: { title: 'T' } } });
  });

  it('photos are not offered lyric_captions; FinalCap-iOS builds are not offered it (needs Cloud processing)', async () => {
    reply = () => json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '- Answer:\n  ok\n- Lesson:\n  x' } }] });
    await postChat({ execution: 'client', messages: [{ role: 'user', content: 'add lyrics captions' }], media: { type: 'image', width: 100, height: 100 } });
    expect(offeredNames(xaiCalls[0])).not.toContain('lyric_captions');
    await postChat({ execution: 'client', messages: [{ role: 'user', content: 'add lyrics captions' }], media: { type: 'video', width: 720, height: 1280 } }, { 'User-Agent': 'FinalCap-iOS/12' });
    expect(offeredNames(xaiCalls[1])).not.toContain('lyric_captions');
  });

  it('streaming (web) mode forwards the web tool list, including lyric_captions, to the model', async () => {
    reply = () => new Response('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"lc1","type":"function","function":{"name":"lyric_captions","arguments":"{\\"target_language\\":\\"es\\"}"}}]}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const res = await postChat({ messages: [{ role: 'user', content: 'translate the lyrics on the video to Spanish' }], tools, tool_choice: 'auto' });
    const text = await res.text();
    expect(offeredNames(xaiCalls[0])).toContain('lyric_captions');
    expect(text).toContain('"name":"lyric_captions"');
    expect(text).toContain('target_language');
  });
});
