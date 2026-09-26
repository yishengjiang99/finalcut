// Server-driven suggestion pills for the FinalCap iOS app: GET /api/ios/suggestions.
//
// Config: config/ios-suggestions.json (repo default), or the file named by IOS_SUGGESTIONS_PATH
// (live override kept OUTSIDE the app dir, which deploys wipe). The override is re-read when its
// mtime/size changes (stat at most every CHECK_INTERVAL_MS); a missing/invalid override falls back
// to the repo default with a warning, never a 500. See docs/api/IOS_SUGGESTIONS.md.
//
// A pill is returned for ?build=<n>&media=video|photo when it is in that media's list, the build
// is inside its optional minBuild/maxBuild, and AT LEAST ONE of its `tools` is offered to that
// FinalCap-iOS build for that media (same allowlist/media filtering as /api/chat and
// /api/tools/schema, via offeredToolsFor). Internal fields (tools, media, minBuild, maxBuild)
// are never sent.

import express from 'express';
import rateLimit from 'express-rate-limit';
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tools } from '../tools.js';
import { IOS_GROUPED_TOOLS } from './iosGroupedTools.js';
import { offeredToolsFor } from './toolsSchema.js';

export const DEFAULT_SUGGESTIONS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'ios-suggestions.json');
export const DEFAULT_TTL = 3600;
export const MAX_TTL = 86400;
export const MAX_LABEL_LENGTH = 24;
export const MAX_PROMPT_LENGTH = 500;
export const CHECK_INTERVAL_MS = 5000;
/** Missing / non-numeric build → the smallest native on-device tool set. */
export const FALLBACK_BUILD = 10;
export const MEDIA = Object.freeze(['video', 'photo']);

/** Every tool name a pill may list: src/tools.js plus the iOS-only grouped tools (gated separately). */
export const KNOWN_TOOL_NAMES = Object.freeze(new Set([...tools, ...IOS_GROUPED_TOOLS].map(t => t.function.name)));

const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isBuildBound = (v) => v === undefined || (Number.isSafeInteger(v) && v >= 0);

/** Validate one entry; returns an error string or null. */
function entryError(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  if (!nonEmptyString(entry.id)) return 'id must be a non-empty string';
  if (!nonEmptyString(entry.label)) return 'label must be a non-empty string';
  if (entry.label.length > MAX_LABEL_LENGTH) return `label longer than ${MAX_LABEL_LENGTH} characters`;
  if (!nonEmptyString(entry.prompt)) return 'prompt must be a non-empty string';
  if (entry.prompt.length > MAX_PROMPT_LENGTH) return `prompt longer than ${MAX_PROMPT_LENGTH} characters`;
  if (entry.icon !== undefined && !nonEmptyString(entry.icon)) return 'icon must be a non-empty string when present';
  if (!Array.isArray(entry.tools) || entry.tools.length === 0) return 'tools must be a non-empty array';
  const unknown = entry.tools.filter(t => !KNOWN_TOOL_NAMES.has(t));
  if (unknown.length) return `unknown tools: ${unknown.map(String).join(', ')}`;
  if (!isBuildBound(entry.minBuild) || !isBuildBound(entry.maxBuild)) return 'minBuild/maxBuild must be non-negative integers';
  return null;
}

function normalizeEntry(entry) {
  const out = { id: entry.id, label: entry.label, prompt: entry.prompt, tools: [...entry.tools] };
  if (entry.icon !== undefined) out.icon = entry.icon;
  if (entry.minBuild !== undefined) out.minBuild = entry.minBuild;
  if (entry.maxBuild !== undefined) out.maxBuild = entry.maxBuild;
  return out;
}

/**
 * Parse + validate a config object. Shape: `{ ttl, video: [...], photo: [...] }` (media from the
 * array), and/or the older `{ suggestions: [{ ..., media: ["video","photo"] }] }`.
 * Invalid entries are skipped with a warning. Throws when the file as a whole is unusable.
 * @returns {{ ttl: number, video: object[], photo: object[] }}
 */
export function validateSuggestionsConfig(raw, { warn = () => {}, source = 'config' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('top level must be an object');
  const hasMediaArrays = MEDIA.some(m => m in raw);
  if (!hasMediaArrays && !('suggestions' in raw)) throw new Error('expected "video"/"photo" arrays (or "suggestions")');
  for (const key of [...MEDIA, 'suggestions']) {
    if (key in raw && !Array.isArray(raw[key])) throw new Error(`"${key}" must be an array`);
  }
  let ttl = DEFAULT_TTL;
  if (raw.ttl !== undefined) {
    if (Number.isSafeInteger(raw.ttl) && raw.ttl >= 0 && raw.ttl <= MAX_TTL) ttl = raw.ttl;
    else warn(`[ios-suggestions] ${source}: ttl must be an integer 0..${MAX_TTL}; using ${DEFAULT_TTL}`);
  }
  const lists = { video: [], photo: [] };
  const seen = { video: new Set(), photo: new Set() };
  let given = 0;
  const add = (media, entry, where) => {
    given += 1;
    const error = entryError(entry);
    if (error) return warn(`[ios-suggestions] ${source}: skipping ${where}${entry?.id ? ` ("${entry.id}")` : ''}: ${error}`);
    if (seen[media].has(entry.id)) return warn(`[ios-suggestions] ${source}: skipping ${where}: duplicate id "${entry.id}" in ${media}`);
    seen[media].add(entry.id);
    lists[media].push(normalizeEntry(entry));
  };
  for (const media of MEDIA) (raw[media] || []).forEach((e, i) => add(media, e, `${media}[${i}]`));
  (raw.suggestions || []).forEach((e, i) => {
    const media = Array.isArray(e?.media) ? e.media.filter(m => MEDIA.includes(m)) : [];
    if (!media.length) {
      given += 1;
      return warn(`[ios-suggestions] ${source}: skipping suggestions[${i}]: media must list "video" and/or "photo"`);
    }
    for (const m of media) add(m, e, `suggestions[${i}]`);
  });
  if (given > 0 && lists.video.length + lists.photo.length === 0) throw new Error('no valid suggestions');
  return { ttl, ...lists };
}

/** Build from the query: digits only, else FALLBACK_BUILD. */
export function parseSuggestionBuild(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,15}$/.test(s)) return FALLBACK_BUILD;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : FALLBACK_BUILD;
}

