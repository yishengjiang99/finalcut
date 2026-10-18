// Streaming captions, browser side. The audio of the selected video is decoded locally, resampled to
// 16 kHz mono PCM and streamed over a WebSocket straight to ElevenLabs realtime speech-to-text
// (scribe_v2_realtime, word timestamps). Our server only mints the single-use token and translates
// the committed text (POST /api/streaming-captions/*); no audio goes through it. The captions are
// then burned in the browser (ffmpeg.wasm) from the final lines.
//
// Flow: plan commit points at silences (~20-30 s apart) → mint token → stream chunks at STREAM_PACE
// → each committed segment becomes caption lines → lines are translated in small batches in order →
// percent = seconds of audio that are transcribed AND translated / total (monotonic, ≤ 99; the UI
// shows 100 only after the burn). A dropped socket keeps what is finished; the caller may resume
// from the first unfinished range with a fresh token. See docs/api/STREAMING_CAPTIONS.md.
import { abortableFetch as fetch } from './abortableFetch.js';
import { buildLines } from './lyricShared.js';
import { LYRIC_CAPTIONS_MESSAGES } from './lyricCaptionsClient.js';

export const SAMPLE_RATE = 16000;
export const MAX_AUDIO_SECONDS = 600;
/** Audio seconds sent per wall-clock second. Default 4x (a real-key test showed 2x and 4x give the same text and timestamps as real time, see docs/api/STREAMING_CAPTIONS.md); `fc.streamPace` = 1 turns it back to real time. */
export const STREAM_PACE_DEFAULT = 4;
export const STREAM_PACE_MIN = 0.5;
export const STREAM_PACE_MAX = 4;
export const CHUNK_SAMPLES = 8000; // 0.5 s; documented range is 0.1-1 s
export const GRID_SAMPLES = 1600; // commit points sit on a 0.1 s grid so no chunk is shorter than 0.1 s
export const COMMIT_MIN_SEC = 20;
export const COMMIT_MAX_SEC = 30;
export const TRANSLATE_BATCH = 20;
export const PERCENT_CAP = 99;
/** Percent once the audio is decoded and the commit points are planned; streaming fills 5..99 (half audio sent, half transcribed and translated). */
export const PREP_PERCENT = 5;
/** No sign of life (audio sent, a socket message, a translate answer, a token) for this long: stop with a clear error. */
export const STALL_MS = 20_000;
/** A socket that has shown no sign of life for this long when the tab comes back is treated as dead and resumed at once. */
export const DEAD_ON_RETURN_MS = 8_000;

/** The page's visibility, injectable for tests: { isHidden(), subscribe(cb) → unsubscribe }. */
export const pageVisibility = {
  isHidden: () => globalThis.document?.visibilityState === 'hidden',
  subscribe: (cb) => {
    const doc = globalThis.document;
    if (!doc?.addEventListener) return () => {};
    const on = () => cb(doc.visibilityState);
    doc.addEventListener('visibilitychange', on);
    return () => doc.removeEventListener('visibilitychange', on);
  },
};
/** Automatic resumes (fresh token, continue from the first unfinished range) per session before the Continue prompt; a user-approved Continue grants a new budget. */
export const AUTO_RESUMES = 3;
export const RESUME_BACKOFF_MS = [500, 1500, 3000];

const PACE_KEY = 'fc.streamPace';
/** Pacing: explicit option, else the `fc.streamPace` localStorage flag, else STREAM_PACE_DEFAULT (4). Clamped to 0.5-4; 1 = real time. */
export function getStreamPace(explicit, storage = globalThis.localStorage) {
  let value = Number(explicit);
  if (!Number.isFinite(value) || value <= 0) {
    try { value = Number(storage?.getItem(PACE_KEY)); } catch { value = NaN; }
  }
  if (!Number.isFinite(value) || value <= 0) return STREAM_PACE_DEFAULT;
  return Math.min(STREAM_PACE_MAX, Math.max(STREAM_PACE_MIN, value));
}

// ── Messages (Design wording where given) ────────────────────────────────────

export const formatClock = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const STREAMING_MESSAGES = Object.freeze({
  ...LYRIC_CAPTIONS_MESSAGES,
  stalled: 'Captions stopped making progress. Nothing was changed. Try again.',
  restarted: "Captions couldn't finish because the service restarted. Nothing was changed. Try again.",
  busy: 'The transcription service is busy. Try again in a moment.',
  declined: 'Audio not sent. Nothing was changed.',
  connectionDropped: (sec) => `The connection dropped at ${formatClock(sec)}. Captions up to there are kept.`,
  timeLimit: (sec) => `The transcription session reached its time limit at ${formatClock(sec)}. Captions up to there are kept.`,
});

