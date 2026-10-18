// @vitest-environment node
// Browser side of streaming captions with a fake ElevenLabs WebSocket and a fake translate endpoint.
import { describe, it, expect, vi } from 'vitest';
import {
  planCommitPoints, wavToPcm16k, getStreamPace, offsetWords, runStreamingCaptions, friendlyStreamingError, streamingAvailable,
  mintStreamingToken, StreamingCaptionsError, STREAMING_MESSAGES, CONSENT_COPY, SAMPLE_RATE, CHUNK_SAMPLES, GRID_SAMPLES, formatClock,
} from '../streamingCaptions.js';
import { encodeWavMono16 } from '../lyricCaptionsClient.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Float samples: noise ("speech") with silent gaps at the given [fromSec, toSec] spans. */
function makeWav(seconds, silences = []) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const f = new Float32Array(n);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    f[i] = ((seed / 0x7fffffff) - 0.5) * 0.6;
  }
  for (const [a, b] of silences) for (let i = Math.round(a * SAMPLE_RATE); i < Math.min(n, Math.round(b * SAMPLE_RATE)); i++) f[i] = 0;
  return encodeWavMono16(f, SAMPLE_RATE);
}

const connectionFor = (n = 1) => ({
  token: `sutkn_${n}`, sessionId: 'sess-1', wsUrl: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
  query: { model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', include_timestamps: 'true', commit_strategy: 'manual' },
});

/**
 * A fake ElevenLabs realtime socket. `behavior(ctx)` is called for every commit chunk and returns
 * messages to deliver (objects), 'drop' to close, or undefined for no reply.
 */
function socketFactory(behavior) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.bufferedAmount = 0;
      this.commitCount = 0;
      sockets.push(this);
      queueMicrotask(() => this.#deliver({ message_type: 'session_started', session_id: 's' }));
    }
    #deliver(msg) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(msg) }); }
    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);
      if (msg.commit) {
        const ctx = { socket: this, commitIndex: this.commitCount++, sockets };
        const reply = behavior(ctx);
        queueMicrotask(() => {
          if (reply === 'drop') return this.#close();
          for (const m of [].concat(reply || [])) this.#deliver(m);
        });
      }
    }
    #close() { if (!this.closed) { this.closed = true; this.onclose?.({}); } }
    close() { this.closed = true; }
    samplesSent() { return this.sent.reduce((a, m) => a + atob(m.audio_base_64).length / 2, 0); }
  }
  return { FakeSocket, sockets };
}

const segmentMsg = (text, words) => ({ message_type: 'committed_transcript_with_timestamps', text, language_code: 'en', words });
const wordsAt = (t0, list) => list.map((w, i) => ({ text: w, start: t0 + i * 0.4, end: t0 + i * 0.4 + 0.3, type: 'word' }));
const okTranslate = () => vi.fn(async (url, init) => {
  const body = JSON.parse(init.body);
  return { ok: true, status: 200, json: async () => ({ lines: body.segments.map(s => ({ i: s.i, text: s.text, translation: `译:${s.text}` })) }) };
});

