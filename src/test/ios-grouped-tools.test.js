// @vitest-environment node
// Build-gated iOS grouped effect tools (channel_mixer, color_adjust, ...), switched off for every
// real build until FinalCut iOS posts the first executor build (GROUPED_EFFECTS_MIN_BUILD).
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

import express from 'express';
import { chatRouter } from '../server/chat.js';
import { issueSampleAccessToken } from '../server/middleware.js';
import { buildToolsSchema, offeredToolsFor, toolsForMediaType } from '../server/toolsSchema.js';
import { tools } from '../tools.js';
import {
  GROUPED_EFFECTS_MIN_BUILD,
  IOS_TOOL_ALLOWLIST,
  filterToolsForUserAgent,
  iosBuildRange,
  isToolAllowedForIosBuild,
} from '../server/iosToolAllowlist.js';
import {
  APPLY_COLOR_FILTER_GROUPED_DESCRIPTION,
  APPLY_FILTER_CORE_IMAGE_NAMES,
  IOS_GROUPED_TOOLS,
  IOS_GROUPED_TOOL_MEDIA_TYPES,
  isIosGroupedTool,
} from '../server/iosGroupedTools.js';
import { assertOperationSupported, ERROR_CODES } from '../server/ffmpegOps.js';
import { classifyAndValidateUpload, jobsRouter } from '../server/jobs.js';
import { videoRouter } from '../server/video.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const readJson = (...p) => JSON.parse(readFileSync(path.join(repo, ...p), 'utf8'));
const snapshotFile = (name) => readFileSync(path.join(here, 'fixtures', 'tools-snapshots', `${name}.json`), 'utf8');

const ios = (build) => `FinalCap-iOS/${build}`;
const names = (list) => list.map(t => t.function.name);
const CUTOFF = GROUPED_EFFECTS_MIN_BUILD;
const GROUPED = ['channel_mixer', 'color_adjust', 'apply_filter', 'stylize', 'blur_sharpen', 'lut', 'vignette_grain', 'segment', 'audio_effect'];
const RETIRED = ['adjust_brightness', 'adjust_contrast', 'adjust_saturation', 'adjust_hue'];

// Same serialization as the fixture capture (taken on main before this change).
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
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  xaiCalls.length = 0;
  token = issueSampleAccessToken();
});

describe('snapshots: existing clients are byte-identical to main before the change', () => {
  const cases = { 'ios-build10': ios(10), 'web-no-ua': undefined, 'cfnetwork-build11': 'FinalCap/11 CFNetwork/1.0' };
  for (const [name, ua] of Object.entries(cases)) {
    it(`${name} (${ua ?? 'no UA'}): schema + offered lists (any/video/image) unchanged`, () => {
      expect(serialize(ua)).toBe(snapshotFile(name));
    });
  }

  it('counts: iOS/10 = 21 tools, web and FinalCap/11 CFNetwork = 46', () => {
    expect(JSON.parse(snapshotFile('ios-build10')).schema.tools).toHaveLength(21);
    expect(JSON.parse(snapshotFile('web-no-ua')).schema.tools).toHaveLength(46);
    expect(JSON.parse(snapshotFile('cfnetwork-build11')).schema.tools).toHaveLength(46);
  });

  it('build cutoff-1 is still exactly the build-10 list', () => {
    const at10 = JSON.parse(snapshotFile('ios-build10'));
    expect(JSON.stringify(buildToolsSchema({ userAgent: ios(CUTOFF - 1) }))).toBe(JSON.stringify(at10.schema));
    for (const mt of ['video', 'image']) {
      expect(JSON.stringify(offeredToolsFor({ userAgent: ios(CUTOFF - 1), mediaType: mt }))).toBe(JSON.stringify(at10.offered[mt]));
    }
  });

  it('web objects are the shared src/tools.js definitions (same references)', () => {
    expect(offeredToolsFor({})).toBe(tools);
    expect(offeredToolsFor({ userAgent: 'Mozilla/5.0' })).toBe(tools);
    expect(offeredToolsFor({ mediaType: 'image' })).toEqual(toolsForMediaType('image'));
    for (const g of GROUPED) expect(names(tools)).not.toContain(g);
  });

  it('docs/api/tools-schema.v1.json is unchanged (== generator output, no grouped tools)', () => {
    const committed = readFileSync(path.join(repo, 'docs', 'api', 'tools-schema.v1.json'), 'utf8');
    expect(committed).toBe(`${JSON.stringify(buildToolsSchema(), null, 2)}\n`);
    for (const g of GROUPED) expect(committed).not.toContain(`"${g}"`);
  });
});

