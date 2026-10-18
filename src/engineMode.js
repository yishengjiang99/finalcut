// Which FFmpeg the app edits with: "client" (ffmpeg.wasm in this browser, nothing uploaded).
// The client engine is the only engine — there is no flag, override, or rollout.
// Server-side processing remains available only as the per-operation consent fallback
// (a step the browser cannot run asks before anything is uploaded).

export const ENGINE_CLIENT = 'client';
export const ENGINE_SERVER = 'server';

/** The engine is always the in-browser ffmpeg.wasm client. */
export function getEngineMode() {
  return ENGINE_CLIENT;
}

/** Read the server config (clip limits, caption availability). A failed request means defaults. */
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