export const CONSENT_COPY = Object.freeze({
  title: 'Send the audio to ElevenLabs?',
  body: "FinalCap will stream this video's audio, but not the picture, to ElevenLabs to transcribe it. ElevenLabs may keep the audio and the transcript, and FinalCap can't delete them. The text is then sent to FinalCap, which sends it to xAI (Grok) to translate.",
  privacyLabel: 'Privacy details',
  privacyHref: '/legal/privacy.html#streaming-captions',
  confirmLabel: 'Send audio',
  declineLabel: 'Not now',
});

export const CONTINUE_COPY = Object.freeze({
  confirmLabel: 'Continue',
  declineLabel: 'Cancel',
});

export class StreamingCaptionsError extends Error {
  constructor(message, { code = 'streaming_failed', status, lines = [], failedRanges = [], atSec = null, neverStarted = false } = {}) {
    super(message);
    this.name = 'StreamingCaptionsError';
    this.code = code;
    if (status) this.status = status;
    this.lines = lines; // what was finished (kept)
    this.failedRanges = failedRanges;
    this.atSec = atSec;
    this.neverStarted = neverStarted; // no session was ever started: the caller may fall back to the upload flow
  }
}

const cancelled = () => Object.assign(new Error('Job cancelled'), { code: 'cancelled' });

/** ElevenLabs realtime error events that end the session, with the user-facing meaning. */
const SESSION_ERRORS = {
  rate_limited: 'busy',
  queue_overflow: 'busy',
  resource_exhausted: 'busy',
  commit_throttled: 'busy',
  quota_exceeded: 'unavailable',
  auth_error: 'auth',
  unaccepted_terms: 'unavailable',
  session_time_limit_exceeded: 'time_limit',
  transcriber_error: 'failed',
  input_error: 'failed',
  invalid_request: 'failed',
  chunk_size_exceeded: 'failed',
  error: 'failed',
};

/** One short message for any failure of the streaming flow. */
export function friendlyStreamingError(error) {
  if (error?.name === 'UploadDeclinedError') return error.message;
  const code = error?.code;
  if (code === 'declined_continue' && error.message) return error.message;
  if (code === 'stalled') return STREAMING_MESSAGES.stalled;
  if (code === 'job_lost' || code === 'job_expired') return STREAMING_MESSAGES.restarted;
  if (code === 'audio_too_long' || (error?.status === 413 && code !== 'batch_too_large')) return STREAMING_MESSAGES.tooLong;
  if (code === 'busy' || code === 'streaming_captions_busy' || code === 'rate_limited' || error?.status === 429) return STREAMING_MESSAGES.busy;
  if (code === 'streaming_captions_unavailable' || code === 'lyric_captions_unavailable' || code === 'unavailable' || error?.status === 503) return STREAMING_MESSAGES.unavailable;
  if (code === 'no_speech') return 'No speech detected in the audio';
  if (code === 'captions_already_burned' && error.message) return error.message;
  return STREAMING_MESSAGES.couldntFinish;
}

// ── Audio ────────────────────────────────────────────────────────────────────

/** Int16 samples at 16 kHz mono from a WAV (the engine writes exactly that; other layouts are converted). */
export function wavToPcm16k(wav) {
  const bytes = wav instanceof Uint8Array ? wav : new Uint8Array(wav);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new StreamingCaptionsError('Could not read the audio', { code: 'no_audio' });
  let rate = SAMPLE_RATE; let channels = 1; let bits = 16; let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset + 4, true);
    const id = tag(offset);
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      rate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      if (bits !== 16) throw new StreamingCaptionsError('Could not read the audio', { code: 'no_audio' });
      const start = offset + 8;
      // FFmpeg writes 0xFFFFFFFF as the size when it could not patch the header afterwards.
      const frames = Math.floor(Math.min(size, bytes.byteLength - start) / (2 * channels));
      const mono = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += view.getInt16(start + (i * channels + c) * 2, true);
        mono[i] = Math.round(sum / channels);
      }
      return rate === SAMPLE_RATE ? mono : resampleLinear(mono, rate, SAMPLE_RATE);
    }
    offset += 8 + size + (size % 2);
  }
  throw new StreamingCaptionsError('Could not read the audio', { code: 'no_audio' });
}

function resampleLinear(input, fromRate, toRate) {
  const length = Math.floor(input.length * toRate / fromRate);
  const out = new Int16Array(length);
  const ratio = fromRate / toRate;
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    out[i] = Math.round(input[i0] + (input[i1] - input[i0]) * (pos - i0));
  }
  return out;
}

/**
 * Where to commit: about every 20-30 s, at the quietest 50 ms window in that span, on a 0.1 s grid.
 * Returns increasing sample indexes; the last one is always the end of the audio.
 */
