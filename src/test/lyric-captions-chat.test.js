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
  enqueueChatInteraction: vi.fn(),
  findUserByApiToken: vi.fn(),
  consumeDailyInference: vi.fn(),
}));

import express from 'express';
import { chatRouter } from '../server/chat.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { tools, systemPrompt } from '../tools.js';

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
// Plain speech: no song, the user just wants captions in another language.
const SPEECH_PROMPTS = [
  { text: 'add captions in Chinese', args: { target_language: 'zh-Hans', mode: 'speech' } },
  { text: 'translate the video into Chinese and burn the captions', args: { target_language: 'zh-Hans', mode: 'speech' } },
  { text: 'Chinese subtitles', args: { target_language: 'zh-Hans', mode: 'speech' } },
  { text: 'Add caption in Chinese', args: { target_language: 'zh-Hans', mode: 'speech' } },
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
    expect(d).toMatch(/set source_language only if they name it/);
  });

  it('description covers plain speech and Chinese phrasings, and sends same-language captions to generate_captions', () => {
    const d = tools.find(t => t.function.name === 'lyric_captions').function.description;
    for (const phrase of ['add captions in Chinese', 'add Chinese captions', 'Chinese subtitles',
      'translate the video into Chinese and burn the captions', 'mode "speech"', 'zh-Hans', 'detected automatically',
      'replaced, not doubled', 'generate_captions only for same-language']) expect(d).toContain(phrase);
    const gen = tools.find(t => t.function.name === 'generate_captions').function;
    expect(gen.description).toMatch(/same-language/);
    expect(gen.description).toMatch(/call lyric_captions instead/);
    expect(gen.parameters.properties.translate_language.description).toMatch(/lyric_captions/);
  });

  it('the web system prompt routes other-language captions to lyric_captions and same-language ones to generate_captions', () => {
    expect(systemPrompt).toMatch(/call lyric_captions with target_language \(mode speech for ordinary talking, lyrics for songs\)/);
    expect(systemPrompt).toMatch(/generate_captions is for same-language captions/);
  });

  for (const { text, args } of SPEECH_PROMPTS) {
    it(`client mode: "${text}" → lyric_captions in speech mode (no generate_captions, language auto-detected)`, async () => {
      // The mocked model behaves as the description instructs; assert what it was shown and that the call passes through.
      reply = () => json({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'lc9', type: 'function', function: { name: 'lyric_captions', arguments: JSON.stringify(args) } }] } }] });
      const res = await postChat({ execution: 'client', messages: [{ role: 'user', content: text }], media: { type: 'video', width: 720, height: 1280, durationSec: 20 } });
      const body = await res.json();
      expect(body).toMatchObject({ status: 'tool_calls', toolCalls: [{ id: 'lc9', name: 'lyric_captions', arguments: args }] });
      expect(body.toolCalls[0].arguments.source_language).toBeUndefined();
      const sent = xaiCalls[0];
      const lc = sent.tools.find(t => t.function.name === 'lyric_captions').function;
      expect(lc.description).toContain('Chinese subtitles');
      expect(lc.parameters.required).toEqual(['target_language']);
      expect(lc.parameters.properties.mode.enum).toContain('speech');
    });
  }

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

  it('photos are not offered lyric_captions; FinalCap-iOS builds below LYRIC_CAPTIONS_MIN_BUILD are not offered it', async () => {
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
