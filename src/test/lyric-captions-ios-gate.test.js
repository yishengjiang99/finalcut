// @vitest-environment node
// lyric_captions on iOS: offered to every FinalCap-iOS build, with no build gate.
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
  recordDailyInference: vi.fn(),
}));
vi.mock('../db.js', () => db);

import express from 'express';
import { chatRouter } from '../server/chat.js';
import { jobsRouter } from '../server/jobs.js';
import { videoRouter } from '../server/video.js';
import { lyricCaptionsRouter } from '../server/lyricCaptions.js';
import { issueSampleAccessToken, videoProcessLimiter, apiLimiter } from '../server/middleware.js';
import { buildToolsSchema, offeredToolsFor } from '../server/toolsSchema.js';
import { tools } from '../tools.js';
import {
  IOS_TOOL_ALLOWLIST,
  GENERATE_CAPTIONS_WITH_LYRIC_DESCRIPTION,
  LYRIC_CAPTIONS_IOS_DESCRIPTION,
  isToolAllowedForIosBuild,
} from '../server/iosToolAllowlist.js';
import { assertOperationSupported } from '../server/ffmpegOps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const snapshotFile = (name) => readFileSync(path.join(here, 'fixtures', 'tools-snapshots', `${name}.json`), 'utf8');
const ios = (build) => `FinalCap-iOS/${build}`;
const names = (list) => list.map(t => t.function.name);
const BUILDS = [10, 11, 12, 40]; // any build that sends the FinalCap-iOS user agent
const WEB_DEF = tools.find(t => t.function.name === 'lyric_captions');

// Same serialization as the fixture capture (ios-build12.json was taken on main at c938777).
function serialize(userAgent) {
  return JSON.stringify({
    schema: buildToolsSchema({ userAgent }),
    offered: Object.fromEntries(['any', 'video', 'image'].map(mt => [mt, offeredToolsFor({ userAgent, mediaType: mt === 'any' ? undefined : mt })])),
  });
}
let server;
let base;
let token;
const xaiCalls = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url).startsWith('https://api.x.ai/')) {
      xaiCalls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Answer:\nOk.' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, init);
  });
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(chatRouter);
  app.use(videoRouter);
  app.use(jobsRouter);
  app.use(lyricCaptionsRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  for (const limiter of [videoProcessLimiter, apiLimiter]) {
    for (const key of ['127.0.0.1', '::ffff:127.0.0.1']) await limiter.resetKey(key);
  }
  xaiCalls.length = 0;
  token = issueSampleAccessToken();
});

describe('no build gate', () => {
  it('lyric_captions is allowlisted at the same floor as the other iOS tools (build 10): no cutoff of its own', () => {
    expect(IOS_TOOL_ALLOWLIST.lyric_captions).toBe(10);
    expect(isToolAllowedForIosBuild('lyric_captions', 10)).toBe(true);
    expect(isToolAllowedForIosBuild('lyric_captions', 12)).toBe(true);
    expect(isToolAllowedForIosBuild('lyric_captions', 5000)).toBe(true);
    expect(isToolAllowedForIosBuild('lyric_captions', 9)).toBe(false); // below every entry: no allowlisted tools at all
  });
});

describe('snapshots', () => {
  for (const build of [10, 12]) {
    it(`iOS/${build}: schema + offered lists match the snapshot (which includes lyric_captions)`, () => {
      const now = serialize(ios(build));
      expect(now).toBe(snapshotFile(`ios-build${build}`));
      expect(now).toContain('lyric_captions');
    });
  }

  it('GET /api/tools/schema for iOS/10 and iOS/12: bodies match the snapshots', async () => {
    for (const build of [10, 12]) {
      const res = await realFetch(`${base}/api/tools/schema`, { headers: { 'User-Agent': ios(build) } });
      expect(await res.text()).toBe(JSON.stringify(JSON.parse(snapshotFile(`ios-build${build}`)).schema));
    }
  });

  it('web stays at 47 tools with the shared lyric_captions definition (server burn description)', () => {
    expect(JSON.parse(snapshotFile('web-no-ua')).schema.tools).toHaveLength(47);
    expect(serialize(undefined)).toBe(snapshotFile('web-no-ua'));
    expect(offeredToolsFor({})).toHaveLength(47);
    expect(offeredToolsFor({}).find(t => t.function.name === 'lyric_captions')).toBe(WEB_DEF);
    expect(WEB_DEF.function.description).not.toBe(LYRIC_CAPTIONS_IOS_DESCRIPTION);
    expect(readFileSync(path.join(repo, 'docs', 'api', 'tools-schema.v1.json'), 'utf8')).not.toContain('The app asks the user before uploading');
  });
});

