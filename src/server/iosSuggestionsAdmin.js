// Admin API for the iOS suggestion pills (see docs/api/IOS_SUGGESTIONS.md).
//
//   GET  /api/admin/ios-suggestions                         effective config (what is being served)
//   PUT  /api/admin/ios-suggestions[?dryRun=1]              validate, then atomically write the override
//   GET  /api/admin/ios-suggestions/preview?build=&media=   what a given build would see
//
// Auth: `Authorization: Bearer <ADMIN_API_TOKEN>`, compared in constant time. While ADMIN_API_TOKEN is
// unset (or shorter than MIN_TOKEN_LENGTH) every route answers 404, so nothing is exposed by default.
// The token and the request body are never logged or echoed. Storage is the same JSON file the public
// endpoint already reads: IOS_SUGGESTIONS_PATH (written atomically, previous version kept as .bak).
// No database.

import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_TTL,
  KNOWN_TOOL_NAMES,
  MAX_LABEL_LENGTH,
  MAX_PROMPT_LENGTH,
  MAX_TTL,
  MEDIA,
  iosToolNamesFor,
  parseSuggestionBuild,
  parseSuggestionMedia,
  suggestionsFor,
  suggestionsStore,
  validateSuggestionsConfig,
} from './iosSuggestions.js';
import { IOS_TOOL_ALLOWLIST } from './iosToolAllowlist.js';
import { IOS_GROUPED_TOOLS } from './iosGroupedTools.js';

export const MIN_TOKEN_LENGTH = 24;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_ENTRIES_PER_MEDIA = 40;
export const MAX_TOOLS_PER_ENTRY = 12;
export const MAX_ICON_LENGTH = 64;
export const MAX_BUILD_BOUND = 1_000_000_000_000;
const ENTRY_KEYS = new Set(['id', 'label', 'prompt', 'icon', 'tools', 'minBuild', 'maxBuild']);
const TOP_KEYS = new Set(['ttl', ...MEDIA]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ICON_RE = /^[A-Za-z0-9._-]+$/; // SF Symbol names
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isBuildBound = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_BUILD_BOUND;
const IOS_KNOWN_TOOLS = new Set([...Object.keys(IOS_TOOL_ALLOWLIST), ...IOS_GROUPED_TOOLS.map(t => t.function.name)]);

/**
 * Strict validation for a PUT body. Unlike the file loader (which skips bad entries and warns), this
 * rejects the whole document and lists every problem, so a typo never silently drops a pill.
 * @returns {{ errors: {path: string, message: string}[], warnings: string[], config: object | null }}
 */
export function validateSuggestionsBody(raw) {
  const errors = [];
  const warnings = [];
  const err = (p, message) => errors.push({ path: p, message });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [{ path: '$', message: 'body must be a JSON object {ttl, video[], photo[]}' }], warnings, config: null };
  }
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) err(key, 'unknown key (allowed: ttl, video, photo)');
  let ttl = DEFAULT_TTL;
  if (raw.ttl !== undefined) {
    if (Number.isSafeInteger(raw.ttl) && raw.ttl >= 0 && raw.ttl <= MAX_TTL) ttl = raw.ttl;
    else err('ttl', `must be an integer 0..${MAX_TTL}`);
  }
  const lists = { video: [], photo: [] };
  for (const media of MEDIA) {
    const list = raw[media];
    if (!Array.isArray(list)) { err(media, 'must be an array (use [] for none)'); continue; }
    if (list.length > MAX_ENTRIES_PER_MEDIA) err(media, `at most ${MAX_ENTRIES_PER_MEDIA} entries`);
    const seen = new Set();
    list.slice(0, MAX_ENTRIES_PER_MEDIA).forEach((entry, i) => {
      const at = `${media}[${i}]`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return err(at, 'must be an object');
      for (const key of Object.keys(entry)) if (!ENTRY_KEYS.has(key)) err(`${at}.${key}`, `unknown key (allowed: ${[...ENTRY_KEYS].join(', ')})`);
      if (!nonEmptyString(entry.id) || !ID_RE.test(entry.id)) err(`${at}.id`, 'must be 1-64 characters: letters, digits, ".", "_", "-"');
      else if (seen.has(entry.id)) err(`${at}.id`, `duplicate id "${entry.id}" in ${media}`);
      else seen.add(entry.id);
      if (!nonEmptyString(entry.label)) err(`${at}.label`, 'must be a non-empty string');
      else if (entry.label.length > MAX_LABEL_LENGTH) err(`${at}.label`, `at most ${MAX_LABEL_LENGTH} characters`);
      else if (CONTROL_RE.test(entry.label)) err(`${at}.label`, 'must not contain control characters');
      if (!nonEmptyString(entry.prompt)) err(`${at}.prompt`, 'must be a non-empty string');
      else if (entry.prompt.length > MAX_PROMPT_LENGTH) err(`${at}.prompt`, `at most ${MAX_PROMPT_LENGTH} characters`);
      else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.prompt)) err(`${at}.prompt`, 'must not contain control characters');
      if (entry.icon !== undefined && (typeof entry.icon !== 'string' || entry.icon.length > MAX_ICON_LENGTH || !ICON_RE.test(entry.icon))) {
        err(`${at}.icon`, `must be an SF Symbol name (letters, digits, ".", "_", "-"; at most ${MAX_ICON_LENGTH})`);
      }
      if (!Array.isArray(entry.tools) || entry.tools.length === 0) err(`${at}.tools`, 'must be a non-empty array of tool names (the pill shows when ANY of them is offered to the build)');
      else {
        if (entry.tools.length > MAX_TOOLS_PER_ENTRY) err(`${at}.tools`, `at most ${MAX_TOOLS_PER_ENTRY} tools`);
        const unknown = entry.tools.filter(t => typeof t !== 'string' || !KNOWN_TOOL_NAMES.has(t));
        if (unknown.length) err(`${at}.tools`, `unknown tool names: ${unknown.slice(0, 5).map(t => JSON.stringify(String(t).slice(0, 40))).join(', ')}`);
        else if (new Set(entry.tools).size !== entry.tools.length) err(`${at}.tools`, 'duplicate tool names');
        else if (!entry.tools.some(t => IOS_KNOWN_TOOLS.has(t))) warnings.push(`${at} ("${entry.id}"): none of its tools is on the iOS allowlist, so no build will show it`);
      }
      for (const key of ['minBuild', 'maxBuild']) {
        if (entry[key] !== undefined && !isBuildBound(entry[key])) err(`${at}.${key}`, `must be an integer 0..${MAX_BUILD_BOUND} (inclusive build number)`);
      }
      if (isBuildBound(entry.minBuild) && isBuildBound(entry.maxBuild) && entry.minBuild > entry.maxBuild) err(`${at}.minBuild`, 'minBuild is greater than maxBuild: no build would match');
    });
    lists[media] = list;
  }
  if (errors.length) return { errors, warnings, config: null };
  // Canonical form: exactly what is stored, with the same normalizer the loader uses.
  const config = validateSuggestionsConfig({ ttl, ...lists }, { warn: (w) => warnings.push(w), source: 'PUT body' });
  return { errors, warnings, config };
}

