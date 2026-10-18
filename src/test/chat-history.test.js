// @vitest-environment node
// Follow-up turns keep the conversation: "Caption in Chinese", the model's style question, then "Default"
// must still caption in Chinese. Before, each request carried only the latest user message, so the model
// saw "Default" alone and the target language was lost.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../server/config.js', () => ({
  XAI_API_TOKEN: 'test-token', PORT: 3001, TMP_DIR: '/tmp', IS_PRODUCTION: false, OPENAI_API_KEY: null, SESSION_SECRET: 'test-secret',
  APP_BASE_URL: null, ALLOW_UNAUTH_SAMPLE_MODE: true, SAMPLE_TOKEN_TTL_MS: 600000, IOS_FREE_DAILY_INFERENCE_LIMIT: 3,
}));
vi.mock('../db.js', () => ({ enqueueChatInteraction: vi.fn(), findUserByApiToken: vi.fn(), consumeDailyInference: vi.fn() }));
const toolRuns = vi.hoisted(() => []);
vi.mock('../toolFunctions.js', () => ({
  toolFunctions: { lyric_captions: async (args) => { toolRuns.push(args); return 'lyric_captions done: 3 lines.'; } },
  getCurrentFileMimeType: () => 'video/mp4',
  resetLastExecution: () => {},
  getLastExecution: () => ({ executedOn: 'browser' }),
  setToolStatusListener: () => {},
}));
vi.mock('../wasm/ffmpegEngine.js', () => ({
  probeMedia: async () => ({ format: { duration: 10 }, streams: [{ codec_type: 'video', width: 720, height: 1280 }] }),
  summarizeProbe: () => ({ duration: 10, width: 720, height: 1280, fps: 30, hasAudio: true }),
  subscribeEngine: () => () => {},
}));
vi.mock('../telemetry.js', () => ({ track: () => {}, msBucket: () => '0' }));

import express from 'express';
import { chatRouter } from '../server/chat.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { runClientTurn } from '../clientTurn.js';
import { priorHistory, HISTORY_MAX_MESSAGES, HISTORY_MAX_CHARS, HISTORY_MAX_MESSAGE_CHARS } from '../chatHistory.js';
import { messagesForCurrentTurn } from '../useCallAPI.js';

const QUESTION = 'Which font and where should the captions go? Default is Noto Sans CJK SC Bold, bottom, 20% up.';
const realFetch = globalThis.fetch;
const modelCalls = [];
let server; let base; let token;