describe('every iOS build', () => {
  const at = (build, mediaType) => offeredToolsFor({ userAgent: ios(build), mediaType });

  it('video: lyric_captions offered, right after generate_captions, with the iOS (client-executed) description', () => {
    for (const build of BUILDS) {
      const video = at(build, 'video');
      const n = names(video);
      expect(n).toContain('lyric_captions');
      expect(n.indexOf('lyric_captions')).toBe(n.indexOf('generate_captions') + 1);
      const def = video.find(t => t.function.name === 'lyric_captions');
      expect(def.function.description).toBe(LYRIC_CAPTIONS_IOS_DESCRIPTION);
      expect(def.function.parameters).toEqual(WEB_DEF.function.parameters);
      expect(names(at(build))).toContain('lyric_captions');
    }
    // The iOS copy is a separate object; the shared web definition is not mutated.
    expect(WEB_DEF.function.description).toMatch(/exports them as a subtitle track in the video file \(not burned into the picture\)/);
    expect(WEB_DEF.function.description).not.toMatch(/burns (the original|two-line)|are burned in when/);
    const gen = offeredToolsFor({}).find(t => t.function.name === 'generate_captions').function;
    expect(gen.description).toMatch(/exports them as a subtitle track in the video file \(not burned in\)/);
    expect(gen.description).toMatch(/frames in the browser/);
    expect(gen.description).not.toMatch(/call lyric_captions instead, which burns/);
  });

  it('generate_captions says "same-language only, translation goes to lyric_captions" on every build', () => {
    const desc = (b) => offeredToolsFor({ userAgent: ios(b), mediaType: 'video' }).find(t => t.function.name === 'generate_captions').function;
    for (const build of BUILDS) {
      expect(desc(build).description).toBe(GENERATE_CAPTIONS_WITH_LYRIC_DESCRIPTION);
      expect(desc(build).description).toMatch(/never translates/);
      expect(desc(build).description).toMatch(/call lyric_captions instead/);
      expect(desc(build).parameters.properties).not.toHaveProperty('translate_language');
    }
  });

  it('the iOS lyric_captions description covers plain speech and plain phrasing, in speech mode with zh-Hans', () => {
    for (const phrase of ['add Chinese captions', 'add captions in Chinese', 'Chinese subtitles',
      'translate the video into Chinese and burn the captions', 'mode "speech"', 'zh-Hans',
      'detected automatically', 'Use generate_captions only for same-language']) {
      expect(LYRIC_CAPTIONS_IOS_DESCRIPTION).toContain(phrase);
    }
  });

  it('photo: not offered', () => {
    expect(names(at(12, 'image'))).not.toContain('lyric_captions');
    expect(buildToolsSchema({ userAgent: ios(12) }).mediaTypes.lyric_captions).toEqual(['video']);
  });

  it('the iOS description covers the flow: consent, audio only, drawn on device, skip when declined, no lyrics back', () => {
    for (const phrase of ['add lyrics captions', 'subtitle the song in Chinese', 'translate the lyrics on the video',
      'asks the user before uploading', 'only this video\'s audio (never the picture)', 'the app then draws',
      'nothing is uploaded and the step is skipped', 'never the lyrics', 'Videos only']) {
      expect(LYRIC_CAPTIONS_IOS_DESCRIPTION).toContain(phrase);
    }
  });

  it('GET /api/tools/schema: build 10 and 12 get it (video only)', async () => {
    for (const build of [10, 12]) {
    const body = await (await realFetch(`${base}/api/tools/schema`, { headers: { 'User-Agent': ios(build) } })).json();
    const def = body.tools.find(t => t.function.name === 'lyric_captions');
    expect(def.function.description).toBe(LYRIC_CAPTIONS_IOS_DESCRIPTION);
    expect(body.mediaTypes.lyric_captions).toEqual(['video']);
    }
  });

  it('POST /api/chat execution:"client": offered for a video on every build, not for a photo', async () => {
    const chat = (ua, type) => realFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'sample-access-token': token, 'User-Agent': ua },
      body: JSON.stringify({ execution: 'client', media: { type }, messages: [{ role: 'user', content: 'subtitle the song in German and Chinese' }] }),
    });
    await chat(ios(12), 'video');
    await chat(ios(12), 'image');
    await chat(ios(10), 'video');
    const offered = xaiCalls.map(c => c.tools || []);
    const video = offered[0].find(t => t.function.name === 'lyric_captions');
    expect(video.function.description).toBe(LYRIC_CAPTIONS_IOS_DESCRIPTION);
    expect(names(offered[1])).not.toContain('lyric_captions');
    expect(names(offered[2])).toContain('lyric_captions');
  });
});

