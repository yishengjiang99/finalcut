// @vitest-environment node
// GET /api/ios/suggestions: server-driven suggestion pills for the FinalCap iOS app.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { tools } from '../tools.js';
import { GROUPED_EFFECTS_MIN_BUILD } from '../server/iosToolAllowlist.js';
import {
  DEFAULT_SUGGESTIONS_PATH,
  FALLBACK_BUILD,
  createIosSuggestionsRouter,
  createSuggestionsStore,
  iosToolNamesFor,
  iosSuggestionsRouter,
  parseSuggestionBuild,
  suggestionsFor,
  validateSuggestionsConfig,
} from '../server/iosSuggestions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GROUPED_FIXTURE = path.join(here, 'fixtures', 'ios-suggestions-grouped.json');
const CUTOFF = GROUPED_EFFECTS_MIN_BUILD;
const VIDEO_IDS = ['v-captions', 'v-trim-15', 'v-title', 'v-vertical', 'v-slowmo', 'v-speed-2x', 'v-warm', 'v-mute'];
const PHOTO_IDS = ['p-bw', 'p-brighten', 'p-vivid', 'p-warm', 'p-square', 'p-text'];
const noLimit = (req, res, next) => next();
const ids = (body) => body.suggestions.map(s => s.id);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ios-suggestions-'));
const logger = { warn: vi.fn() };
let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(createIosSuggestionsRouter({ store: createSuggestionsStore({ checkIntervalMs: 0, logger }), limiter: noLimit }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.IOS_SUGGESTIONS_PATH;
  logger.warn.mockClear();
});

const get = (query = '') => fetch(`${base}/api/ios/suggestions${query}`);
const getJson = async (query) => (await get(query)).json();

