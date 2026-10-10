// Lets the editor cancel a running job: every tool request made through this
// wrapper is tied to the current job's AbortSignal (none when idle).
let abortSignal = null;

export function setFetchAbortSignal(signal) {
  abortSignal = signal || null;
}

// In-browser FFmpeg jobs make no request; they watch the same signal to stop the worker.
export function getFetchAbortSignal() {
  return abortSignal;
}

export function abortableFetch(url, init) {
  return globalThis.fetch(url, abortSignal ? { ...init, signal: abortSignal } : init);
}