// A model that behaves as the system prompt says: it asks the style question for a bare caption request,
// and calls the tool once it has the language and the style (or "default").
function model(body) {
  modelCalls.push(body);
  const userTexts = body.messages.filter(m => m.role === 'user').map(m => String(m.content));
  const last = userTexts.at(-1) || '';
  const toolDone = body.messages.some(m => m.role === 'tool');
  const json = (message, finish) => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: finish, message }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (toolDone) return json({ role: 'assistant', content: 'Added Chinese captions.' }, 'stop');
  const wantsChinese = userTexts.some(t => /chinese/i.test(t));
  const styled = /default|bottom|top|large|small/i.test(last);
  if (/^caption/i.test(last) && !styled) return json({ role: 'assistant', content: QUESTION }, 'stop');
  const args = { target_language: wantsChinese ? 'zh-Hans' : 'en', mode: 'speech', font: 'Noto Sans CJK SC', size: 'default', position: 'bottom' };
  return json({ role: 'assistant', content: null, tool_calls: [{ id: 'lc1', type: 'function', function: { name: 'lyric_captions', arguments: JSON.stringify(args) } }] }, 'tool_calls');
}

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (url, init) => (String(url).startsWith('https://api.x.ai/') ? model(JSON.parse(init.body)) : realFetch(url, init)));
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(chatRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
beforeEach(() => { modelCalls.length = 0; toolRuns.length = 0; token = issueSampleAccessToken(); });

const post = async (body) => (await realFetch(`${base}/api/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'sample-access-token': token }, body: JSON.stringify({ execution: 'client', ...body }),
})).json();

/** One chat turn the way App.jsx drives it: state in, runClientTurn appends the exchange. */
async function turn(state, text) {
  const messages = [...state, { role: 'user', content: text, id: state.length + 1 }];
  let id = 1000 + messages.length;
  await runClientTurn({
    messages, videoFileData: new Uint8Array([1, 2, 3]), post,
    ui: {
      setProcessing: () => {}, setVideoFileData: () => {}, addMessage: () => {}, uploadedVideos: [], nextId: () => id++,
      addAssistantMessage: () => id++,
    },
  });
  return messages;
}

describe('the conversation reaches the model', () => {
  it('"Caption in Chinese", the style question, then "Default": lyric_captions is called in Chinese with the default style', async () => {
    let state = await turn([{ role: 'user', content: '', apiContent: 'A video file is available for editing.', excludeFromAPI: false, id: 0 }], 'Caption in Chinese');
    expect(toolRuns).toEqual([]); // asked first
    expect(state.at(-1)).toMatchObject({ role: 'assistant', content: QUESTION });

    state = await turn(state, 'Default');
    expect(toolRuns).toEqual([{ target_language: 'zh-Hans', mode: 'speech', font: 'Noto Sans CJK SC', size: 'default', position: 'bottom' }]);
    // The model was shown the whole exchange, as text only, before the tool call.
    const seen = modelCalls.find(c => c.messages.some(m => m.content === 'Default')).messages.filter(m => m.role !== 'system');
    expect(seen.map(m => [m.role, m.content])).toEqual([['user', 'Caption in Chinese'], ['assistant', QUESTION], ['user', 'Default']]);
  });

  it('without the history the language is lost (the bug): the model sees only "Default"', async () => {
    const reply = await post({ messages: [{ role: 'user', content: 'Default' }], media: { type: 'video', width: 720, height: 1280, durationSec: 10 } });
    expect(JSON.parse(reply.toolCalls[0].arguments.target_language ? JSON.stringify(reply.toolCalls[0].arguments) : '{}').target_language).toBe('en');
  });

  it('the tool-call loop continues with the history and does not count the earlier turn again', async () => {
    const state = await turn([], 'Caption in Chinese, bottom, large');
    expect(toolRuns).toHaveLength(1);
    const continuation = modelCalls.at(-1).messages.filter(m => m.role !== 'system');
    expect(continuation.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);
    const next = await turn(state, 'Now caption again, default');
    expect(toolRuns).toHaveLength(2); // exactly one more tool run
    const roles = modelCalls.at(-1).messages.filter(m => m.role !== 'system').map(m => m.role);
    // earlier turn: user + its final reply as text; this turn: user, assistant tool call, tool result
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'tool']);
    expect(next.filter(m => m.role === 'tool')).toHaveLength(2);
  });
});

describe('priorHistory', () => {
  const u = (content, extra = {}) => ({ role: 'user', content, ...extra });
  const a = (content, extra = {}) => ({ role: 'assistant', content, ...extra });

  it('sends user messages and final assistant replies only, before the latest user message', () => {
    const state = [
      u('', { apiContent: 'A video file is available for editing.' }),
      u('make it darker'),
      a(null, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'adjust_brightness', arguments: '{}' } }] }),
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      a('Processed video:', { excludeFromAPI: true, videoUrl: 'blob:x' }),
      a('Made it darker.'),
      u('caption in Chinese'),
    ];
    expect(priorHistory(state)).toEqual([{ role: 'user', content: 'make it darker' }, { role: 'assistant', content: 'Made it darker.' }]);
    expect(priorHistory([u('first')])).toEqual([]);
    expect(priorHistory(undefined)).toEqual([]);
  });

  it('starts after the latest upload (a new file is a new conversation)', () => {
    const state = [u('', { apiContent: 'A video file is available for editing.' }), u('old request'), a('old reply'),
      u('', { apiContent: 'A video file is available for editing.' }), u('new request'), a('new reply'), u('go')];
    expect(priorHistory(state).map(m => m.content)).toEqual(['new request', 'new reply']);
  });

  it('is bounded by message count, characters and message length, and starts on a user message', () => {
    const many = [];
    for (let i = 0; i < 20; i++) { many.push(u(`q${i}`), a(`a${i}`)); }
    many.push(u('now'));
    const h = priorHistory(many);
    expect(h.length).toBeLessThanOrEqual(HISTORY_MAX_MESSAGES);
    expect(h.at(-1)).toEqual({ role: 'assistant', content: 'a19' });
    expect(h[0].role).toBe('user');

    const long = [u('x'.repeat(5000)), a('y'.repeat(5000)), u('z'.repeat(5000)), a('w'.repeat(5000)), u('now')];
    const bounded = priorHistory(long);
    expect(bounded.every(m => m.content.length <= HISTORY_MAX_MESSAGE_CHARS)).toBe(true);
    expect(bounded.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(bounded[0].role).toBe('user');
  });

  it('never carries media: no urls, previews or non-text parts', () => {
    const state = [u([{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]),
      a('ok', { videoUrl: 'blob:abc', mimeType: 'video/mp4' }), u('next')];
    const h = priorHistory(state);
    expect(JSON.stringify(h)).not.toMatch(/blob:|data:image|videoUrl|image_url/);
    expect(h).toEqual([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'ok' }]);
  });

  it('messagesForCurrentTurn (the no-file chat request) carries the history too', () => {
    const state = [u('Caption in Chinese'), a(QUESTION), u('Default')];
    expect(messagesForCurrentTurn(state)).toEqual([{ role: 'user', content: 'Caption in Chinese' }, { role: 'assistant', content: QUESTION }, { role: 'user', content: 'Default' }]);
  });
});