export function planCommitPoints(pcm, { min = COMMIT_MIN_SEC, max = COMMIT_MAX_SEC, sampleRate = SAMPLE_RATE } = {}) {
  const total = pcm.length;
  const win = Math.round(sampleRate * 0.05);
  const points = [];
  let cursor = 0;
  while (total - cursor > Math.round(max * sampleRate)) {
    const lo = cursor + Math.round(min * sampleRate);
    const hi = cursor + Math.round(max * sampleRate);
    // The quietest 50 ms window wins; a run of equally quiet windows (digital silence) is cut in the middle.
    let bestEnergy = Infinity;
    const energies = [];
    for (let at = lo; at + win <= hi; at += win) {
      let energy = 0;
      for (let i = at; i < at + win; i++) energy += pcm[i] * pcm[i];
      energies.push([at, energy]);
      if (energy < bestEnergy) bestEnergy = energy;
    }
    const quiet = energies.filter(([, e]) => e <= bestEnergy).map(([at]) => at);
    const best = quiet[Math.floor(quiet.length / 2)];
    const cut = Math.min(hi, Math.round((best + win / 2) / GRID_SAMPLES) * GRID_SAMPLES);
    points.push(cut);
    cursor = cut;
  }
  points.push(total);
  return points;
}

const toBase64 = (int16) => {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

// ── Server calls ─────────────────────────────────────────────────────────────

function httpError(body, res, fallback) {
  const err = new Error(body?.error || fallback);
  if (body?.code) err.code = body.code;
  err.status = res.status;
  return err;
}

export async function streamingAvailable({ headers = {}, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl('/api/streaming-captions/status', { headers });
    if (!res.ok) return false;
    return (await res.json())?.available === true;
  } catch {
    return false;
  }
}

/** Mint a single-use token just before connecting. `resumeSessionId` keeps a resumed session one edit. */
export async function mintStreamingToken({ headers = {}, sourceLanguage, resumeSessionId, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl('/api/streaming-captions/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ ...(sourceLanguage && sourceLanguage !== 'auto' ? { source_language: sourceLanguage } : {}), ...(resumeSessionId ? { resumeSessionId } : {}) }),
    });
  } catch {
    throw Object.assign(new Error('Network error'), { code: 'network' });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(body, res, `Could not start streaming captions (${res.status})`);
  return body;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Translate one batch of lines; transient failures (network, 429, 5xx) are retried once with a backoff. */
async function translateBatch(lines, { targetLanguage, sourceLanguage, context, sessionId, headers, fetchImpl, sleep, signal }) {
  const payload = JSON.stringify({
    ...(sessionId ? { sessionId } : {}), // the captions job: the server charges the edit once per job, at its first translated batch
    target_language: targetLanguage,
    source_language: sourceLanguage || 'auto',
    segments: lines.map((l, k) => ({ i: k, start: l.start, end: l.end, text: l.text })),
    context,
  });
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) throw cancelled();
    try {
      const res = await fetchImpl('/api/streaming-captions/translate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: payload, ...(signal ? { signal } : {}) });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body.lines || [];
      lastError = httpError(body, res, `Translation failed (${res.status})`);
      if (![429, 500, 502, 503, 504].includes(res.status)) throw lastError;
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      if (err.status && ![429, 500, 502, 503, 504].includes(err.status)) throw err;
      lastError = err.status ? err : Object.assign(new Error('Network error'), { code: 'network' });
    }
    if (attempt < 2) await sleep(500);
  }
  throw lastError;
}

// ── One streaming session (one WebSocket) ───────────────────────────────────

/** Map ElevenLabs word timestamps to absolute seconds. Session-absolute times and segment-relative times are both accepted. */
export function offsetWords(words, { sessionStartSec, rangeStartInSession, rangeStartAbs }) {
  const real = (Array.isArray(words) ? words : [])
    .filter(w => (w.type == null || w.type === 'word') && String(w.text ?? '').trim() && Number.isFinite(w.start) && Number.isFinite(w.end));
  if (!real.length) return [];
  const first = Math.min(...real.map(w => w.start));
  // Times that start well before this range's own start can only be relative to the range.
  const relative = rangeStartInSession > 1 && first < rangeStartInSession - 0.75;
  const base = relative ? rangeStartAbs : sessionStartSec;
  return real.map(w => ({ w: String(w.text).trim(), start: base + w.start, end: base + w.end }));
}

/**
 * Stream ranges [from, to) of `pcm` over one WebSocket and resolve with what happened.
 * `commits` are the range end points (samples) inside the run; each gets one `commit:true` chunk.
 * Resolves { ended: 'done'|'dropped'|'error', error?, results } and never rejects except on cancel.
 */
export function streamRun({ pcm, ranges, connection, WebSocketImpl, pace, sleep, signal, idleTimeoutMs = 30_000, connectTimeoutMs = 15_000, onSegment, onSent, onOpen, onActivity, registerKick, visibility = pageVisibility, log = () => {} }) {
  const fromSample = ranges[0].startSample;
  const toSample = ranges[ranges.length - 1].endSample;
  const sessionStartSec = fromSample / SAMPLE_RATE;
  const url = `${connection.wsUrl}?${new URLSearchParams({ ...connection.query, token: connection.token }).toString()}`;

  return new Promise((resolve, reject) => {
    let ws;
    let settled = false;
    let opened = false;
    let sendingDone = false;
    let nextExpected = 0; // index into ranges of the next committed event
    let idleTimer = null;
    let sentSec = 0;
    let lastActivity = Date.now(); // last message FROM the service (sends into a dead socket do not count)
    let unsubscribeVisibility = () => {};
    let firstMsg = false;
    let tick = null;
    let sawPartial = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearInterval(tick);
      unsubscribeVisibility();
      log('run_end', { ended: value.ended, kind: value.error?.kind, rs: ws?.readyState, sentSec: +(sentSec).toFixed(1), next: nextExpected });
      signal?.removeEventListener?.('abort', onAbort);
      try { ws?.close(); } catch { /* already closed */ }
      resolve({ ...value, nextExpected });
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearInterval(tick);
      unsubscribeVisibility();
      signal?.removeEventListener?.('abort', onAbort);
      try { ws?.close(); } catch { /* already closed */ }
      reject(err);
    };
    const onAbort = () => fail(cancelled());
    if (signal?.aborted) return fail(cancelled());
    signal?.addEventListener?.('abort', onAbort, { once: true });

    const armIdle = (ms) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { log('idle_timeout', { waitMs: ms, rs: ws?.readyState, opened, sentSec: +(sentSec).toFixed(1) }); finish({ ended: 'error', error: { kind: 'timeout', message: 'No answer from the transcription service' } }); }, ms);
    };

    try {
      log('ws_new', { from: +(sessionStartSec).toFixed(1) });
      ws = new WebSocketImpl(url);
    } catch (err) {
      log('ws_new_error', { msg: String(err?.message || err).slice(0, 100) });
      return finish({ ended: 'error', error: { kind: 'connect', message: err?.message || 'Could not connect' } });
    }
    armIdle(connectTimeoutMs);
    // Something outside (the stall watchdog, the tab coming back) found this socket dead or stuck: end the run as a drop,
    // which resumes from the first unfinished range with a fresh token.
    const kick = (reason) => {
      if (settled) return;
      log('kick', { reason, rs: ws?.readyState, quietMs: Date.now() - lastActivity, sentSec: +(sentSec).toFixed(1), opened });
      finish({ ended: 'dropped' });
    };
    registerKick?.(kick);
    unsubscribeVisibility = visibility.subscribe((state) => {
      log('vis', { state, rs: ws?.readyState, quietMs: Date.now() - lastActivity });
      if (state === 'visible' && !settled && (ws?.readyState !== 1 || Date.now() - lastActivity > DEAD_ON_RETURN_MS)) kick('dead_on_return');
    });
    tick = setInterval(() => log('ws_tick', { rs: ws?.readyState, buf: ws?.bufferedAmount, sentSec: +(sentSec).toFixed(1), opened }), 5000);

    const handle = (data) => {
      armIdle(idleTimeoutMs);
      lastActivity = Date.now();
      onActivity?.();
      let msg;
      try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch { return; }
      const type = msg?.message_type;
      if (!firstMsg) { firstMsg = true; log('ws_first_msg', { type }); }
      if (type === 'session_started') {
        opened = true;
        log('ws_session_started');
        onOpen?.();
        pump();
        return;
      }
      if (type === 'committed_transcript_with_timestamps') {
        const range = ranges[nextExpected++];
        log('committed', { idx: range?.index, wc: Array.isArray(msg.words) ? msg.words.length : 0 });
        if (range) onSegment({ range, text: String(msg.text || ''), words: msg.words, languageCode: msg.language_code || null, sessionStartSec });
        if (sendingDone && nextExpected >= ranges.length) finish({ ended: 'done' });
        return;
      }
      if (type === 'insufficient_audio_activity') {
        // A commit over silence: an empty segment, not a failure.
        const range = ranges[nextExpected++];
        if (range) onSegment({ range, text: '', words: [], languageCode: null, sessionStartSec });
        if (sendingDone && nextExpected >= ranges.length) finish({ ended: 'done' });
        return;
      }
      if (type === 'partial_transcript') { if (!sawPartial) { sawPartial = true; log('first_partial'); } return; }
      if (type === 'committed_transcript' || type === 'warning') return;
      log('ws_msg_other', { type });
      if (type && (type in SESSION_ERRORS || /error|exceeded|throttled|rate_limited|overflow|exhausted|terms/.test(type))) {
        finish({ ended: 'error', error: { kind: type, message: String(msg.error || type) } });
      }
    };

    ws.onmessage = (event) => handle(event.data);
    ws.onopen = () => log('ws_open');
    ws.onerror = () => { log('ws_error', { rs: ws?.readyState }); /* a close event follows; it decides */ };
    ws.onclose = (e) => {
      log('ws_close', { code: e?.code, reason: String(e?.reason || '').slice(0, 60), clean: e?.wasClean, rs: ws?.readyState, sentSec: +(sentSec).toFixed(1), opened });
      if (settled) return;
      if (sendingDone && nextExpected >= ranges.length) return finish({ ended: 'done' });
      finish({ ended: opened ? 'dropped' : 'error', error: opened ? undefined : { kind: 'connect', message: 'Could not connect' } });
    };

    async function pump() {
      try {
        const commitSet = new Set(ranges.map(r => r.endSample));
        let pos = fromSample;
        while (pos < toSample) {
          if (settled) return;
          let next = Math.min(pos + CHUNK_SAMPLES, toSample);
          for (const point of commitSet) if (point > pos && point < next) next = Math.min(next, point);
          while (ws.bufferedAmount > 1_000_000) await sleep(50);
          if (settled) return;
          const chunk = pcm.subarray(pos, next);
          ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: toBase64(chunk),
            commit: commitSet.has(next),
            sample_rate: SAMPLE_RATE,
          }));
          if (!sentSec) log('first_chunk', { bytes: chunk.byteLength });
          pos = next;
          sentSec = (pos - fromSample) / SAMPLE_RATE + sessionStartSec;
          onSent?.(pos);
          await sleep((chunk.length / SAMPLE_RATE / pace) * 1000);
        }
        sendingDone = true;
        if (nextExpected >= ranges.length) return finish({ ended: 'done' });
        armIdle(idleTimeoutMs); // the last committed events are on their way
      } catch (err) {
        log('pump_error', { msg: String(err?.message || err).slice(0, 100), name: err?.name });
        if (!settled) finish({ ended: 'dropped' });
      }
    }
  });
}

