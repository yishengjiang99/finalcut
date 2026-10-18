// Keep the screen awake while captions stream (a phone that sleeps freezes the tab and drops the socket).
// Harmless where unsupported or refused. The lock is released by the browser when the tab is hidden, so it is
// asked for again when the tab is visible. Returns release().
export function keepAwake({ nav = globalThis.navigator, doc = globalThis.document, onEvent = () => {} } = {}) {
  if (!nav?.wakeLock?.request) { onEvent('unsupported'); return () => {}; }
  let sentinel = null;
  let released = false;
  const acquire = async () => {
    if (released || sentinel) return;
    try {
      sentinel = await nav.wakeLock.request('screen');
      onEvent('acquired');
      sentinel.addEventListener?.('release', () => { sentinel = null; });
    } catch (err) {
      sentinel = null;
      onEvent('refused', String(err?.name || err).slice(0, 40));
    }
  };
  const onVisible = () => { if (doc?.visibilityState === 'visible') acquire(); };
  doc?.addEventListener?.('visibilitychange', onVisible);
  acquire();
  return () => {
    released = true;
    doc?.removeEventListener?.('visibilitychange', onVisible);
    try { sentinel?.release?.(); } catch { /* already released */ }
    sentinel = null;
  };
}
