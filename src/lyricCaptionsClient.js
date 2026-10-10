// Browser side of lyric_captions: pull the audio track out of the video (WebAudio, no upload of
// the video for transcription), send 16 kHz mono WAV to POST /api/lyric-captions, poll the job,
// then burn. The web app has no client-side ffmpeg (all edits run on the server), so the burn uses
// the server fallback POST /api/lyric-captions/:jobId/burn. See docs/api/LYRIC_CAPTIONS.md.

import { abortableFetch as fetch } from './abortableFetch.js';

export const TARGET_SAMPLE_RATE = 16000;
export const MAX_AUDIO_SECONDS = 600;

/** 16-bit PCM mono WAV from float samples in [-1, 1]. */
export function encodeWavMono16(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

/** Decode the video's audio and resample it to 16 kHz mono WAV in the browser. */
export async function extractAudioWav(videoBytes, { AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext, OfflineCtx = globalThis.OfflineAudioContext } = {}) {
  if (!AudioCtx || !OfflineCtx) throw new Error('This browser cannot decode audio (no WebAudio)');
  const ctx = new AudioCtx();
  let decoded;
  try {
    const copy = videoBytes.buffer.slice(videoBytes.byteOffset, videoBytes.byteOffset + videoBytes.byteLength);
    decoded = await ctx.decodeAudioData(copy);
  } catch {
    throw new Error('Could not read an audio track from this video');
  } finally {
    ctx.close?.();
  }
  if (decoded.duration > MAX_AUDIO_SECONDS) throw new Error(`Lyric captions support up to ${MAX_AUDIO_SECONDS / 60} minutes of audio`);
  const offline = new OfflineCtx(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded; // multi-channel input is down-mixed to the mono destination
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return encodeWavMono16(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
}

/** Poll GET /api/jobs/:id until it finishes; returns the final job body. */
export async function pollJob(pollUrl, { headers = {}, intervalMs = 3000, timeoutMs = 10 * 60 * 1000, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(pollUrl, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Job poll failed (${res.status})`);
    if (body.status === 'succeeded') return body;
    if (body.status === 'failed') {
      const err = new Error(body.error || 'Lyric captions failed');
      err.code = body.code;
      throw err;
    }
    if (Date.now() > deadline) throw new Error('Lyric captions timed out');
    await sleep(intervalMs);
    intervalMs = Math.min(intervalMs * 1.5, 10_000); // stay well under the 100-per-15-min API budget
  }
}

/** Chat-safe description of the song (no lyric text). */
export function describeSong(song) {
  if (!song) return 'No song identified (treated as speech).';
  const by = song.artist ? ` by ${song.artist}` : '';
  const src = song.source === 'web_search' ? 'verified with web search' : 'from model knowledge, not web-verified';
  return `Song: "${song.title}"${by} (${song.confidence} confidence, ${src})${song.url ? ` ${song.url}` : ''}.`;
}

/**
 * Whole web flow. `deps` lets tests replace the WebAudio extraction.
 * Returns { burned: Uint8Array, summary, result } — result.lines stay in the browser.
 */
export async function runLyricCaptionsWeb(args, videoBytes, { headers = {}, extract = extractAudioWav, poll = pollJob, size = null, burn = null } = {}) {
  const wav = await extract(videoBytes);
  const form = new FormData();
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  // With the frame size the result carries a ready-made ASS script, which the browser can burn itself.
  if (size) { form.append('width', String(size.width)); form.append('height', String(size.height)); }
  for (const key of ['target_language', 'source_language', 'mode', 'position_from_bottom_pct', 'font_size']) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') form.append(key, String(args[key]));
  }
  const start = await fetch('/api/lyric-captions', { method: 'POST', headers, body: form });
  const started = await start.json().catch(() => ({}));
  if (!start.ok) {
    const err = new Error(started.error || `Lyric captions failed (${start.status})`);
    err.code = started.code;
    throw err;
  }
  const job = await poll(started.pollUrl || `/api/jobs/${started.jobId}`, { headers });
  const resultRes = await fetch(started.resultUrl || `/api/jobs/${started.jobId}/result`, { headers });
  if (!resultRes.ok) throw new Error(`Could not fetch lyric captions (${resultRes.status})`);
  const result = await resultRes.json();

  // Server burn: uploads the video. In-browser editing passes `burn` and only falls back to this
  // after the user agrees.
  const burnOnServer = async () => {
    const burnForm = new FormData();
    burnForm.append('video', new Blob([videoBytes], { type: 'video/mp4' }), 'input.mp4');
    const burnRes = await fetch(`/api/lyric-captions/${encodeURIComponent(started.jobId)}/burn`, { method: 'POST', headers, body: burnForm });
    if (!burnRes.ok) {
      const body = await burnRes.json().catch(() => ({}));
      const err = new Error(body.error || `Burn-in failed (${burnRes.status})`);
      err.code = body.code;
      throw err;
    }
    return new Uint8Array(await burnRes.arrayBuffer());
  };
  const burned = burn ? await burn(result, burnOnServer) : await burnOnServer();
  return { burned, summary: job.summary || null, result, audioBytes: wav.byteLength };
}