// ── The whole flow ───────────────────────────────────────────────────────────

/**
 * Transcribe (streamed to ElevenLabs), translate, and return the final lines.
 *  - wav:            16 kHz mono WAV bytes of the video's audio (engine.extractSpeechAudio)
 *  - args:           { target_language, source_language? }
 *  - deps.confirmContinue({ atSec, keptLines, reason }) → Promise<boolean>: asked when the connection drops
 *  - deps.onProgress({ percent, stage, text, lines, coveredEnd })
 *  - deps.signal:    abort to cancel (closes the socket)
 * Throws StreamingCaptionsError (partial lines kept on `.lines`) or an Error with code 'cancelled'.
 */
export async function runStreamingCaptions(args, wav, deps = {}) {
  const { signal: outer, stallMs = STALL_MS, log = () => {}, visibility = pageVisibility } = deps;
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  if (outer?.aborted) ctl.abort(); else outer?.addEventListener?.('abort', onOuterAbort, { once: true });
  const state = { stalled: false, paused: false, opened: false, lastProgress: Date.now(), getLines: () => [], kick: null, pickingUp: false, hiddenDuringRun: false };
  const interval = Math.max(10, Math.min(1000, Math.floor(stallMs / 4)));
  let lastTimerTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTimerTick;
    lastTimerTick = now;
    if (state.paused || ctl.signal.aborted) return;
    if (gap > Math.max(3000, interval * 6)) {
      // The page itself was frozen (a phone backgrounding the tab): that is not "no progress". Check the socket, give it a fresh window.
      log('timer_gap', { gapMs: gap });
      state.lastProgress = now;
      state.pickingUp = true;
      state.kick?.('thawed');
      return;
    }
    const quiet = now - state.lastProgress;
    if (quiet > stallMs) {
      log('stall', { quietMs: quiet, opened: state.opened, run: Boolean(state.kick) });
      state.lastProgress = now;
      if (state.kick) { state.kick('stalled'); return; } // a stuck stream resumes (auto-resume budget), it does not fail
      state.stalled = true; // nothing is streaming (a token request or a translation hangs): stop with a clear error
      ctl.abort();
    }
  }, interval);
  const unwatch = visibility.subscribe((v) => {
    if (v === 'hidden') { state.hiddenDuringRun = true; log('hidden'); return; }
    if (state.hiddenDuringRun) { state.pickingUp = true; state.lastProgress = Date.now(); }
  });
  try {
    return await runStreamingCaptionsCore(args, wav, { ...deps, signal: ctl.signal }, state);
  } catch (err) {
    if (state.stalled && !outer?.aborted && err?.code === 'cancelled') {
      throw new StreamingCaptionsError(STREAMING_MESSAGES.stalled, { code: 'stalled', lines: state.getLines(), neverStarted: !state.opened });
    }
    if (err && typeof err === 'object' && err.code !== 'cancelled') err.neverStarted = !state.opened;
    throw err;
  } finally {
    clearInterval(timer);
    unwatch();
    outer?.removeEventListener?.('abort', onOuterAbort);
  }
}

