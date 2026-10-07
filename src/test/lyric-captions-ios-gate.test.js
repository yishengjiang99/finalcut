// @vitest-environment node
// lyric_captions on iOS, gated on LYRIC_CAPTIONS_MIN_BUILD (a placeholder no real build reaches
// yet). Enabling = replacing that one constant; nothing here needs editing when it changes.
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
  LYRIC_CAPTIONS_IOS_DESCRIPTION,
  LYRIC_CAPTIONS_MIN_BUILD,
  isToolAllowedForIosBuild,
} from '../server/iosToolAllowlist.js';
import { assertOperationSupported } from '../server/ffmpegOps.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const snapshotFile = (name) => readFileSync(path.join(here, 'fixtures', 'tools-snapshots', `${name}.json`), 'utf8');
const ios = (build) => `FinalCap-iOS/${build}`;
const names = (list) => list.map(t => t.function.name);
const CUTOFF = LYRIC_CAPTIONS_MIN_BUILD;
const WEB_DEF = tools.find(t => t.function.name === 'lyric_captions');

// Same serialization as the fixture capture (ios-build12.json was taken on main at c938777).
function serialize(userAgent) {
  return JSON.stringify({
    schema: buildToolsSchema({ userAgent }),
    offered: Object.fromEntries(['any', 'video', 'image'].map(mt => [mt, offeredToolsFor({ userAgent, mediaType: mt === 'any' ? undefined : mt })])),
  });
}
// A build at or past the cutoff is compared with lyric_captions taken out again.
function withoutLyric(serialized) {
  const o = JSON.parse(serialized);
  const drop = (defs) => defs.filter(t => t.function.name !== 'lyric_captions');
  delete o.schema.mediaTypes.lyric_captions;
  o.schema.tools = drop(o.schema.tools);
  for (const k of Object.keys(o.offered)) o.offered[k] = drop(o.offered[k]);
  return JSON.stringify(o);
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

describe('the gate is one constant', () => {
  it('lyric_captions is allowlisted from LYRIC_CAPTIONS_MIN_BUILD, a placeholder above every real build', () => {
    expect(IOS_TOOL_ALLOWLIST.lyric_captions).toBe(CUTOFF);
    expect(Number.isSafeInteger(CUTOFF)).toBe(true);
    expect(CUTOFF).toBeGreaterThan(12);
    expect(isToolAllowedForIosBuild('lyric_captions', CUTOFF - 1)).toBe(false);
    expect(isToolAllowedForIosBuild('lyric_captions', CUTOFF)).toBe(true);
  });
});

describe('current builds are unchanged', () => {
  for (const build of [10, 12]) {
    it(`iOS/${build}: schema + offered lists byte-identical to the snapshot`, () => {
      const now = serialize(ios(build));
      expect(build < CUTOFF ? now : withoutLyric(now)).toBe(snapshotFile(`ios-build${build}`));
      if (build < CUTOFF) expect(now).not.toContain('lyric_captions');
    });
  }

  it('GET /api/tools/schema for iOS/10 and iOS/12: bodies byte-identical to the snapshots', async () => {
    for (const build of [10, 12]) {
      if (build >= CUTOFF) continue;
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

describe('builds at or past the cutoff', () => {
  const at = (build, mediaType) => offeredToolsFor({ userAgent: ios(build), mediaType });

  it('video: lyric_captions offered, right after generate_captions, with the iOS (client-executed) description', () => {
    for (const build of [CUTOFF, CUTOFF + 7]) {
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
    expect(WEB_DEF.function.description).toMatch(/burns two-line captions into the video/);
  });

  it('photo: not offered', () => {
    expect(names(at(CUTOFF, 'image'))).not.toContain('lyric_captions');
    expect(buildToolsSchema({ userAgent: ios(CUTOFF) }).mediaTypes.lyric_captions).toEqual(['video']);
  });

  it('the iOS description covers the flow: consent, audio only, drawn on device, skip when declined, no lyrics back', () => {
    for (const phrase of ['add lyrics captions', 'subtitle the song in Chinese', 'translate the lyrics on the video',
      'asks the user before uploading', 'only this video\'s audio (never the picture)', 'the app then draws',
      'nothing is uploaded and the step is skipped', 'never the lyrics', 'Videos only']) {
      expect(LYRIC_CAPTIONS_IOS_DESCRIPTION).toContain(phrase);
    }
  });

  it('GET /api/tools/schema: the cutoff build gets it (video only); cutoff-1 does not', async () => {
    const body = await (await realFetch(`${base}/api/tools/schema`, { headers: { 'User-Agent': ios(CUTOFF) } })).json();
    const def = body.tools.find(t => t.function.name === 'lyric_captions');
    expect(def.function.description).toBe(LYRIC_CAPTIONS_IOS_DESCRIPTION);
    expect(body.mediaTypes.lyric_captions).toEqual(['video']);
    const before = await (await realFetch(`${base}/api/tools/schema`, { headers: { 'User-Agent': ios(CUTOFF - 1) } })).json();
    expect(names(before.tools)).not.toContain('lyric_captions');
  });

  it('POST /api/chat execution:"client": offered for a video, not a photo, not below the cutoff', async () => {
    const chat = (ua, type) => realFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'sample-access-token': token, 'User-Agent': ua },
      body: JSON.stringify({ execution: 'client', media: { type }, messages: [{ role: 'user', content: 'subtitle the song in German and Chinese' }] }),
    });
    await chat(ios(CUTOFF), 'video');
    await chat(ios(CUTOFF), 'image');
    await chat(ios(12), 'video');
    const offered = xaiCalls.map(c => c.tools || []);
    const video = offered[0].find(t => t.function.name === 'lyric_captions');
    expect(video.function.description).toBe(LYRIC_CAPTIONS_IOS_DESCRIPTION);
    expect(names(offered[1])).not.toContain('lyric_captions');
    expect(names(offered[2])).not.toContain('lyric_captions');
  });
});

describe('the server never runs it for iOS', () => {
  it('POST /api/lyric-captions/:jobId/burn from an iOS client: 400 not_available_on_server (before any upload or job lookup)', async () => {
    const form = new FormData();
    form.append('video', new Blob([readFileSync(path.join(here, 'fixtures', 'silent-2s.mp4'))], { type: 'video/mp4' }), 'clip.mp4');
    const res = await realFetch(`${base}/api/lyric-captions/any-job/burn`, { method: 'POST', headers: { 'sample-access-token': token, 'User-Agent': ios(CUTOFF) }, body: form });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'not_available_on_server', operation: 'lyric_captions' });
    // Web (no iOS UA) still reaches the job lookup.
    const web = await realFetch(`${base}/api/lyric-captions/any-job/burn`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
    expect(web.status).toBe(404);
    expect((await web.json()).code).toBe('job_not_found');
  });

  it('process-video (job and sync): 400 not_available_on_server for a video, unsupported_for_photo for a photo', async () => {
    expect(() => assertOperationSupported('lyric_captions', 'video')).toThrow(expect.objectContaining({ code: 'not_available_on_server', statusCode: 400 }));
    expect(() => assertOperationSupported('lyric_captions', 'image')).toThrow(expect.objectContaining({ code: 'unsupported_for_photo' }));
    const job = (file, name, type) => {
      const form = new FormData();
      form.append('operation', 'lyric_captions');
      form.append('args', JSON.stringify({ target_language: 'zh-Hans' }));
      form.append('video', new Blob([readFileSync(path.join(here, 'fixtures', file))], { type }), name);
      return realFetch(`${base}/api/jobs/process-video`, { method: 'POST', headers: { 'sample-access-token': token, 'User-Agent': ios(CUTOFF) }, body: form });
    };
    const video = await job('silent-2s.mp4', 'clip.mp4', 'video/mp4');
    expect(video.status).toBe(400);
    expect(await video.json()).toMatchObject({ code: 'not_available_on_server', operation: 'lyric_captions', error: expect.stringMatching(/POST \/api\/lyric-captions/) });
    const photo = await job('photo-64x48.jpg', 'a.jpg', 'image/jpeg');
    expect(await photo.json()).toMatchObject({ code: 'unsupported_for_photo', operation: 'lyric_captions' });
    const sync = await realFetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: { 'sample-access-token': token, 'User-Agent': ios(CUTOFF), 'Content-Type': 'video/mp4', 'x-operation': 'lyric_captions', 'x-args': '{"target_language":"de"}' },
      body: readFileSync(path.join(here, 'fixtures', 'silent-2s.mp4')),
    });
    expect(sync.status).toBe(400);
    expect(await sync.json()).toMatchObject({ code: 'not_available_on_server', operation: 'lyric_captions' });
  });
});