describe('the cutoff build (computed from GROUPED_EFFECTS_MIN_BUILD)', () => {
  const build10 = names(offeredToolsFor({ userAgent: ios(10) }));

  it('gates the grouped tools and retirements on the one constant (enabling = editing it; build 10 never changes)', () => {
    expect(Number.isSafeInteger(CUTOFF)).toBe(true);
    expect(CUTOFF).toBeGreaterThan(10);
    for (const g of GROUPED) expect(IOS_TOOL_ALLOWLIST[g]).toBe(CUTOFF);
    for (const r of RETIRED) expect(iosBuildRange(IOS_TOOL_ALLOWLIST[r])).toEqual({ minBuild: 10, maxBuild: CUTOFF - 1 });
    expect(IOS_TOOL_ALLOWLIST.apply_color_filter).toBe(10); // kept
  });

  it('gets 26 tools: the 21 minus the four adjust_* plus the 9 grouped', () => {
    const offered = names(offeredToolsFor({ userAgent: ios(CUTOFF) }));
    expect(build10).toHaveLength(21);
    expect(offered).toEqual([...build10.filter(n => !RETIRED.includes(n)), ...GROUPED]);
    expect(offered).toHaveLength(26);
    expect(names(offeredToolsFor({ userAgent: ios(CUTOFF + 5) }))).toEqual(offered);
  });

  it('media types: photos get the 8 photo-capable grouped tools, not audio_effect', () => {
    const photo = names(offeredToolsFor({ userAgent: ios(CUTOFF), mediaType: 'image' }));
    const photo10 = names(offeredToolsFor({ userAgent: ios(10), mediaType: 'image' }));
    expect(photo).toEqual([...photo10.filter(n => !RETIRED.includes(n)), ...GROUPED.filter(g => g !== 'audio_effect')]);
    const video = names(offeredToolsFor({ userAgent: ios(CUTOFF), mediaType: 'video' }));
    for (const g of GROUPED) expect(video).toContain(g);
    for (const r of RETIRED) expect(video).not.toContain(r);
  });

  it('apply_color_filter gets the sharper description only from the cutoff', () => {
    const desc = (b) => offeredToolsFor({ userAgent: ios(b) }).find(t => t.function.name === 'apply_color_filter').function.description;
    const shared = tools.find(t => t.function.name === 'apply_color_filter').function.description;
    expect(desc(CUTOFF)).toBe(APPLY_COLOR_FILTER_GROUPED_DESCRIPTION);
    expect(desc(CUTOFF - 1)).toBe(shared);
    expect(desc(10)).toBe(shared);
    expect(tools.find(t => t.function.name === 'apply_color_filter').function.description).toBe(shared); // not mutated
  });

  it('non-iOS UAs never get grouped tools, whatever build they claim', () => {
    for (const ua of [undefined, 'Mozilla/5.0', `FinalCap/${CUTOFF} CFNetwork/1.0`, `finalcap-ios/${CUTOFF}`]) {
      const offered = names(offeredToolsFor({ userAgent: ua }));
      expect(offered).toHaveLength(46);
      for (const g of GROUPED) expect(offered).not.toContain(g);
    }
  });
});

describe('GET /api/tools/schema applies the same filtering', () => {
  const getSchema = (ua) => realFetch(`${base}/api/tools/schema`, { headers: ua ? { 'User-Agent': ua } : {} });

  it('iOS/10, web and FinalCap/11 CFNetwork: response bodies byte-identical to the snapshots', async () => {
    for (const [name, ua] of [['ios-build10', ios(10)], ['web-no-ua', undefined], ['cfnetwork-build11', 'FinalCap/11 CFNetwork/1.0']]) {
      const res = await getSchema(ua);
      expect(res.headers.get('vary')).toMatch(/User-Agent/i);
      expect(await res.text()).toBe(JSON.stringify(JSON.parse(snapshotFile(name)).schema));
    }
  });

  it('cutoff build: 26 tools, grouped mediaTypes, same as offeredToolsFor', async () => {
    const body = await (await getSchema(ios(CUTOFF))).json();
    expect(body.schemaVersion).toBe('1');
    expect(body.tools).toEqual(JSON.parse(JSON.stringify(offeredToolsFor({ userAgent: ios(CUTOFF) }))));
    expect(body.tools).toHaveLength(26);
    expect(Object.keys(body.mediaTypes)).toEqual(names(body.tools));
    expect(body.mediaTypes.audio_effect).toEqual(['video']);
    for (const g of GROUPED.filter(n => n !== 'audio_effect')) expect(body.mediaTypes[g]).toEqual(['video', 'image']);
    const before = await (await getSchema(ios(CUTOFF - 1))).json();
    expect(names(before.tools)).toHaveLength(21);
    expect(names(before.tools)).not.toContain('lut');
  });
});