async function runStreamingCaptionsCore(args, wav, deps, state) {
  const {
    headers = {}, signal, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket,
    sleep = wait, pace = getStreamPace(), onProgress = () => {}, confirmContinue = async () => false,
    mint = mintStreamingToken, idleTimeoutMs, connectTimeoutMs, maxSessions = 20, rangeAttempts = 2,
    autoResumes = AUTO_RESUMES, resumeBackoffMs = RESUME_BACKOFF_MS, log = () => {},
  } = deps;
  const touch = () => { state.lastProgress = Date.now(); };
  const targetLanguage = args.target_language;
  const sourceLanguage = args.source_language || 'auto';
  if (!WebSocketImpl) throw new StreamingCaptionsError('This browser cannot stream audio', { code: 'unsupported_in_browser' });

  const decodeStart = Date.now();
  let pcm;
  try { pcm = wavToPcm16k(wav); } catch (err) { log('decode_error', { code: err?.code, msg: String(err?.message || err).slice(0, 100) }); throw err; }
  const totalSec = pcm.length / SAMPLE_RATE;
  if (totalSec > MAX_AUDIO_SECONDS) throw new StreamingCaptionsError(`Audio is longer than ${MAX_AUDIO_SECONDS / 60} minutes`, { code: 'audio_too_long', status: 413 });
  if (!pcm.length) throw new StreamingCaptionsError('The file has no audio track', { code: 'no_audio' });

  const points = planCommitPoints(pcm);
  const ranges = points.map((end, index) => {
    const startSample = index === 0 ? 0 : points[index - 1];
    return { index, startSample, endSample: end, start: startSample / SAMPLE_RATE, end: end / SAMPLE_RATE, status: 'pending', attempts: 0, lines: [], raw: null, error: null };
  });
  log('plan', { dur: +totalSec.toFixed(1), samples: pcm.length, ranges: ranges.length, pace, decMs: Date.now() - decodeStart });
  const language = { detected: null };
  let percentFloor = PREP_PERCENT;
  let sessionId = null;
  let sentSecAbs = 0; // audio seconds handed to the socket so far (monotonic, across resumed sessions)
  let sessionOpen = false; // ElevenLabs accepted the current socket
  let translateChain = Promise.resolve();
  const lastTexts = [];

  const doneSec = () => ranges.filter(r => r.status === 'done').reduce((a, r) => a + (r.end - r.start), 0);
  const allLines = () => ranges.filter(r => r.status === 'done').flatMap(r => r.lines);
  const coveredEnd = () => { let end = 0; for (const r of ranges) { if (r.status !== 'done') break; end = r.end; } return end; };
  // Percent: 5 once the audio is decoded; then half audio sent, half transcribed AND translated; never above 99.
  const computePercent = () => Math.min(PERCENT_CAP, PREP_PERCENT + Math.floor((100 - PREP_PERCENT - 1) * (0.5 * Math.min(1, sentSecAbs / totalSec) + 0.5 * Math.min(1, doneSec() / totalSec))));
  const stageNow = () => {
    if (!sessionOpen) return 'connecting';
    return sentSecAbs >= totalSec - 0.05 && ranges.some(r => r.status === 'transcribed') ? 'translating' : 'listening';
  };
  const STAGE_TEXT = { connecting: 'Connecting…', listening: 'Listening…', translating: 'Translating…' };
  let lastStage = null;
  const report = () => {
    touch();
    const stage = stageNow();
    const before = percentFloor;
    percentFloor = Math.max(percentFloor, computePercent());
    if (percentFloor !== before || stage !== lastStage) log('pct', { p: percentFloor, stage });
    lastStage = stage;
    onProgress({
      percent: percentFloor,
      stage,
      text: STAGE_TEXT[stage],
      pickingUp: state.pickingUp, // the tab was away and the stream is being picked up again
      lines: allLines(),
      coveredEnd: coveredEnd(),
      ranges: ranges.map(({ index, start, end, status }) => ({ index, start, end, status })),
    });
  };
  state.getLines = allLines;
  report(); // decoded and planned: 5%, "Connecting…" until the socket is accepted

  // Translate finished ranges one at a time, in order, while later audio is still streaming.
  const enqueueTranslation = (range, lines) => {
    translateChain = translateChain.then(async () => {
      if (signal?.aborted) return;
      try {
        const out = [];
        for (let at = 0; at < lines.length; at += TRANSLATE_BATCH) {
          const batch = lines.slice(at, at + TRANSLATE_BATCH);
          touch();
          log('tr_req', { n: batch.length });
          const t0 = Date.now();
          const translated = await translateBatch(batch, { targetLanguage, sourceLanguage, context: lastTexts.slice(-2), sessionId, headers, fetchImpl, sleep, signal });
          log('tr_res', { ok: true, n: translated.length, ms: Date.now() - t0 });
          const byIndex = new Map(translated.map(t => [t.i, t]));
          batch.forEach((l, k) => {
            const t = byIndex.get(k);
            out.push({ start: l.start, end: l.end, text: t?.text || l.text, translation: t?.translation || '' });
          });
        }
        range.lines = out;
        range.raw = null;
        range.status = 'done';
        for (const l of out) lastTexts.push(l.text);
      } catch (err) {
        if (err.code === 'cancelled' || signal?.aborted) return;
        log('tr_res', { ok: false, code: err.code, status: err.status });
        range.status = 'failed';
        range.error = err;
        range.raw = lines; // transcribed fine: a retry only translates again
      }
      report();
    });
    return translateChain;
  };

  const onSegment = ({ range, text, words, languageCode, sessionStartSec }) => {
    if (languageCode && !language.detected) language.detected = languageCode;
    const rangeStartInSession = range.start - sessionStartSec;
    const mapped = offsetWords(words, { sessionStartSec, rangeStartInSession, rangeStartAbs: range.start });
    const clean = String(text || '').trim();
    let lines;
    if (mapped.length) {
      lines = buildLines({ segments: [{ start: mapped[0].start, end: mapped[mapped.length - 1].end, text: clean || mapped.map(w => w.w).join(' ') }], words: mapped });
    } else if (clean) {
      lines = buildLines({ segments: [{ start: range.start, end: range.end, text: clean }], words: [] });
    } else {
      lines = [];
    }
    lines = lines.filter(l => l.text).map(l => ({ start: Math.max(0, l.start), end: Math.min(totalSec, Math.max(l.end, l.start + 0.05)), text: l.text }));
    if (!lines.length) { range.status = 'done'; range.lines = []; report(); return; }
    range.status = 'transcribed';
    report();
    enqueueTranslation(range, lines);
  };

  // A hung call (a token request that never answers) must not outlive an abort (stall watchdog or the user's Stop).
  const raceAbort = (promise) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    signal?.addEventListener?.('abort', () => reject(cancelled()), { once: true });
    promise.then(resolve, reject);
  });

  const todoRanges = () => ranges.filter(r => r.status !== 'done');
  const progressed = () => ranges.some(r => r.status === 'done' || r.status === 'transcribed');

  const startedAt = Date.now();
  let sessions = 0;
  let resumesUsed = 0;
  for (;;) {
    if (signal?.aborted) throw cancelled();
    const todo = todoRanges();
    if (!todo.length) break;

    // A range that was transcribed but not translated only needs its translation again.
    const retryTranslate = todo.filter(r => r.raw && r.attempts < rangeAttempts);
    if (retryTranslate.length) {
      for (const r of retryTranslate) { r.attempts += 1; r.status = 'transcribed'; enqueueTranslation(r, r.raw); }
      await translateChain;
      continue;
    }
    const streamable = todo.filter(r => !r.raw);
    if (!streamable.length) break;
    // One run covers a contiguous stretch of unfinished ranges.
    const run = [];
    for (const r of streamable) {
      if (run.length && r.index !== run[run.length - 1].index + 1) break;
      run.push(r);
    }
    if (run.some(r => r.attempts >= rangeAttempts)) break; // this range already used its retry
    if (++sessions > maxSessions) break;
    run.forEach(r => { r.attempts += 1; r.status = 'pending'; r.error = null; });

    let connection;
    for (let tries = 1; ; tries++) {
      try {
        log('token_req', { try: tries, resume: Boolean(sessionId) });
        const tokenStart = Date.now();
        touch();
        connection = await raceAbort(mint({ headers, sourceLanguage, resumeSessionId: sessionId, fetchImpl }));
        touch();
        log('token_res', { ok: true, ms: Date.now() - tokenStart });
        break;
      } catch (err) {
        log('token_res', { ok: false, code: err?.code, status: err?.status, msg: String(err?.message || '').slice(0, 80) });
        if (signal?.aborted) throw cancelled();
        const transient = err.code === 'network' || err.code === 'streaming_captions_busy' || err.status === 502;
        if (tries >= 2 || !transient) throw new StreamingCaptionsError(err.message, { code: err.code || 'streaming_failed', status: err.status, lines: allLines() });
        await sleep(800);
      }
    }
    sessionId = connection.sessionId || sessionId;
    run.forEach(r => { r.status = 'running'; });
    sessionOpen = false;
    report();

    const result = await streamRun({ pcm, ranges: run, connection, WebSocketImpl, pace, sleep, signal, idleTimeoutMs, connectTimeoutMs, onSegment, log,
      onOpen: () => {
        sessionOpen = true; state.opened = true; report();
        if (state.pickingUp) setTimeout(() => { state.pickingUp = false; report(); }, 4000);
      },
      onActivity: touch,
      registerKick: (fn) => { state.kick = fn; },
      visibility: deps.visibility,
      onSent: (pos) => {
        touch();
        const wasAllSent = sentSecAbs >= totalSec - 0.05;
        sentSecAbs = Math.max(sentSecAbs, pos / SAMPLE_RATE);
        if (computePercent() > percentFloor || (!wasAllSent && sentSecAbs >= totalSec - 0.05)) report();
      },
    });
    // Whatever the socket delivered is translated before deciding what happens next.
    await translateChain;
    if (signal?.aborted) throw cancelled();
    for (const r of run) if (r.status === 'running' || r.status === 'pending') { r.status = 'failed'; r.error = result.error || null; }

    state.kick = null;
    const kind = result.error?.kind;
    const cause = result.ended === 'dropped' ? 'dropped' : (result.ended === 'error' ? (SESSION_ERRORS[kind] || (kind === 'timeout' || kind === 'connect' ? 'dropped' : 'failed')) : null);
    const failed = ranges.filter(r => r.status === 'failed' && !r.raw);

    if ((cause === 'dropped' || cause === 'time_limit') && failed.length) {
      const unfinished = () => { failed.forEach(r => { r.status = 'pending'; r.attempts = Math.max(0, r.attempts - 1); }); }; // a resume is not a per-range retry
      if (resumesUsed < autoResumes) {
        // The budget belongs to the session (the whole job), not to a range: a few quiet reconnects first.
        log('auto_resume', { n: resumesUsed + 1, cause });
        await sleep(resumeBackoffMs[Math.min(resumesUsed, resumeBackoffMs.length - 1)] ?? 0);
        resumesUsed += 1;
        if (signal?.aborted) throw cancelled();
        unfinished();
        continue;
      }
      if (progressed()) {
        const atSec = coveredEnd();
        // Keep what is finished and ask whether to resume from the first unfinished range with a fresh token.
        state.paused = true;
        let resume;
        try { resume = await confirmContinue({ atSec, keptLines: allLines(), reason: cause }); } finally { state.paused = false; touch(); }
        if (!resume) {
          throw new StreamingCaptionsError(cause === 'time_limit' ? STREAMING_MESSAGES.timeLimit(atSec) : STREAMING_MESSAGES.connectionDropped(atSec), { code: 'declined_continue', lines: allLines(), atSec });
        }
        resumesUsed = 0; // Continue grants a fresh budget
        unfinished();
        continue;
      }
    }
    if (cause === 'auth' && failed.length) {
      // A token that expired or was already used: one silent retry with a fresh one.
      failed.forEach(r => { r.status = 'pending'; r.attempts = Math.max(0, r.attempts - 1); });
      if (sessions >= maxSessions) break;
      continue;
    }
    if (cause === 'unavailable') throw new StreamingCaptionsError(STREAMING_MESSAGES.unavailable, { code: 'unavailable', lines: allLines() });
    if (cause === 'busy' && failed.length) {
      if (failed.every(r => r.attempts < rangeAttempts)) {
        await sleep(2000);
        failed.forEach(r => { r.status = 'pending'; });
        continue;
      }
      throw new StreamingCaptionsError(STREAMING_MESSAGES.busy, { code: 'busy', lines: allLines() });
    }
    // Any other failure: each range retries once in a new session (per-range retry).
    failed.forEach(r => { if (r.attempts < rangeAttempts) r.status = 'pending'; });
  }

  await translateChain;
  if (signal?.aborted) throw cancelled();
  const failedRanges = ranges.filter(r => r.status !== 'done').map(({ index, start, end, error }) => ({ index, start, end, code: error?.code || null }));
  if (failedRanges.length) {
    const withCode = ranges.find(r => r.status !== 'done' && r.error?.code && r.error.code !== 'network');
    throw new StreamingCaptionsError(STREAMING_MESSAGES.couldntFinish, { code: withCode?.error?.code || 'ranges_failed', status: withCode?.error?.status, lines: allLines(), failedRanges });
  }
  const lines = allLines().sort((a, b) => a.start - b.start);
  if (!lines.length) throw new StreamingCaptionsError('No speech detected in the audio', { code: 'no_speech' });
  report();
  return {
    lines,
    language: language.detected,
    targetLanguage,
    audioSeconds: totalSec,
    sessionId,
    elapsedMs: Date.now() - startedAt,
    translatedCount: lines.filter(l => l.translation).length,
  };
}

/** Consented server fallback: upload the video and the final lines; the server burns with the same ASS style. */
export async function burnStreamingCaptionsOnServer({ videoBytes, lines, language, targetLanguage, headers = {}, fetchImpl = fetch }) {
  const form = new FormData();
  form.append('video', new Blob([videoBytes], { type: 'video/mp4' }), 'input.mp4');
  form.append('lines', JSON.stringify(lines));
  if (language) form.append('language', language);
  if (targetLanguage) form.append('target_language', targetLanguage);
  const res = await fetchImpl('/api/streaming-captions/burn', { method: 'POST', headers, body: form });
  if (!res.ok) throw httpError(await res.json().catch(() => ({})), res, `Burn-in failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}
