// Deep links from the static guide pages (/add-subtitles etc.): /?prompt=<text>&start=signin|sample.
// The prompt is kept in sessionStorage across Google sign-in (and Stripe checkout) and put into the
// chat box when the editor opens. It is never sent automatically: the user presses Send.
const KEY = 'finalcap.pendingPrompt';
export const MAX_PROMPT = 300;

export function cleanPrompt(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);
}

export function readDeepLink(search = typeof window === 'undefined' ? '' : window.location.search) {
  const params = new URLSearchParams(search);
  const start = params.get('start');
  return {
    prompt: cleanPrompt(params.get('prompt') || ''),
    start: start === 'signin' || start === 'sample' ? start : null,
  };
}

export function storePendingPrompt(prompt, storage = globalThis.sessionStorage) {
  const clean = cleanPrompt(prompt);
  if (!clean) return;
  try { storage.setItem(KEY, clean); } catch { /* storage blocked: the prompt is just not prefilled */ }
}

export function takePendingPrompt(storage = globalThis.sessionStorage) {
  try {
    const value = cleanPrompt(storage.getItem(KEY) || '');
    storage.removeItem(KEY);
    return value;
  } catch {
    return '';
  }
}