describe('POST /api/chat execution:"client" offers the grouped tools only from the cutoff', () => {
  const chat = (ua, media) => realFetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'sample-access-token': token, 'User-Agent': ua },
    body: JSON.stringify({ execution: 'client', media: { type: media }, messages: [{ role: 'user', content: 'make it warmer' }] }),
  });

  it('video at cutoff: 9 grouped, no adjust_*; photo: no audio_effect; build 10: unchanged', async () => {
    await chat(ios(CUTOFF), 'video');
    expect(names(xaiCalls[0].tools)).toEqual(names(offeredToolsFor({ userAgent: ios(CUTOFF), mediaType: 'video' })));
    for (const g of GROUPED) expect(names(xaiCalls[0].tools)).toContain(g);
    for (const r of RETIRED) expect(names(xaiCalls[0].tools)).not.toContain(r);
    await chat(ios(CUTOFF), 'image');
    expect(names(xaiCalls[1].tools)).not.toContain('audio_effect');
    expect(names(xaiCalls[1].tools)).toContain('segment');
    await chat(ios(10), 'video');
    expect(JSON.stringify(xaiCalls[2].tools)).toBe(JSON.stringify(JSON.parse(snapshotFile('ios-build10')).offered.video));
  });
});

describe('maxBuild support (generic)', () => {
  const list = {
    open: 10,
    retired: { minBuild: 10, maxBuild: 11 },
    objectOpen: { minBuild: 12 },
    single: { minBuild: 13, maxBuild: 13 },
    empty: { minBuild: 5, maxBuild: 4 },
    badString: '10',
    badObject: { maxBuild: 20 },
    badMax: { minBuild: 1, maxBuild: 'x' },
  };
  const defs = Object.keys(list).map(name => ({ type: 'function', function: { name } }));
  const at = (b) => names(filterToolsForUserAgent(defs, ios(b), list));

  it('min and max are inclusive; open-ended entries work as numbers or objects', () => {
    expect(at(9)).toEqual([]);
    expect(at(10)).toEqual(['open', 'retired']);
    expect(at(11)).toEqual(['open', 'retired']);
    expect(at(12)).toEqual(['open', 'objectOpen']);
    expect(at(13)).toEqual(['open', 'objectOpen', 'single']);
    expect(at(14)).toEqual(['open', 'objectOpen']);
  });

  it('invalid entries and missing builds never match', () => {
    for (const b of [0, 5, 10, 20, 1e6]) {
      for (const n of ['empty', 'badString', 'badObject', 'badMax']) expect(isToolAllowedForIosBuild(n, b, list)).toBe(false);
    }
    expect(isToolAllowedForIosBuild('retired', null, list)).toBe(false);
    expect(isToolAllowedForIosBuild('retired', 10.5, list)).toBe(false);
    expect(iosBuildRange(7)).toEqual({ minBuild: 7, maxBuild: Infinity });
    expect(iosBuildRange({ minBuild: 7 })).toEqual({ minBuild: 7, maxBuild: Infinity });
    expect(iosBuildRange({ minBuild: 7, maxBuild: 9 })).toEqual({ minBuild: 7, maxBuild: 9 });
    expect(iosBuildRange(null)).toBeNull();
    expect(iosBuildRange(NaN)).toBeNull();
  });

  it('every real allowlist entry is valid', () => {
    for (const [name, entry] of Object.entries(IOS_TOOL_ALLOWLIST)) {
      expect(iosBuildRange(entry), name).not.toBeNull();
    }
  });
});

// ─── Schema shape ────────────────────────────────────────────────────────────
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
const KEYWORDS = new Set(['type', 'description', 'enum', 'default', 'minimum', 'maximum', 'minItems', 'maxItems', 'items', 'properties', 'required', 'additionalProperties']);