const baseDeps = (over = {}) => ({
  sleep: async () => {}, mint: async () => connectionFor(), idleTimeoutMs: 200, connectTimeoutMs: 200, ...over,
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('commit planning', () => {
  it('commits at the quiet spots about every 20-30 s, on a 0.1 s grid, and always at the end', () => {
    const wav = makeWav(70, [[24, 24.6], [49.2, 49.8]]);
    const pcm = wavToPcm16k(wav);
    const points = planCommitPoints(pcm);
    expect(points).toHaveLength(3);
    expect(points[0] / SAMPLE_RATE).toBeGreaterThan(24);
    expect(points[0] / SAMPLE_RATE).toBeLessThan(24.6);
    expect(points[1] / SAMPLE_RATE).toBeGreaterThan(49.2);
    expect(points[1] / SAMPLE_RATE).toBeLessThan(49.8);
    expect(points[2]).toBe(pcm.length);
    points.slice(0, -1).forEach(p => expect(p % GRID_SAMPLES).toBe(0));
    const spans = points.map((p, i) => (p - (points[i - 1] ?? 0)) / SAMPLE_RATE);
    spans.slice(0, -1).forEach(s => { expect(s).toBeGreaterThanOrEqual(20); expect(s).toBeLessThanOrEqual(30); });
  });

  it('a clip of 30 s or less is one segment; no rapid-fire commits', () => {
    expect(planCommitPoints(wavToPcm16k(makeWav(12)))).toEqual([12 * SAMPLE_RATE]);
    expect(planCommitPoints(wavToPcm16k(makeWav(30)))).toEqual([30 * SAMPLE_RATE]);
    const long = planCommitPoints(wavToPcm16k(makeWav(300)));
    long.slice(0, -1).forEach((p, i) => expect((p - (long[i - 1] ?? 0)) / SAMPLE_RATE).toBeGreaterThanOrEqual(20));
  });
});

describe('audio decoding', () => {
  it('reads the 16 kHz mono WAV the engine writes', () => {
    const pcm = wavToPcm16k(makeWav(1));
    expect(pcm).toBeInstanceOf(Int16Array);
    expect(pcm.length).toBe(SAMPLE_RATE);
  });
  it('downmixes and resamples other layouts (8 kHz stereo)', () => {
    const frames = 8000;
    const buf = new ArrayBuffer(44 + frames * 4);
    const v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + frames * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, 8000, true);
    v.setUint32(28, 32000, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, frames * 4, true);
    for (let i = 0; i < frames; i++) { v.setInt16(44 + i * 4, 1000, true); v.setInt16(46 + i * 4, 3000, true); }
    const pcm = wavToPcm16k(new Uint8Array(buf));
    expect(pcm.length).toBe(16000);
    expect(pcm[100]).toBe(2000);
  });
  it('rejects non-WAV bytes', () => {
    expect(() => wavToPcm16k(new Uint8Array(100))).toThrow(StreamingCaptionsError);
  });
});

describe('pacing flag', () => {
  const storage = (v) => ({ getItem: () => v });
  it('defaults to real time; explicit option or fc.streamPace flag is clamped to 0.5-4', () => {
    expect(getStreamPace(undefined, storage(null))).toBe(1);
    expect(getStreamPace(3, storage(null))).toBe(3);
    expect(getStreamPace(undefined, storage('2'))).toBe(2);
    expect(getStreamPace(10, storage(null))).toBe(4);
    expect(getStreamPace(0.1, storage(null))).toBe(0.5);
    expect(getStreamPace('nope', storage('x'))).toBe(1);
  });
});

describe('timestamps', () => {
  it('session-absolute word times just get the session offset', () => {
    const words = wordsAt(26.2, ['Hello', 'there']);
    const out = offsetWords(words, { sessionStartSec: 0, rangeStartInSession: 26, rangeStartAbs: 26 });
    expect(out[0]).toMatchObject({ w: 'Hello', start: 26.2 });
  });
  it('segment-relative word times (start near 0) are shifted by the range start', () => {
    const words = wordsAt(0.2, ['Hello', 'there']);
    const out = offsetWords(words, { sessionStartSec: 0, rangeStartInSession: 26, rangeStartAbs: 26 });
    expect(out[0].start).toBeCloseTo(26.2);
  });
  it('a resumed session adds its own start offset; spacing tokens are dropped', () => {
    const words = [{ text: 'Hi', start: 1, end: 1.3, type: 'word' }, { text: ' ', start: 1.3, end: 1.4, type: 'spacing' }];
    const out = offsetWords(words, { sessionStartSec: 26, rangeStartInSession: 0, rangeStartAbs: 26 });
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe(27);
  });
});

// ── the flow ─────────────────────────────────────────────────────────────────

describe('runStreamingCaptions', () => {
  const twoSegments = ({ commitIndex }) => (commitIndex === 0
    ? segmentMsg('Hello my friend', wordsAt(0.5, ['Hello', 'my', 'friend']))
    : segmentMsg('Good to see you', wordsAt(27.5, ['Good', 'to', 'see', 'you'])));

  it('streams paced PCM, commits at silence, translates in order and reports monotonic percent <= 99', async () => {
    const wav = makeWav(52, [[25.7, 26.3]]);
    const { FakeSocket, sockets } = socketFactory(twoSegments);
    const fetchImpl = okTranslate();
    const sleeps = [];
    const progress = [];
    const out = await runStreamingCaptions({ target_language: 'zh-Hans' }, wav, baseDeps({
      WebSocketImpl: FakeSocket, fetchImpl, pace: 1,
      sleep: async (ms) => { sleeps.push(ms); },
      onProgress: (p) => progress.push(p),
    }));
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    expect(socket.url).toContain('wss://api.elevenlabs.io/v1/speech-to-text/realtime?');
    expect(socket.url).toContain('include_timestamps=true');
    expect(socket.url).toContain('token=sutkn_1');
    // All audio sent, in small chunks, with exactly two commits (silence cut + end).
    expect(socket.samplesSent()).toBe(52 * SAMPLE_RATE);
    expect(socket.sent.every(m => m.message_type === 'input_audio_chunk' && m.sample_rate === 16000)).toBe(true);
    expect(socket.sent.filter(m => m.commit)).toHaveLength(2);
    expect(Math.max(...socket.sent.map(m => atob(m.audio_base_64).length / 2))).toBeLessThanOrEqual(CHUNK_SAMPLES);
    // Real-time pacing: the waits add up to the audio length.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(52000, -2);
    // Result.
    expect(out.lines.map(l => l.text)).toEqual(['Hello my friend', 'Good to see you']);
    expect(out.lines.map(l => l.translation)).toEqual(['译:Hello my friend', '译:Good to see you']);
    expect(out.lines[1].start).toBeGreaterThan(26);
    expect(out).toMatchObject({ targetLanguage: 'zh-Hans', language: 'en', translatedCount: 2 });
    // Progress: numeric, monotonic, never above 99 (the UI shows 100 after the burn).
    const percents = progress.map(p => p.percent);
    expect(percents.length).toBeGreaterThan(2);
    percents.forEach((p, i) => { expect(Number.isInteger(p)).toBe(true); expect(p).toBeLessThanOrEqual(99); if (i) expect(p).toBeGreaterThanOrEqual(percents[i - 1]); });
    expect(percents.at(-1)).toBe(99);
    expect(new Set(progress.map(p => p.stage))).toEqual(new Set(['listening', 'translating']));
    expect(progress.at(-1).lines).toHaveLength(2);
    // Translation batches go out in order with the earlier text as context.
    const bodies = fetchImpl.mock.calls.map(c => JSON.parse(c[1].body));
    expect(bodies[0].target_language).toBe('zh-Hans');
    expect(bodies[1].context).toEqual(['Hello my friend']);
  });

  it('pace 4 sends the same audio in a quarter of the wall time', async () => {
    const { FakeSocket } = socketFactory(twoSegments);
    const sleeps = [];
    await runStreamingCaptions({ target_language: 'es' }, makeWav(52, [[25.7, 26.3]]), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl: okTranslate(), pace: 4, sleep: async (ms) => { sleeps.push(ms); } }));
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeCloseTo(13000, -2);
  });

  it('cancel closes the socket, stops sending, and rejects with code cancelled', async () => {
    const wav = makeWav(52, [[25.7, 26.3]]);
    const { FakeSocket, sockets } = socketFactory(twoSegments);
    const controller = new AbortController();
    let sentAtCancel = 0;
    const promise = runStreamingCaptions({ target_language: 'es' }, wav, baseDeps({
      WebSocketImpl: FakeSocket, fetchImpl: okTranslate(), signal: controller.signal,
      sleep: async () => {
        if (sockets[0]?.sent.length === 5) { sentAtCancel = sockets[0].sent.length; controller.abort(); }
        await Promise.resolve();
      },
    }));
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(sockets[0].closed).toBe(true);
    expect(sockets[0].sent.length).toBeLessThanOrEqual(sentAtCancel + 1);
  });

  it('a dropped connection keeps the finished lines and resumes from the first unfinished range with a fresh token', async () => {
    const wav = makeWav(52, [[25.7, 26.3]]);
    const mints = [];
    const { FakeSocket, sockets } = socketFactory(({ commitIndex, sockets: all }) => {
      if (all.length === 1) return commitIndex === 0 ? segmentMsg('Hello my friend', wordsAt(0.5, ['Hello', 'my', 'friend'])) : 'drop';
      return segmentMsg('Good to see you', wordsAt(1.0, ['Good', 'to', 'see', 'you'])); // second session: times relative to its start
    });
    const confirm = vi.fn(async () => true);
    const out = await runStreamingCaptions({ target_language: 'zh-Hans' }, wav, baseDeps({
      WebSocketImpl: FakeSocket, fetchImpl: okTranslate(), confirmContinue: confirm,
      mint: async (o) => { mints.push(o.resumeSessionId ?? null); return connectionFor(mints.length); },
    }));
    expect(confirm).toHaveBeenCalledTimes(1);
    const ask = confirm.mock.calls[0][0];
    expect(ask.atSec).toBeCloseTo(sockets[0].sent.find(m => m.commit).audio_base_64 ? ask.atSec : 0);
    expect(ask.atSec).toBeGreaterThan(25);
    expect(ask.keptLines.map(l => l.text)).toEqual(['Hello my friend']);
    expect(ask.reason).toBe('dropped');
    expect(mints).toEqual([null, 'sess-1']); // second token resumes the same session (same edit)
    expect(sockets).toHaveLength(2);
    // The second socket carries only the audio after the last finished range.
    expect(sockets[1].samplesSent() + ask.atSec * SAMPLE_RATE).toBeCloseTo(52 * SAMPLE_RATE, -1);
    expect(sockets[1].url).toContain('token=sutkn_2');
    expect(out.lines.map(l => l.text)).toEqual(['Hello my friend', 'Good to see you']);
    expect(out.lines[1].start).toBeGreaterThan(ask.atSec); // offset by the resume point
  });

  it('declining to continue throws the Design message with the kept lines', async () => {
    const { FakeSocket } = socketFactory(({ commitIndex }) => (commitIndex === 0 ? segmentMsg('Hello', wordsAt(0.5, ['Hello'])) : 'drop'));
    const error = await runStreamingCaptions({ target_language: 'es' }, makeWav(52, [[25.7, 26.3]]), baseDeps({
      WebSocketImpl: FakeSocket, fetchImpl: okTranslate(), confirmContinue: async () => false,
    })).catch(e => e);
    expect(error).toBeInstanceOf(StreamingCaptionsError);
    expect(error.code).toBe('declined_continue');
    expect(error.message).toMatch(/^The connection dropped at 0:2\d\. Captions up to there are kept\.$/);
    expect(error.lines.map(l => l.text)).toEqual(['Hello']);
  });

  it('session_time_limit_exceeded is a resume prompt with its own wording', async () => {
    const { FakeSocket } = socketFactory(({ commitIndex }) => (commitIndex === 0
      ? segmentMsg('Hello', wordsAt(0.5, ['Hello']))
      : { message_type: 'session_time_limit_exceeded', error: 'limit' }));
    const confirm = vi.fn(async () => false);
    const error = await runStreamingCaptions({ target_language: 'es' }, makeWav(52, [[25.7, 26.3]]), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl: okTranslate(), confirmContinue: confirm })).catch(e => e);
    expect(confirm.mock.calls[0][0].reason).toBe('time_limit');
    expect(error.message).toMatch(/^The transcription session reached its time limit at 0:2\d\. Captions up to there are kept\.$/);
  });

  it.each(['rate_limited', 'queue_overflow', 'commit_throttled'])('%s: waits and retries once, then reports the busy message', async (type) => {
    const { FakeSocket, sockets } = socketFactory(() => ({ message_type: type, error: 'x' }));
    const sleeps = [];
    const error = await runStreamingCaptions({ target_language: 'es' }, makeWav(10), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl: okTranslate(), sleep: async (ms) => { sleeps.push(ms); } })).catch(e => e);
    expect(error.code).toBe('busy');
    expect(error.message).toBe(STREAMING_MESSAGES.busy);
    expect(sockets).toHaveLength(2); // one retry
    expect(sleeps).toContain(2000);
  });

  it('a transient service error on the first try is retried per range and succeeds', async () => {
    const { FakeSocket, sockets } = socketFactory(({ sockets: all }) => (all.length === 1
      ? { message_type: 'transcriber_error', error: 'hiccup' }
      : segmentMsg('Hello there', wordsAt(0.5, ['Hello', 'there']))));
    const out = await runStreamingCaptions({ target_language: 'es' }, makeWav(10), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl: okTranslate() }));
    expect(sockets).toHaveLength(2);
    expect(out.lines).toHaveLength(1);
  });

  it('quota_exceeded is "unavailable", not a retry loop', async () => {
    const { FakeSocket, sockets } = socketFactory(() => ({ message_type: 'quota_exceeded', error: 'q' }));
    const error = await runStreamingCaptions({ target_language: 'es' }, makeWav(10), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl: okTranslate() })).catch(e => e);
    expect(error.code).toBe('unavailable');
    expect(sockets).toHaveLength(1);
  });

  it('an expired token (auth_error) is replaced with a fresh one silently', async () => {
    const { FakeSocket, sockets } = socketFactory(({ sockets: all }) => (all.length === 1
      ? { message_type: 'auth_error', error: 'expired' }
      : segmentMsg('Hello', wordsAt(0.5, ['Hello']))));
    const mints = vi.fn(async () => connectionFor());
    const out = await runStreamingCaptions({ target_language: 'es' }, makeWav(10), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl: okTranslate(), mint: mints }));
    expect(mints).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(out.lines).toHaveLength(1);
  });

  it('silence-only audio ends with no_speech; insufficient_audio_activity is not an error', async () => {
    const { FakeSocket } = socketFactory(() => ({ message_type: 'insufficient_audio_activity', error: 'quiet' }));
    const error = await runStreamingCaptions({ target_language: 'es' }, makeWav(10), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl: okTranslate() })).catch(e => e);
    expect(error.code).toBe('no_speech');
  });

  it('a socket that goes quiet is abandoned after the idle timeout (no open-ended wait)', async () => {
    const { FakeSocket, sockets } = socketFactory(() => undefined);
    const started = Date.now();
    const error = await runStreamingCaptions({ target_language: 'es' }, makeWav(10), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl: okTranslate(), idleTimeoutMs: 30 })).catch(e => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(error.message).toBe(STREAMING_MESSAGES.couldntFinish);
    expect(sockets.length).toBeLessThanOrEqual(2);
    expect(sockets.every(s => s.closed)).toBe(true);
  });

  it('a translation failure retries only the translation (no new socket); persistent failure is "couldn\'t finish"', async () => {
    const { FakeSocket, sockets } = socketFactory(() => segmentMsg('Hello there', wordsAt(0.5, ['Hello', 'there'])));
    let calls = 0;
    const fetchImpl = vi.fn(async (url, init) => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 503, json: async () => ({ error: 'down' }) };
      const body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ lines: body.segments.map(s => ({ i: s.i, text: s.text, translation: 'ok' })) }) };
    });
    const out = await runStreamingCaptions({ target_language: 'es' }, makeWav(10), baseDeps({ WebSocketImpl: FakeSocket, fetchImpl }));
    expect(out.lines[0].translation).toBe('ok');
    expect(sockets).toHaveLength(1);

    const failing = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: 'x' }) }));
    const s2 = socketFactory(() => segmentMsg('Hello there', wordsAt(0.5, ['Hello', 'there'])));
    const error = await runStreamingCaptions({ target_language: 'es' }, makeWav(10), baseDeps({ WebSocketImpl: s2.FakeSocket, fetchImpl: failing })).catch(e => e);
    expect(error.message).toBe(STREAMING_MESSAGES.couldntFinish);
    expect(error.failedRanges).toHaveLength(1);
  });

  it('audio over 10 minutes is refused before anything is sent', async () => {
    const { FakeSocket, sockets } = socketFactory(() => undefined);
    const error = await runStreamingCaptions({ target_language: 'es' }, makeWav(601), baseDeps({ WebSocketImpl: FakeSocket })).catch(e => e);
    expect(error.code).toBe('audio_too_long');
    expect(friendlyStreamingError(error)).toBe(STREAMING_MESSAGES.tooLong);
    expect(sockets).toHaveLength(0);
  });
});