describe('the server never runs it for iOS', () => {
  it('POST /api/lyric-captions/:jobId/burn is gone for every client (404, no upload handled)', async () => {
    const form = new FormData();
    form.append('video', new Blob([readFileSync(path.join(here, 'fixtures', 'silent-2s.mp4'))], { type: 'video/mp4' }), 'clip.mp4');
    for (const headers of [{ 'sample-access-token': token, 'User-Agent': ios(12) }, { 'sample-access-token': token }]) {
      const res = await realFetch(`${base}/api/lyric-captions/any-job/burn`, { method: 'POST', headers, body: form });
      expect(res.status).toBe(404);
    }
  });

  it('process-video (job and sync): 400 not_available_on_server for a video, unsupported_for_photo for a photo', async () => {
    expect(() => assertOperationSupported('lyric_captions', 'video')).toThrow(expect.objectContaining({ code: 'not_available_on_server', statusCode: 400 }));
    expect(() => assertOperationSupported('lyric_captions', 'image')).toThrow(expect.objectContaining({ code: 'unsupported_for_photo' }));
    const job = (file, name, type) => {
      const form = new FormData();
      form.append('operation', 'lyric_captions');
      form.append('args', JSON.stringify({ target_language: 'zh-Hans' }));
      form.append('video', new Blob([readFileSync(path.join(here, 'fixtures', file))], { type }), name);
      return realFetch(`${base}/api/jobs/process-video`, { method: 'POST', headers: { 'sample-access-token': token, 'User-Agent': ios(12) }, body: form });
    };
    const video = await job('silent-2s.mp4', 'clip.mp4', 'video/mp4');
    expect(video.status).toBe(400);
    expect(await video.json()).toMatchObject({ code: 'not_available_on_server', operation: 'lyric_captions', error: expect.stringMatching(/POST \/api\/lyric-captions/) });
    const photo = await job('photo-64x48.jpg', 'a.jpg', 'image/jpeg');
    expect(await photo.json()).toMatchObject({ code: 'unsupported_for_photo', operation: 'lyric_captions' });
    const sync = await realFetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: { 'sample-access-token': token, 'User-Agent': ios(12), 'Content-Type': 'video/mp4', 'x-operation': 'lyric_captions', 'x-args': '{"target_language":"de"}' },
      body: readFileSync(path.join(here, 'fixtures', 'silent-2s.mp4')),
    });
    expect(sync.status).toBe(400);
    expect(await sync.json()).toMatchObject({ code: 'not_available_on_server', operation: 'lyric_captions' });
  });
});