function checkSchema(schema, where) {
  expect(schema && typeof schema === 'object', where).toBe(true);
  for (const key of Object.keys(schema)) expect(KEYWORDS.has(key), `${where}: unexpected keyword ${key}`).toBe(true);
  expect(TYPES.has(schema.type), `${where}: type ${schema.type}`).toBe(true);
  if (schema.description !== undefined) expect(typeof schema.description, where).toBe('string');
  const valueOk = (v) => ({ string: typeof v === 'string', number: typeof v === 'number', integer: Number.isInteger(v), boolean: typeof v === 'boolean' }[schema.type] ?? true);
  if (schema.enum) {
    expect(Array.isArray(schema.enum) && schema.enum.length > 0, where).toBe(true);
    expect(new Set(schema.enum).size, `${where}: duplicate enum values`).toBe(schema.enum.length);
    for (const v of schema.enum) expect(valueOk(v), `${where}: enum ${v}`).toBe(true);
  }
  if ('minimum' in schema || 'maximum' in schema) {
    expect(['number', 'integer'], where).toContain(schema.type);
    if ('minimum' in schema && 'maximum' in schema) expect(schema.minimum, where).toBeLessThanOrEqual(schema.maximum);
  }
  if ('default' in schema) {
    expect(valueOk(schema.default), `${where}: default type`).toBe(true);
    if (schema.enum) expect(schema.enum, where).toContain(schema.default);
    if ('minimum' in schema) expect(schema.default, where).toBeGreaterThanOrEqual(schema.minimum);
    if ('maximum' in schema) expect(schema.default, where).toBeLessThanOrEqual(schema.maximum);
  }
  if (schema.type === 'array') {
    checkSchema(schema.items, `${where}[]`);
    if ('minItems' in schema && 'maxItems' in schema) expect(schema.minItems, where).toBeLessThanOrEqual(schema.maxItems);
  } else {
    expect('items' in schema || 'minItems' in schema || 'maxItems' in schema, `${where}: array keywords on ${schema.type}`).toBe(false);
  }
  if (schema.type === 'object') {
    for (const [k, v] of Object.entries(schema.properties || {})) checkSchema(v, `${where}.${k}`);
    if (typeof schema.additionalProperties === 'object') checkSchema(schema.additionalProperties, `${where}.*`);
    for (const r of schema.required || []) expect(Object.keys(schema.properties || {}), where).toContain(r);
  } else {
    expect('properties' in schema || 'required' in schema || 'additionalProperties' in schema, where).toBe(false);
  }
}

