// Which build this bundle is, and whether the server has a newer one. The id is the git commit the
// bundle was built from (vite `define`), the same value /api/health reports as `commit`.
/* global __BUILD_ID__ */
export const BUILD_ID = typeof __BUILD_ID__ !== 'undefined' && __BUILD_ID__ ? String(__BUILD_ID__) : 'dev';

/** Commits match when one is a prefix of the other (short vs full sha). 'dev'/unknown never match a real one. */
export function sameBuild(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return true; // nothing to compare: do not nag
  return x.startsWith(y) || y.startsWith(x);
}

/** True when the running server is a different build than this bundle. Never throws. */
export async function newBuildAvailable({ fetchImpl = globalThis.fetch, own = BUILD_ID } = {}) {
  if (!own || own === 'dev') return false;
  try {
    const res = await fetchImpl('/api/health', { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    const commit = typeof body?.commit === 'string' ? body.commit.replace(/-dirty$/, '') : null;
    if (!commit || !/^[0-9a-f]{7,40}$/i.test(commit)) return false;
    return !sameBuild(own, commit);
  } catch {
    return false;
  }
}
