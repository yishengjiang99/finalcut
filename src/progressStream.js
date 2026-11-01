// Client side of the opt-in SSE progress stream (src/server/progressStream.js).

/** Parse complete `event:`/`data:` blocks; returns the events and the unparsed remainder. */
export function parseSseEvents(text) {
  const blocks = text.split(/\r?\n\r?\n/);
  const rest = blocks.pop();
  const events = [];
  for (const block of blocks) {
    let event = 'message'; const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) continue; // comments / keepalives
    try { events.push({ event, data: JSON.parse(data.join('\n')) }); } catch { /* not JSON: ignore */ }
  }
  return { events, rest };
}

/** Read a progress stream: onEvent(data) for progress/heartbeat/unknown; resolves the `result` data. */
export async function readProgressStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() + '\n\n' : decoder.decode(value, { stream: true });
    const { events, rest } = parseSseEvents(buffer);
    buffer = rest;
    for (const { event, data } of events) {
      if (event === 'result') return data;
      if (event === 'error') throw Object.assign(new Error(data.error || 'Request failed'), { code: data.code || null });
      onEvent({ ...data, type: data.type || event });
    }
    if (done) throw new Error('The progress stream ended without a result');
  }
}