describe('grouped tool definitions', () => {
  const byName = Object.fromEntries(IOS_GROUPED_TOOLS.map(t => [t.function.name, t.function]));
  const proposal = readJson('docs', 'ios', 'data', 'proposed-tools-build11.json');

  it('are the 9 tools, frozen, with the same shape as src/tools.js entries', () => {
    expect(names(IOS_GROUPED_TOOLS)).toEqual(GROUPED);
    expect(Object.keys(IOS_GROUPED_TOOL_MEDIA_TYPES)).toEqual(GROUPED);
    expect(Object.isFrozen(IOS_GROUPED_TOOLS[0].function.parameters.properties)).toBe(true);
    for (const t of IOS_GROUPED_TOOLS) {
      expect(Object.keys(t)).toEqual(Object.keys(tools[0]));
      expect(Object.keys(t.function)).toEqual(Object.keys(tools[0].function));
      expect(t.type).toBe('function');
      expect(t.function.name).toMatch(/^[a-z][a-z_]*$/);
      expect(t.function.description.length).toBeGreaterThan(50);
      expect(Array.isArray(t.function.parameters.required)).toBe(true);
      checkSchema(t.function.parameters, t.function.name);
      expect(t.function.parameters.type).toBe('object');
      expect(isIosGroupedTool(t.function.name)).toBe(true);
    }
    expect(isIosGroupedTool('trim_video')).toBe(false);
    expect(isIosGroupedTool('hasOwnProperty')).toBe(false);
  });

  it('every tool takes intensity 0..1 (default 0.5) with the 0.25 / 0.5 / 0.8 guidance', () => {
    for (const t of IOS_GROUPED_TOOLS) {
      const intensity = t.function.parameters.properties.intensity;
      expect(intensity, t.function.name).toMatchObject({ type: 'number', minimum: 0, maximum: 1, default: 0.5 });
      expect(intensity.description).toMatch(/0\.25.*a bit.*0\.5.*0\.8.*a lot/);
      expect(t.function.description).toMatch(/intensity 0\.25 for 'a bit'.*0\.5 when no strength is given, 0\.8 for 'a lot'\/'very'/);
    }
  });

  it('parameters and media types match docs/ios/data/proposed-tools-build11.json exactly', () => {
    expect(proposal.tools.map(t => t.function.name)).toEqual(GROUPED);
    for (const p of proposal.tools) {
      const ours = byName[p.function.name];
      expect(JSON.parse(JSON.stringify(ours.parameters)), p.function.name).toEqual(p.function.parameters);
      // Descriptions: the proposal's text (+ "cartoon" for stylize), then the intensity sentence.
      const base = ours.description.replace(' (cartoon)', '').replace(" or 'cartoon'", '');
      expect(base.startsWith(p.function.description), p.function.name).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(IOS_GROUPED_TOOL_MEDIA_TYPES))).toEqual(proposal.mediaTypes);
    expect(APPLY_COLOR_FILTER_GROUPED_DESCRIPTION).toBe(proposal.iosOverrides.apply_color_filter.description);
  });

  it('channel_mixer presets include remove_red, swap_rb, isolate_green and grayscale by channel', () => {
    const presets = byName.channel_mixer.parameters.properties.preset.enum;
    for (const p of ['remove_red', 'swap_rb', 'isolate_green', 'grayscale_by_red', 'grayscale_by_green', 'grayscale_by_blue']) expect(presets).toContain(p);
  });

  it('color_adjust takes a list of plain-word changes plus intensity', () => {
    const { adjust } = byName.color_adjust.parameters.properties;
    expect(adjust.type).toBe('array');
    expect(adjust.items.enum).toEqual(expect.arrayContaining(['warmer', 'cooler', 'more_contrast', 'brighter', 'less_saturation']));
    expect(byName.color_adjust.parameters.required).toEqual(['adjust']);
  });

  it('apply_filter allows only the allowlisted Core Image effects from ON_DEVICE_TOOLS.md §9.3', () => {
    const doc = readFileSync(path.join(repo, 'docs', 'ios', 'ON_DEVICE_TOOLS.md'), 'utf8');
    const table = doc.slice(doc.indexOf('<!-- BEGIN GENERATED:apply-filter -->'), doc.indexOf('<!-- END GENERATED:apply-filter -->'));
    const documented = Object.fromEntries([...table.matchAll(/^\| `(\w+)` \| `(CI\w+)` \|/gm)].map(m => [m[1], m[2]]));
    expect(Object.keys(documented)).toHaveLength(34);
    expect({ ...APPLY_FILTER_CORE_IMAGE_NAMES }).toEqual(documented);
    expect(byName.apply_filter.parameters.properties.name.enum).toEqual(Object.keys(documented));
    for (const dump of ['cifilters-ios17.5.json', 'cifilters-ios26.5.json']) {
      const { filters } = readJson('docs', 'ios', 'data', dump);
      for (const ci of Object.values(documented)) expect(filters, `${ci} in ${dump}`).toHaveProperty(ci);
    }
  });

  it('each look word belongs to exactly one tool', () => {
    const colorFilter = tools.find(t => t.function.name === 'apply_color_filter').function.parameters.properties.filter.enum;
    const owners = {
      apply_color_filter: colorFilter,
      lut: byName.lut.parameters.properties.preset.enum,
      stylize: byName.stylize.parameters.properties.preset.enum,
      apply_filter: byName.apply_filter.parameters.properties.name.enum,
      channel_mixer: byName.channel_mixer.parameters.properties.preset.enum,
      color_adjust: byName.color_adjust.parameters.properties.adjust.items.enum,
      blur_sharpen: byName.blur_sharpen.parameters.properties.mode.enum,
      vignette_grain: byName.vignette_grain.parameters.properties.effect.enum,
      segment: byName.segment.parameters.properties.action.enum,
    };
    const seen = {};
    for (const [tool, words] of Object.entries(owners)) {
      for (const w of words) {
        expect(seen[w], `"${w}" is in ${seen[w]} and ${tool}`).toBeUndefined();
        seen[w] = tool;
      }
    }
    for (const w of ['noir', 'chrome', 'fade', 'instant', 'process', 'tonal', 'mono']) expect(seen[w]).toBe('lut');
    for (const w of ['sepia', 'vintage']) expect(seen[w]).toBe('apply_color_filter');
  });

  it('descriptions route plain phrasing to the right tool', () => {
    const d = (n) => byName[n].description;
    expect(d('channel_mixer')).toContain("'remove the red channel'");
    expect(d('color_adjust')).toContain("'make it warmer'");
    expect(d('segment')).toContain("'blur the background'");
    expect(d('blur_sharpen')).toContain('To blur only the background behind a person use segment');
    expect(d('audio_effect')).toContain("'add reverb'");
    expect(d('audio_effect')).toMatch(/Videos only \(not photos\)/);
    expect(d('lut')).toMatch(/'sepia'.*apply_color_filter, not this tool/);
    expect(d('stylize')).toMatch(/noir, chrome, fade, instant, cinematic\) use lut/);
  });
});