describe('messages and server calls', () => {
  it('uses the Design wording', () => {
    expect(STREAMING_MESSAGES.couldntFinish).toBe("Captions couldn't finish. Nothing was changed. Try again.");
    expect(STREAMING_MESSAGES.restarted).toBe("Captions couldn't finish because the service restarted. Nothing was changed. Try again.");
    expect(STREAMING_MESSAGES.tooLong).toBe("This video's audio is too long for translated captions. Try a clip under 10 minutes.");
    expect(STREAMING_MESSAGES.unavailable).toBe("Translated captions aren't available right now. Try again later.");
    expect(STREAMING_MESSAGES.connectionDropped(34)).toBe('The connection dropped at 0:34. Captions up to there are kept.');
    expect(formatClock(125)).toBe('2:05');
    expect(CONSENT_COPY).toMatchObject({ title: 'Send the audio to ElevenLabs?', confirmLabel: 'Send audio', declineLabel: 'Not now' });
    expect(CONSENT_COPY.body).toBe("FinalCap will stream this video's audio, but not the picture, to ElevenLabs to transcribe it. ElevenLabs may keep the audio and the transcript, and FinalCap can't delete them. The text is then sent to FinalCap, which sends it to xAI (Grok) to translate.");
  });

  it('friendlyStreamingError maps every failure to one short message, never the raw server text', () => {
    const e = (code, status, message = 'Job not found') => Object.assign(new Error(message), { code, status });
    expect(friendlyStreamingError(e('job_lost', 404))).toBe(STREAMING_MESSAGES.restarted);
    expect(friendlyStreamingError(e('job_expired', 404))).toBe(STREAMING_MESSAGES.restarted);
    expect(friendlyStreamingError(e('streaming_captions_unavailable', 503))).toBe(STREAMING_MESSAGES.unavailable);
    expect(friendlyStreamingError(e(undefined, 503))).toBe(STREAMING_MESSAGES.unavailable);
    expect(friendlyStreamingError(e('streaming_captions_busy', 503))).toBe(STREAMING_MESSAGES.busy);
    expect(friendlyStreamingError(e(undefined, 429))).toBe(STREAMING_MESSAGES.busy);
    expect(friendlyStreamingError(e('audio_too_long', 413))).toBe(STREAMING_MESSAGES.tooLong);
    expect(friendlyStreamingError(e('batch_too_large', 413))).toBe(STREAMING_MESSAGES.couldntFinish);
    expect(friendlyStreamingError(new Error('Job not found'))).toBe(STREAMING_MESSAGES.couldntFinish);
    expect(friendlyStreamingError(Object.assign(new Error('Audio not sent.'), { name: 'UploadDeclinedError' }))).toBe('Audio not sent.');
  });

  it('streamingAvailable and mintStreamingToken talk to the right routes', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push([url, init]);
      if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => ({ available: true }) };
      return { ok: true, status: 200, json: async () => ({ token: 't', sessionId: 's' }) };
    };
    expect(await streamingAvailable({ fetchImpl, headers: { a: '1' } })).toBe(true);
    expect(await streamingAvailable({ fetchImpl: async () => { throw new Error('x'); } })).toBe(false);
    expect(await streamingAvailable({ fetchImpl: async () => ({ ok: true, json: async () => ({ available: false }) }) })).toBe(false);
    await mintStreamingToken({ fetchImpl, sourceLanguage: 'en', resumeSessionId: 'sess' });
    const body = JSON.parse(calls.at(-1)[1].body);
    expect(body).toEqual({ source_language: 'en', resumeSessionId: 'sess' });
    await expect(mintStreamingToken({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ code: 'streaming_captions_unavailable', error: 'x' }) }) })).rejects.toMatchObject({ code: 'streaming_captions_unavailable', status: 503 });
  });
});