export const etagOf = (config) => `"${crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 32)}"`;
const summaryOf = (config) => ({ ttl: config.ttl, video: config.video.length, photo: config.photo.length });

function constantTimeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Why the override file cannot be written, or null. Needs a writable directory (temp file + rename). */
export function overrideWriteProblem(file, fsImpl = fs) {
  if (!file) return { code: 'override_path_not_set', message: 'IOS_SUGGESTIONS_PATH is not set on the server, so there is nowhere to write the override.' };
  const dir = path.dirname(file);
  try {
    if (!fsImpl.statSync(dir).isDirectory()) throw new Error('not a directory');
    fsImpl.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    if (fsImpl.existsSync(file)) {
      if (fsImpl.statSync(file).isDirectory()) throw new Error('target is a directory');
      fsImpl.accessSync(file, fs.constants.R_OK);
    }
  } catch {
    return { code: 'override_path_not_writable', message: 'The directory of IOS_SUGGESTIONS_PATH does not exist or is not writable by the service user.' };
  }
  return null;
}

/**
 * Atomically replace `file` with `content`: temp file in the same directory (fsync'd), the previous
 * version copied to `<file>.bak`, then rename. A failure at any step leaves the old file in place.
 * @returns {{ backedUp: boolean }}
 */
export function writeOverrideAtomically(file, content, fsImpl = fs) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = fsImpl.openSync(tmp, 'wx', 0o644);
    fsImpl.writeSync(fd, content);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = undefined;
    let backedUp = false;
    if (fsImpl.existsSync(file)) {
      fsImpl.copyFileSync(file, `${file}.bak`);
      backedUp = true;
    }
    fsImpl.renameSync(tmp, file);
    return { backedUp };
  } catch (error) {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

export const adminLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});
/** Counts only failed authentications (401), so a guessing client is cut off quickly. */
export const adminFailureLimiter = () => rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (req, res) => res.statusCode !== 401,
  standardHeaders: false,
  legacyHeaders: false,
  message: { error: 'rate_limited' },
});