export function parseSuggestionMedia(value) {
  return value === 'photo' ? 'photo' : 'video';
}

/** Names of the tools offered to this FinalCap-iOS build for this media (the shared allowlist path). */
export function iosToolNamesFor(build, media) {
  const mediaType = media === 'photo' ? 'image' : 'video';
  return new Set(offeredToolsFor({ userAgent: `FinalCap-iOS/${build}`, mediaType }).map(t => t.function.name));
}

/** The response pills (public fields only), in config order. */
export function suggestionsFor(config, { build, media }) {
  const available = iosToolNamesFor(build, media);
  return config[media]
    .filter(e => (e.minBuild === undefined || build >= e.minBuild) && (e.maxBuild === undefined || build <= e.maxBuild))
    .filter(e => e.tools.some(t => available.has(t)))
    .map(({ id, label, prompt, icon }) => (icon === undefined ? { id, label, prompt } : { id, label, prompt, icon }));
}

/**
 * Config source with an mtime-checked live override.
 * `overridePath` is read on every check (default: process.env.IOS_SUGGESTIONS_PATH).
 */
export function createSuggestionsStore({
  defaultPath = DEFAULT_SUGGESTIONS_PATH,
  overridePath = () => process.env.IOS_SUGGESTIONS_PATH,
  checkIntervalMs = CHECK_INTERVAL_MS,
  now = Date.now,
  logger = console,
} = {}) {
  const files = new Map(); // path → { key, config, error }
  const warned = new Set();
  let current = null;
  let lastCheck = -Infinity;

  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    logger.warn(message);
  };

  // Returns { config } or { error }, re-reading only when mtime/size changed.
  function readFile(file) {
    let st;
    try {
      st = statSync(file);
    } catch (error) {
      files.delete(file);
      return { error: `cannot stat (${error.code || error.message})` };
    }
    const key = `${st.mtimeMs}:${st.size}`;
    const cached = files.get(file);
    if (cached && cached.key === key) return cached;
    let entry;
    try {
      const warnings = [];
      const config = validateSuggestionsConfig(JSON.parse(readFileSync(file, 'utf8')), { warn: w => warnings.push(w), source: file });
      for (const w of warnings) logger.warn(w);
      entry = { key, config };
    } catch (error) {
      entry = { key, error: error.message };
    }
    files.set(file, entry);
    return entry;
  }

  function load() {
    const override = overridePath();
    if (override) {
      const result = readFile(override);
      if (result.config) return result.config;
      warnOnce(`${override}:${result.key || result.error}`, `[ios-suggestions] override ${override} unusable (${result.error}); using ${defaultPath}`);
    }
    const fallback = readFile(defaultPath);
    if (fallback.config) return fallback.config;
    warnOnce(`${defaultPath}:${fallback.key || fallback.error}`, `[ios-suggestions] default ${defaultPath} unusable (${fallback.error}); serving no suggestions`);
    return { ttl: DEFAULT_TTL, video: [], photo: [] };
  }

  return {
    get() {
      const t = now();
      if (!current || t - lastCheck >= checkIntervalMs) {
        current = load();
        lastCheck = t;
      }
      return current;
    },
  };
}

/** Pre-login endpoint, so it gets its own limiter (not the chat apiLimiter budget). */
export const suggestionsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: 'Too many requests from this IP, please try again later.',
});

export function createIosSuggestionsRouter({ store = createSuggestionsStore(), limiter = suggestionsLimiter } = {}) {
  const router = express.Router();
  router.get('/api/ios/suggestions', limiter, (req, res) => {
    let config;
    try {
      config = store.get();
    } catch (error) {
      console.warn(`[ios-suggestions] ${error.message}`);
      config = { ttl: DEFAULT_TTL, video: [], photo: [] };
    }
    const build = parseSuggestionBuild(req.query.build);
    const media = parseSuggestionMedia(req.query.media);
    res.set('Cache-Control', `public, max-age=${config.ttl}`);
    res.json({ suggestions: suggestionsFor(config, { build, media }), ttl: config.ttl });
  });
  return router;
}

export const iosSuggestionsRouter = createIosSuggestionsRouter();
