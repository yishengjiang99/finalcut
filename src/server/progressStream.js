// Opt-in SSE progress for long tool endpoints (client sends Accept: text/event-stream).
// Events: `progress` {stage, label, elapsed}, `heartbeat` {elapsed} every few seconds,
// then one `result` or `error`. Clients ignore event names they do not know.
export const HEARTBEAT_MS = 4000;

export const wantsProgressStream = (req) => /text\/event-stream/i.test(req.get?.('accept') || '');

export function openProgressStream(res, { heartbeatMs = HEARTBEAT_MS, now = Date.now } = {}) {
  const started = now();
  const elapsed = () => Math.round((now() - started) / 1000);
  let open = true;
  res.status(200);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const send = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`); };
  const timer = setInterval(() => send('heartbeat', { elapsed: elapsed() }), heartbeatMs);
  const close = () => { if (!open) return; open = false; clearInterval(timer); res.end(); };
  res.on?.('close', () => { open = false; clearInterval(timer); });
  return {
    get open() { return open; },
    progress: (stage, label) => send('progress', { stage, label, elapsed: elapsed() }),
    result: (data) => { send('result', { ...data, elapsed: elapsed() }); close(); },
    error: (data) => { send('error', { ...data, elapsed: elapsed() }); close(); },
  };
}