describe('cloud runs of grouped tools return a clear error (no FFmpeg executor)', () => {
  it('assertOperationSupported: not_available_on_server, or unsupported_for_photo for audio_effect on a photo', () => {
    for (const g of GROUPED) {
      expect(() => assertOperationSupported(g, 'video')).toThrow(expect.objectContaining({ code: ERROR_CODES.NOT_AVAILABLE_ON_SERVER, statusCode: 400 }));
    }
    for (const g of GROUPED.filter(n => n !== 'audio_effect')) {
      expect(() => assertOperationSupported(g, 'image')).toThrow(expect.objectContaining({ code: 'not_available_on_server' }));
    }
    expect(() => assertOperationSupported('audio_effect', 'image')).toThrow(expect.objectContaining({ code: 'unsupported_for_photo' }));
    expect(() => assertOperationSupported('apply_color_filter', 'image')).not.toThrow();
    expect(() => assertOperationSupported('trim_video', 'video')).not.toThrow();
  });

  it('POST /api/jobs/process-video: 400 not_available_on_server (video) / unsupported_for_photo (audio_effect on a photo)', async () => {
    const post = (file, name, type, operation) => {
      const form = new FormData();
      form.append('operation', operation);
      form.append('args', JSON.stringify({ intensity: 0.5 }));
      form.append('video', new Blob([readFileSync(path.join(here, 'fixtures', file))], { type }), name);
      return realFetch(`${base}/api/jobs/process-video`, { method: 'POST', headers: { 'sample-access-token': token }, body: form });
    };
    const lut = await post('silent-2s.mp4', 'clip.mp4', 'video/mp4', 'lut');
    expect(lut.status).toBe(400);
    expect(await lut.json()).toEqual({
      error: 'Operation "lut" runs only on the FinalCap iOS device and is not available on the server',
      code: 'not_available_on_server',
      operation: 'lut',
    });
    const audio = await post('photo-64x48.jpg', 'a.jpg', 'image/jpeg', 'audio_effect');
    expect(audio.status).toBe(400);
    expect(await audio.json()).toMatchObject({ code: 'unsupported_for_photo', operation: 'audio_effect', mediaType: 'image' });
    const mixer = await post('photo-64x48.jpg', 'a.jpg', 'image/jpeg', 'channel_mixer');
    expect(await mixer.json()).toMatchObject({ code: 'not_available_on_server', operation: 'channel_mixer' });
  });

  it('sync POST /api/process-video (streaming): 400 not_available_on_server for a video', async () => {
    const res = await realFetch(`${base}/api/process-video`, {
      method: 'POST',
      headers: { 'sample-access-token': token, 'Content-Type': 'video/mp4', 'x-operation': 'color_adjust', 'x-args': '{"adjust":["warmer"]}' },
      body: readFileSync(path.join(here, 'fixtures', 'silent-2s.mp4')),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'not_available_on_server', operation: 'color_adjust' });
  });

  it('classifyAndValidateUpload rejects before any FFmpeg work', async () => {
    const buffer = readFileSync(path.join(here, 'fixtures', 'photo-64x48.jpg'));
    await expect(classifyAndValidateUpload({ buffer, mimetype: 'image/jpeg', filename: 'a.jpg', operation: 'segment', args: {} }))
      .rejects.toMatchObject({ statusCode: 400, code: 'not_available_on_server' });
  });
});