function writeOverride(name, content, mtimeSeconds) {
  const file = path.join(tmp, name);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  if (mtimeSeconds) utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

describe('default config (config/ios-suggestions.json, FinalCut Design set)', () => {
  const raw = JSON.parse(readFileSync(DEFAULT_SUGGESTIONS_PATH, 'utf8'));

  it('build 12 video: all 8 pills, in config order, public fields only', async () => {
    const res = await get('?build=12&media=video');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(ids(body)).toEqual(VIDEO_IDS);
    expect(body.suggestions).toEqual(raw.video.map(({ id, label, prompt, icon }) => ({ id, label, prompt, icon })));
    expect(body.ttl).toBe(3600);
  });

  it('build 12 photo: all 6 pills, in config order, no video pills', async () => {
    const body = await getJson('?build=12&media=photo');
    expect(ids(body)).toEqual(PHOTO_IDS);
    expect(body.suggestions).toEqual(raw.photo.map(({ id, label, prompt, icon }) => ({ id, label, prompt, icon })));
    for (const id of ids(body)) expect(id.startsWith('v-')).toBe(false);
  });

  it('media defaults to video when missing or invalid', async () => {
    for (const q of ['?build=12', '?build=12&media=image', '?build=12&media=PHOTO', '']) {
      expect(ids(await getJson(q))).toEqual(VIDEO_IDS);
    }
  });

  it('missing / non-numeric build uses build-10 filtering (same lists as build 10 and 12)', async () => {
    expect(parseSuggestionBuild(undefined)).toBe(FALLBACK_BUILD);
    for (const b of ['', 'abc', '12abc', '-3', '1.5', ' ', '1e3']) expect(parseSuggestionBuild(b)).toBe(10);
    expect(parseSuggestionBuild('12')).toBe(12);
    for (const q of ['?media=photo', '?build=abc&media=photo', '?build=&media=photo', '?build=10&media=photo']) {
      expect(ids(await getJson(q))).toEqual(PHOTO_IDS);
    }
    for (const q of ['?media=video', '?build=x1&media=video', '?build=10']) {
      expect(ids(await getJson(q))).toEqual(VIDEO_IDS);
    }
  });

  it('any-of: p-brighten and p-vivid show at build 12 and at GROUPED_EFFECTS_MIN_BUILD (adjust_* retired, color_adjust on)', async () => {
    const atCutoff = iosToolNamesFor(CUTOFF, 'photo');
    expect(atCutoff.has('adjust_brightness')).toBe(false);
    expect(atCutoff.has('adjust_saturation')).toBe(false);
    expect(atCutoff.has('color_adjust')).toBe(true);
    const at12 = iosToolNamesFor(12, 'photo');
    expect(at12.has('adjust_brightness') && at12.has('adjust_saturation') && !at12.has('color_adjust')).toBe(true);
    for (const build of [12, CUTOFF]) {
      const got = ids(await getJson(`?build=${build}&media=photo`));
      expect(got).toContain('p-brighten');
      expect(got).toContain('p-vivid');
      expect(got).toEqual(PHOTO_IDS);
    }
    expect(ids(await getJson(`?build=${CUTOFF}&media=video`))).toEqual(VIDEO_IDS);
  });

  it('a build with no on-device tools (9) gets no pills', async () => {
    expect(await getJson('?build=9&media=photo')).toEqual({ suggestions: [], ttl: 3600 });
  });

  it('Cache-Control: public, max-age=<ttl>; body is exactly { suggestions, ttl }', async () => {
    const res = await get('?build=12&media=video');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const text = await res.text();
    expect(Object.keys(JSON.parse(text))).toEqual(['suggestions', 'ttl']);
    for (const internal of ['"tools"', '"media"', '"minBuild"', '"maxBuild"']) expect(text).not.toContain(internal);
  });

  it('every entry is valid, with no warnings; pills map to real tool arguments', () => {
    const warn = vi.fn();
    const config = validateSuggestionsConfig(raw, { warn });
    expect(warn).not.toHaveBeenCalled();
    expect(config.video.map(e => e.id)).toEqual(VIDEO_IDS);
    expect(config.photo.map(e => e.id)).toEqual(PHOTO_IDS);
    const prop = (tool, param) => tools.find(t => t.function.name === tool).function.parameters.properties[param];
    expect(prop('apply_color_filter', 'filter').enum).toEqual(expect.arrayContaining(['warm', 'grayscale', 'black_and_white']));
    expect(prop('resize_video_preset', 'preset').enum).toEqual(expect.arrayContaining(['9:16', '1:1']));
    expect(prop('adjust_audio_volume', 'volume').type).toBe('number');
    expect(prop('adjust_speed', 'speed').type).toBe('number');
    expect(prop('trim_video', 'end')).toBeDefined();
  });

  it('the exported router (own rate limiter) serves the default config', async () => {
    const app = express();
    app.use(iosSuggestionsRouter);
    const s = await new Promise((resolve) => { const x = app.listen(0, '127.0.0.1', () => resolve(x)); });
    const body = await (await fetch(`http://127.0.0.1:${s.address().port}/api/ios/suggestions?build=12&media=photo`)).json();
    await new Promise((resolve) => s.close(resolve));
    expect(ids(body)).toEqual(PHOTO_IDS);
  });
});

describe('filtering with a test-only config (grouped tools, build bounds, media)', () => {
  const config = validateSuggestionsConfig(JSON.parse(readFileSync(GROUPED_FIXTURE, 'utf8')));
  const at = (build, media) => suggestionsFor(config, { build, media }).map(s => s.id);

  it('a pill needing a grouped tool is hidden for build 12 and shown at GROUPED_EFFECTS_MIN_BUILD', () => {
    expect(at(12, 'photo')).toEqual(['t-text']);
    expect(at(CUTOFF - 1, 'photo')).toEqual(['t-text']);
    expect(at(CUTOFF, 'photo')).toEqual(['t-grade', 't-text']);
  });

  it('video-only tools never show for photos, even when the build has them', () => {
    expect(at(CUTOFF, 'photo')).not.toContain('t-reverb-photo');
    expect(at(CUTOFF, 'video')).toContain('t-reverb');
    expect(at(12, 'video')).not.toContain('t-reverb');
  });

  it('minBuild / maxBuild are inclusive; a missing build is treated as 10', async () => {
    expect(at(10, 'video')).toEqual(['t-trim', 't-max11']);
    expect(at(11, 'video')).toEqual(['t-trim', 't-min11', 't-max11']);
    expect(at(12, 'video')).toEqual(['t-trim', 't-min11']);
    process.env.IOS_SUGGESTIONS_PATH = GROUPED_FIXTURE;
    expect(ids(await getJson('?media=video'))).toEqual(['t-trim', 't-max11']);
    expect(ids(await getJson('?build=nope'))).toEqual(['t-trim', 't-max11']);
  });

  it('any-of: one available tool is enough', () => {
    const c = validateSuggestionsConfig({ video: [{ id: 'x', label: 'X', prompt: 'x', tools: ['audio_effect', 'trim_video'] }] });
    expect(suggestionsFor(c, { build: 12, media: 'video' }).map(s => s.id)).toEqual(['x']);
    const none = validateSuggestionsConfig({ video: [{ id: 'y', label: 'Y', prompt: 'y', tools: ['audio_effect', 'lut'] }] });
    expect(suggestionsFor(none, { build: 12, media: 'video' })).toEqual([]);
  });

  it('icon is omitted when absent', () => {
    expect(suggestionsFor(config, { build: 12, media: 'video' })[0]).toEqual({ id: 't-trim', label: 'Trim', prompt: 'Trim the video to the first 5 seconds.' });
  });
});

describe('IOS_SUGGESTIONS_PATH live override', () => {
  const one = (id, extra = {}) => ({ ttl: 60, video: [{ id, label: id, prompt: `Do ${id}.`, tools: ['trim_video'], ...extra }], photo: [] });

  it('takes effect, and an edit (new mtime) applies without restart', async () => {
    const file = writeOverride('override.json', one('first'), 1_700_000_000);
    process.env.IOS_SUGGESTIONS_PATH = file;
    const res = await get('?build=12');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual({ suggestions: [{ id: 'first', label: 'first', prompt: 'Do first.' }], ttl: 60 });
    writeOverride('override.json', one('second'), 1_700_000_100);
    expect(ids(await getJson('?build=12'))).toEqual(['second']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stat is rate-limited by the check interval', () => {
    const file = writeOverride('interval.json', one('a'), 1_700_000_000);
    let clock = 0;
    const store = createSuggestionsStore({ overridePath: () => file, checkIntervalMs: 5000, now: () => clock, logger });
    expect(store.get().video[0].id).toBe('a');
    writeOverride('interval.json', one('b'), 1_700_000_200);
    clock = 4999;
    expect(store.get().video[0].id).toBe('a');
    clock = 5000;
    expect(store.get().video[0].id).toBe('b');
  });

  it('bad override (invalid JSON, wrong shape, missing file, nothing valid) → repo default, 200, warning', async () => {
    const cases = [
      writeOverride('broken.json', '{"video": [ nope'),
      writeOverride('shape.json', { video: 'x' }),
      writeOverride('empty-object.json', {}),
      writeOverride('all-invalid.json', { video: [{ id: '', label: 'x', prompt: 'x', tools: ['trim_video'] }, { id: 'z', label: 'z', prompt: 'z', tools: ['not_a_tool'] }] }),
      path.join(tmp, 'does-not-exist.json'),
    ];
    for (const file of cases) {
      logger.warn.mockClear();
      process.env.IOS_SUGGESTIONS_PATH = file;
      const res = await get('?build=12&media=photo');
      expect(res.status, file).toBe(200);
      expect(ids(await res.json()), file).toEqual(PHOTO_IDS);
      expect(logger.warn, file).toHaveBeenCalledWith(expect.stringContaining(`override ${file} unusable`));
    }
  });

  it('a broken edit falls back, and fixing it again applies', async () => {
    const file = writeOverride('flip.json', one('good'), 1_700_000_000);
    process.env.IOS_SUGGESTIONS_PATH = file;
    expect(ids(await getJson('?build=12'))).toEqual(['good']);
    writeOverride('flip.json', '{oops', 1_700_000_100);
    expect(ids(await getJson('?build=12'))).toEqual(VIDEO_IDS);
    writeOverride('flip.json', one('fixed'), 1_700_000_200);
    expect(ids(await getJson('?build=12'))).toEqual(['fixed']);
  });

  it('invalid entries are skipped with a warning, valid ones kept (in order)', async () => {
    const file = writeOverride('mixed.json', {
      ttl: 3600,
      video: [
        { id: 'ok-1', label: 'One', prompt: 'One.', tools: ['trim_video'] },
        { id: 'long', label: 'This label is far too long for a pill', prompt: 'x', tools: ['trim_video'] },
        { id: 'unknown', label: 'U', prompt: 'x', tools: ['make_magic'] },
        { id: 'ok-1', label: 'Dup', prompt: 'x', tools: ['trim_video'] },
        { id: 'noprompt', label: 'N', prompt: ' ', tools: ['trim_video'] },
        { id: 'notools', label: 'T', prompt: 'x', tools: [] },
        { id: 'ok-2', label: 'Two', prompt: 'Two.', icon: 'star', tools: ['color_adjust', 'add_text'] },
      ],
    });
    process.env.IOS_SUGGESTIONS_PATH = file;
    const body = await getJson('?build=12');
    expect(body.suggestions).toEqual([
      { id: 'ok-1', label: 'One', prompt: 'One.' },
      { id: 'ok-2', label: 'Two', prompt: 'Two.', icon: 'star' },
    ]);
    const warnings = logger.warn.mock.calls.map(c => c[0]).join('\n');
    for (const w of ['label longer than 24', 'unknown tools: make_magic', 'duplicate id "ok-1"', 'prompt must be', 'tools must be a non-empty array']) {
      expect(warnings).toContain(w);
    }
  });

  it('also accepts the { suggestions: [{ media: [...] }] } format; an empty list turns pills off', () => {
    const c = validateSuggestionsConfig({ suggestions: [
      { id: 'both', label: 'Both', prompt: 'x', media: ['video', 'photo'], tools: ['add_text'] },
      { id: 'vid', label: 'Vid', prompt: 'x', media: ['video'], tools: ['trim_video'] },
    ] });
    expect(c.video.map(e => e.id)).toEqual(['both', 'vid']);
    expect(c.photo.map(e => e.id)).toEqual(['both']);
    expect(validateSuggestionsConfig({ ttl: 10, video: [], photo: [] })).toEqual({ ttl: 10, video: [], photo: [] });
  });
});