export function createIosSuggestionsAdminRouter({
  store = suggestionsStore,
  getToken = () => process.env.ADMIN_API_TOKEN,
  limiter = adminLimiter(),
  failureLimiter = adminFailureLimiter(),
  fsImpl = fs,
  logger = console,
} = {}) {
  const router = express.Router();
  const BASE = '/api/admin/ios-suggestions';
  let writeChain = Promise.resolve(); // one write at a time within this process

  const enabled = (req, res, next) => {
    const token = (getToken() || '').trim();
    if (token.length < MIN_TOKEN_LENGTH) return res.status(404).json({ error: 'Not found' });
    req.adminToken = token;
    res.set('Cache-Control', 'no-store');
    return next();
  };
  const authenticate = (req, res, next) => {
    const header = req.get('authorization') || '';
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match || !constantTimeEqual(match[1].trim(), req.adminToken)) {
      res.set('WWW-Authenticate', 'Bearer realm="ios-suggestions-admin"');
      return res.status(401).json({ error: 'unauthorized' });
    }
    return next();
  };
  const guards = [enabled, limiter, failureLimiter, authenticate];
  const parseJson = express.json({ limit: MAX_BODY_BYTES, type: () => true });

  const overrideFile = () => {
    const f = store.overridePath();
    return typeof f === 'string' && f.trim() ? f.trim() : null;
  };

  router.get(BASE, ...guards, (req, res) => {
    const { config, source } = store.info();
    const file = overrideFile();
    res.set('ETag', etagOf(config));
    res.json({
      source,
      overrideConfigured: Boolean(file),
      writable: !overrideWriteProblem(file, fsImpl),
      etag: etagOf(config),
      config,
    });
  });

  router.get(`${BASE}/preview`, ...guards, (req, res) => {
    const build = parseSuggestionBuild(req.query.build);
    const media = parseSuggestionMedia(req.query.media);
    const { config, source } = store.info();
    const available = iosToolNamesFor(build, media);
    const shown = suggestionsFor(config, { build, media });
    const shownIds = new Set(shown.map(s => s.id));
    const hidden = config[media].filter(e => !shownIds.has(e.id)).map((e) => {
      let reason = 'none of its tools is offered to this build for this media';
      if (e.minBuild !== undefined && build < e.minBuild) reason = `build ${build} is below minBuild ${e.minBuild}`;
      else if (e.maxBuild !== undefined && build > e.maxBuild) reason = `build ${build} is above maxBuild ${e.maxBuild}`;
      return { id: e.id, reason };
    });
    res.json({
      build,
      media,
      source,
      ttl: config.ttl,
      toolsOffered: [...available],
      // Exactly the body GET /api/ios/suggestions returns for this build and media.
      response: { suggestions: shown, ttl: config.ttl },
      hidden,
    });
  });

  router.put(BASE, ...guards, parseJson, (req, res) => {
    const { errors, warnings, config } = validateSuggestionsBody(req.body);
    const dryRun = ['1', 'true'].includes(String(req.query.dryRun || '').toLowerCase());
    if (errors.length) return res.status(400).json({ error: 'invalid_suggestions', errors, warnings });
    const problem = overrideWriteProblem(overrideFile(), fsImpl);
    if (dryRun) {
      return res.json({ ok: true, dryRun: true, written: false, wouldWrite: !problem, ...(problem ? { problem: problem.code } : {}), etag: etagOf(config), summary: summaryOf(config), warnings });
    }
    if (problem) return res.status(503).json({ error: problem.code, message: problem.message, warnings });
    const file = overrideFile();
    const ifMatch = req.get('if-match');
    const run = writeChain.then(() => {
      if (ifMatch && ifMatch !== '*' && ifMatch !== etagOf(store.info().config)) {
        return res.status(412).json({ error: 'precondition_failed', message: 'The served config changed since you read it. GET it again.' });
      }
      let result;
      try {
        result = writeOverrideAtomically(file, `${JSON.stringify(config, null, 2)}\n`, fsImpl);
      } catch (error) {
        logger.error(`[ios-suggestions-admin] write failed (${error.code || 'error'})`);
        return res.status(500).json({ error: 'write_failed', message: 'Could not write the override file; the previous version is unchanged.' });
      }
      store.invalidate();
      const served = store.info();
      const stored = served.source === 'override' && etagOf(served.config) === etagOf(config);
      logger.info(`[ios-suggestions-admin] override updated: video=${config.video.length} photo=${config.photo.length} ttl=${config.ttl}`);
      return res.json({
        ok: true,
        written: true,
        backup: result.backedUp,
        etag: etagOf(config),
        servedNow: stored,
        summary: summaryOf(config),
        warnings,
        note: 'Other processes pick the change up within ~5 s; clients refresh when their ttl cache expires.',
      });
    });
    writeChain = run.catch(() => {});
    run.catch(() => res.headersSent || res.status(500).json({ error: 'write_failed' }));
  });

  // Malformed / oversized JSON: a plain error, never the body.
  // eslint-disable-next-line no-unused-vars
  router.use(BASE, (error, req, res, next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'body_too_large', limitBytes: MAX_BODY_BYTES });
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    logger.error(`[ios-suggestions-admin] ${error?.type || error?.code || 'error'}`);
    return res.status(500).json({ error: 'internal_error' });
  });

  return router;
}

export const iosSuggestionsAdminRouter = createIosSuggestionsAdminRouter();
