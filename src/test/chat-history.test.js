// @vitest-environment node
// Follow-up turns keep the conversation. "Caption in Chinese" captions straight away with the default style;
// the reply offers a change in one line; the follow-up ("bigger, at the top") reaches the model with the
// earlier turn and re-styles the existing captions (style_captions), without captioning again. Before, each
// request carried only the latest user message, so a follow-up lost what it answered.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../server/config.js', () => ({
  XAI_API_TOKEN: 'test-token', PORT: 3001, TMP_DIR: '/tmp', IS_PRODUCTION: false, OPENAI_API_KEY: null, SESSION_SECRET: 'test-secret',
  APP_BASE_URL: null, ALLOW_UNAUTH_SAMPLE_MODE: true, SAMPLE_TOKEN_TTL_MS: 600000, IOS_FREE_DAILY_INFERENCE_LIMIT: 3,
}));
vi.mock('../db.js', () => ({ enqueueChatInteraction: vi.fn(), findUserByApiToken: vi.fn(), consumeDailyInference: vi.fn() }));
const toolRuns = vi.hoisted(() => []);
const styleRuns = vi.hoisted(() => []);
vi.mock('../toolFunctions.js', () => ({
  toolFunctions: {
    lyric_captions: async (args) => { toolRuns.push(args); return 'lyric_captions done: 3 lines.'; },
    style_captions: async (args) => { styleRuns.push(args); return 'Captions restyled.'; },
  },
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
vi.mock('../telemetry.js', () => ({ track: () => {}, trackOnce: () => {}, msBucket: () => '0' }));

import express from 'express';
import { chatRouter } from '../server/chat.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { runClientTurn } from '../clientTurn.js';
import { priorHistory, HISTORY_MAX_MESSAGES, HISTORY_MAX_CHARS, HISTORY_MAX_MESSAGE_CHARS } from '../chatHistory.js';
import { messagesForCurrentTurn } from '../useCallAPI.js';

const OFFER = 'Added Chinese captions. Want a different font or position?';
const realFetch = globalThis.fetch;
const modelCalls = [];
let server; let base; let token;

// A model that behaves as the system prompt says: it captions straight away (passing only a style the user
// stated), offers a change in one line, and re-styles with style_captions when asked afterwards.
function model(body) {
  modelCalls.push(body);
  const userTexts = body.messages.filter(m => m.role === 'user').map(m => String(m.content));
  const last = userTexts.at(-1) || '';
  const toolDone = body.messages.some(m => m.role === 'tool');
  const json = (message, finish) => new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: finish, message }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const call = (name, args) => json({ role: 'assistant', content: null, tool_calls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
  if (toolDone) return json({ role: 'assistant', content: OFFER }, 'stop');
  const captioned = body.messages.some(m => m.role === 'assistant' && m.content === OFFER);
  if (captioned && /bigger|top|font|higher|position/i.test(last)) {
    return call('style_captions', { ...(/bigger/i.test(last) ? { size: 'large' } : {}), ...(/top/i.test(last) ? { position: 'top' } : {}) });
  }
  const args = { target_language: userTexts.some(t => /chinese/i.test(t)) ? 'zh-Hans' : 'en', mode: 'speech' };
  if (/large/i.test(last)) args.size = 'large';
  if (/bottom/i.test(last)) args.position = 'bottom';
  return call('lyric_captions', args);
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
beforeEach(() => { modelCalls.length = 0; toolRuns.length = 0; styleRuns.length = 0; token = issueSampleAccessToken(); });

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
  it('"Caption in Chinese" runs lyric_captions at once with the default style (no style question, no style params)', async () => {
    const state = await turn([{ role: 'user', content: '', apiContent: 'A video file is available for editing.', excludeFromAPI: false, id: 0 }], 'Caption in Chinese');
    expect(toolRuns).toEqual([{ target_language: 'zh-Hans', mode: 'speech' }]);
    expect(state.at(-1)).toMatchObject({ role: 'assistant', content: OFFER });
  });

  it('"Caption in Chinese", then "bigger, at the top": the follow-up re-styles the existing captions, captioning is not run again', async () => {
    let state = await turn([{ role: 'user', content: '', apiContent: 'A video file is available for editing.', excludeFromAPI: false, id: 0 }], 'Caption in Chinese');
    state = await turn(state, 'Make it bigger and put it at the top');
    expect(toolRuns).toHaveLength(1); // no second transcription or translation
    expect(styleRuns).toEqual([{ size: 'large', position: 'top' }]);
    // The model was shown the earlier exchange, as text only, before the style call.
    const seen = modelCalls.find(c => c.messages.some(m => m.content === 'Make it bigger and put it at the top')).messages.filter(m => m.role !== 'system');
    expect(seen.slice(0, 3).map(m => [m.role, m.content])).toEqual([['user', 'Caption in Chinese'], ['assistant', OFFER], ['user', 'Make it bigger and put it at the top']]);
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
    const next = await turn(state, 'Now caption again');
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
    const state = [u('Caption in Chinese'), a(OFFER), u('bigger')];
    expect(messagesForCurrentTurn(state)).toEqual([{ role: 'user', content: 'Caption in Chinese' }, { role: 'assistant', content: OFFER }, { role: 'user', content: 'bigger' }]);
  });
});
