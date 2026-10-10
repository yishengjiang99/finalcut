// Which FFmpeg the app edits with: "client" (ffmpeg.wasm in this browser, nothing uploaded) or
// "server" (the previous upload-and-process flow, kept as the fallback). Decided once at startup
// from the server's feature flag, the browser, and the ?engine= override.

export const ENGINE_CLIENT = 'client';
export const ENGINE_SERVER = 'server';

/** Desktop Chromium and Firefox run the in-browser engine by default; phones and Safari do not yet. */
export function supportsClientEngine(ua = globalThis.navigator?.userAgent || '', maxTouchPoints = globalThis.navigator?.maxTouchPoints || 0) {
  if (typeof WebAssembly !== 'object' || typeof Worker !== 'function') return false;
  const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  if (mobile) return false;
  return /Firefox\/|Chrome\/|Chromium\/|Edg\//.test(ua);
}

// A stable 0-99 bucket per browser, so a percentage rollout does not flip between visits.
function rolloutBucket(storage = globalThis.localStorage) {
  try {
    let bucket = Number(storage.getItem('fc.rolloutBucket'));
    if (!Number.isInteger(bucket) || bucket < 0 || bucket > 99 || storage.getItem('fc.rolloutBucket') === null) {
      bucket = Math.floor(Math.random() * 100);
      storage.setItem('fc.rolloutBucket', String(bucket));
    }
    return bucket;
  } catch {
    return Math.floor(Math.random() * 100);
  }
}

/**
 * @param {{ flag?: { mode: 'on'|'off'|'percent', percent?: number }, search?: string, supported?: boolean, bucket?: number }} input
 * @returns {{ mode: 'client'|'server', reason: string }}
 */
export function resolveEngineMode({ flag, search = globalThis.location?.search || '', supported = supportsClientEngine(), bucket } = {}) {
  const override = new URLSearchParams(search).get('engine');
  if (override === ENGINE_SERVER) return { mode: ENGINE_SERVER, reason: 'override' };
  if (override === ENGINE_CLIENT) return { mode: ENGINE_CLIENT, reason: 'override' };
  if (flag?.mode === 'off') return { mode: ENGINE_SERVER, reason: 'flag_off' };
  if (!supported) return { mode: ENGINE_SERVER, reason: 'browser' };
  if (flag?.mode === 'percent') {
    const b = bucket ?? rolloutBucket();
    return b < (flag.percent || 0) ? { mode: ENGINE_CLIENT, reason: 'rollout' } : { mode: ENGINE_SERVER, reason: 'rollout' };
  }
  return { mode: ENGINE_CLIENT, reason: 'default' };
}

// Until the flag has been read the app behaves as before (server), so nothing changes by accident.
let engineMode = ENGINE_SERVER;

export function setEngineMode(mode) {
  engineMode = mode === ENGINE_CLIENT ? ENGINE_CLIENT : ENGINE_SERVER;
}

export function getEngineMode() {
  return engineMode;
}

/** Read the feature flag and clip limits. A failed request means defaults (flag on). */
export async function fetchClientConfig(fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl('/api/v2/config');
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ─── Upload consent ──────────────────────────────────────────────────────────
// A step that cannot run in the browser may run on the server, which uploads the file. That is
// never done silently: the UI is asked first, and the answer defaults to "no".

let consentHandler = null;

/** `handler({ tool, reason, uploads })` resolves to true only when the user agrees. */
export function setUploadConsentHandler(handler) {
  consentHandler = typeof handler === 'function' ? handler : null;
}

export async function requestUploadConsent(request) {
  if (!consentHandler) return false;
  try {
    return (await consentHandler(request)) === true;
  } catch {
    return false;
  }
}

export class UploadDeclinedError extends Error {
  constructor(tool) {
    super(`"${tool}" was skipped: it cannot run in this browser and you chose not to upload the file.`);
    this.name = 'UploadDeclinedError';
    this.code = 'skipped_by_user';
  }
}

// ─── Cloud captions opt-in ───────────────────────────────────────────────────

const CLOUD_CAPTIONS_KEY = 'fc.cloudCaptions';

/** Off unless the user turned it on: cloud transcription uploads the clip's audio (never video). */
export function getCloudCaptions(storage = globalThis.localStorage) {
  try {
    return storage.getItem(CLOUD_CAPTIONS_KEY) === '1';
  } catch {
    return false;
  }
}

export function setCloudCaptions(enabled, storage = globalThis.localStorage) {
  try {
    if (enabled) storage.setItem(CLOUD_CAPTIONS_KEY, '1');
    else storage.removeItem(CLOUD_CAPTIONS_KEY);
  } catch { /* private mode: the choice lasts for this page only */ }
}
