// @vitest-environment node
// FinalCap-iOS builds that cannot run lyric_captions answer it with an error or an unknown-tool result.
// Tool results from the app do pass through the server's chat tool loop (POST /api/chat, execution
// "client", role "tool" messages), so the server rewrites those before the model sees them. The model is mocked.
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
import { LYRIC_CAPTIONS_NOT_AVAILABLE, LYRIC_CAPTIONS_FAILED, rewriteLyricCaptionsResult, normalizeClientMessages } from '../server/clientExecution.js';

const realFetch = globalThis.fetch;
const xaiCalls = [];
let reply;
let server;
let base;
let token;

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
const IOS = { 'User-Agent': 'FinalCap-iOS/12' };
const media = { type: 'video', width: 720, height: 1280 };
const convo = (toolContent) => [
  { role: 'user', content: 'add captions in Chinese' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'lc1', type: 'function', function: { name: 'lyric_captions', arguments: '{"target_language":"zh-Hans"}' } }] },
  { role: 'tool', tool_call_id: 'lc1', content: toolContent },
];
const final = () => json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] });
const toolSeenByModel = (call) => call.messages.find(m => m.role === 'tool').content;

describe('iOS lyric_captions error / unknown-tool results are rewritten by the server loop', () => {
  it('the exact texts', () => {
    expect(LYRIC_CAPTIONS_NOT_AVAILABLE).toBe("lyric_captions is not available in this version of the app. Tell the user Chinese captions need the latest app update, and offer captions in the video's own language.");
    expect(LYRIC_CAPTIONS_FAILED).toBe("Captions couldn't finish. Nothing was changed. Try again.");
  });

  for (const [label, content] of [
    ['unsupported_on_device (code)', { ok: false, code: 'unsupported_on_device', executedOn: 'device' }],
    ['unsupported_on_device (build 10 sends it as error)', { ok: false, error: 'unsupported_on_device' }],
    ['unknown_tool', { ok: false, error: 'unknown_tool', message: 'No executor for lyric_captions' }],
    ['plain text "Unknown tool: lyric_captions"', 'Unknown tool: lyric_captions'],
  ]) {
    it(`${label} → the fixed "not available in this version of the app" result reaches the model`, async () => {
      reply = final;
      const res = await postChat({ execution: 'client', media, messages: convo(content) }, IOS);
      expect(res.status).toBe(200);
      const seen = JSON.parse(toolSeenByModel(xaiCalls[0]));
      expect(seen).toMatchObject({ ok: false, code: 'unsupported_on_device', error: LYRIC_CAPTIONS_NOT_AVAILABLE });
      expect(JSON.stringify(seen)).not.toMatch(/No executor/);
    });
  }

  for (const [label, content] of [
    ['an arbitrary error with raw text', { ok: false, error: 'AVAssetExportSession failed: -11800 /var/mobile/Containers/x', stack: 'at foo' }],
    ['a plain text failure', 'Error: the operation could not be completed (code 3)'],
    ['an object with error and no ok', { error: 'network_timeout', message: 'The request timed out.' }],
  ]) {
    it(`${label} → "Captions couldn't finish. Nothing was changed. Try again." and no raw text`, async () => {
      reply = final;
      await postChat({ execution: 'client', media, messages: convo(content) }, IOS);
      const seen = JSON.parse(toolSeenByModel(xaiCalls[0]));
      expect(seen).toEqual({ ok: false, executedOn: 'device', error: LYRIC_CAPTIONS_FAILED });
      expect(toolSeenByModel(xaiCalls[0])).not.toMatch(/AVAsset|mobile|stack|timed out|network_timeout|operation could not/);
    });
  }

  it('a successful result, and skipped_by_user, are not rewritten', async () => {
    reply = final;
    const ok = { ok: true, executedOn: 'device', output: { lineCount: 12 } };
    await postChat({ execution: 'client', media, messages: convo(ok) }, IOS);
    expect(JSON.parse(toolSeenByModel(xaiCalls[0]))).toEqual(ok);
    await postChat({ execution: 'client', media, messages: convo({ ok: false, error: 'skipped_by_user', executedOn: 'device' }) }, IOS);
    const skipped = JSON.parse(toolSeenByModel(xaiCalls[1]));
    expect(skipped).toMatchObject({ skipped: true, error: 'skipped_by_user' });
    expect(JSON.stringify(skipped)).not.toContain(LYRIC_CAPTIONS_FAILED);
  });

  it('other tools are not touched, and web (non-iOS) clients get their results exactly as sent', async () => {
    reply = final;
    const err = { ok: false, error: 'AVAssetExportSession failed' };
    const other = convo(err); other[1].tool_calls[0].function.name = 'trim_video';
    await postChat({ execution: 'client', media, messages: other }, IOS);
    expect(JSON.parse(toolSeenByModel(xaiCalls[0]))).toEqual(err);
    await postChat({ execution: 'client', media, messages: convo(err) });
    expect(JSON.parse(toolSeenByModel(xaiCalls[1]))).toEqual(err);
  });

  it('tool availability is unchanged by the rewrite: a generic failure leaves lyric_captions offered, same as an unrewritten run', async () => {
    reply = final;
    await postChat({ execution: 'client', media, messages: convo({ ok: false, error: 'boom' }) }, IOS);
    await postChat({ execution: 'client', media, messages: [{ role: 'user', content: 'hi' }] }, IOS);
    expect(offeredNames(xaiCalls[0])).toContain('lyric_captions');
    expect(offeredNames(xaiCalls[0])).toEqual(offeredNames(xaiCalls[1]));
  });

  it('the results really pass through the server loop: normalizeClientMessages is what builds the model messages', () => {
    const msgs = normalizeClientMessages(convo({ ok: false, error: 'x' }), { ios: true });
    expect(JSON.parse(msgs.at(-1).content).error).toBe(LYRIC_CAPTIONS_FAILED);
    expect(normalizeClientMessages(convo({ ok: false, error: 'x' })).at(-1).content).toBe('{"ok":false,"error":"x"}');
    expect(rewriteLyricCaptionsResult('{"ok":true}', { ios: true })).toBe('{"ok":true}');
  });
});
