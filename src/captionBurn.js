// Burn the caption track into the picture, in the browser, the way a native app does it: decode each
// frame (WebCodecs, hardware where the device has it), draw the caption on a canvas, hardware-encode
// H.264, mux an MP4. Audio is copied through (re-encoded only when the container cannot hold it). Nothing
// is uploaded and ffmpeg.wasm is not involved, so the memory a phone needs is a frame or two, not a core.
// mediabunny does the demux/decode/encode/mux plumbing; it is loaded on first export.
import { createCaptionDrawer, loadCaptionFace } from './captionRender.js';

const STALL_MS = 45_000; // no progress for this long: give up (a decoder that never answers)

/** True when this browser can decode and encode video with WebCodecs and draw to a canvas. */
export function webCodecsAvailable(g = globalThis) {
  return typeof g.VideoDecoder === 'function' && typeof g.VideoEncoder === 'function' && typeof g.VideoFrame === 'function'
    && typeof g.document?.createElement === 'function';
}

const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/** Output size: the display size, shrunk so its long edge is at most `maxLongEdge` (0 = never shrink). */
export function outputSize(width, height, maxLongEdge = 0) {
  const scale = maxLongEdge > 0 && Math.max(width, height) > maxLongEdge ? maxLongEdge / Math.max(width, height) : 1;
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * @param {object} p
 * @param {Uint8Array} p.bytes the clip (mp4/mov)
 * @param {string} p.mime
 * @param {object} p.track the caption track (src/captionTrack.js)
 * @param {(fraction:number)=>void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 * @param {number} [p.maxLongEdge] shrink larger pictures (phones: 1920)
 * @param {string[]} [p.codecs] encoder codecs in order of preference (production: only 'avc', which Photos plays)
 * @param {object} [p.clog] client log ({ log })
 * @returns {Promise<{ bytes: Uint8Array, mime: 'video/mp4', width: number, height: number, codec: string, audio: 'copy'|'transcode'|'none' }>}
 * Throws code 'webcodecs_unsupported' (nothing to try here), 'cancelled', 'stalled', 'audio_unsupported' or
 * 'burn_failed'; the caller then saves the soft track and an SRT.
 */
export async function burnCaptionsWebCodecs({ bytes, mime = 'video/mp4', track, onProgress, signal, maxLongEdge = 0, codecs = ['avc'], clog, stallMs = STALL_MS }) {
  if (!webCodecsAvailable()) throw fail('This browser cannot decode and encode video (no WebCodecs).', 'webcodecs_unsupported');
  const log = (ev, data) => { try { clog?.log(ev, data); } catch { /* logging never breaks the export */ } };
  const startedAt = Date.now();
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(new Blob([bytes], { type: mime })), formats: mb.ALL_FORMATS });
  let conversion = null;
  let stallTimer = null;
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw fail('This file has no video track.', 'burn_failed');
    if (!(await videoTrack.canDecode())) throw fail('This browser cannot decode this video.', 'webcodecs_unsupported', { stage: 'decode' });
    const src = { width: videoTrack.displayWidth, height: videoTrack.displayHeight };
    const out = outputSize(src.width, src.height, maxLongEdge);
    const codec = await mb.getFirstEncodableVideoCodec(codecs, { width: out.width, height: out.height });
    if (!codec) throw fail('This browser cannot encode video of this size.', 'webcodecs_unsupported', { stage: 'encode' });
    log('burn_start', { bytes: bytes.byteLength, type: String(mime).split(';')[0], w: src.width, h: src.height, ow: out.width, oh: out.height, codec, lines: track.lines.length, hdr: await videoTrack.hasHighDynamicRange().catch(() => null) });

    const fontOk = await loadCaptionFace();
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = canvas.getContext('2d');
    const drawer = createCaptionDrawer(track, out.width, out.height);
    let frames = 0;

    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
    conversion = await mb.Conversion.init({
      input,
      output,
      video: {
        codec,
        forceTranscode: true,
        allowTransformationMetadata: false, // rotation is baked into the frames, so the caption is drawn upright
        width: out.width,
        height: out.height,
        fit: 'fill',
        quality: mb.QUALITY_HIGH,
        processedWidth: out.width,
        processedHeight: out.height,
        process: (sample) => {
          frames++;
          sample.draw(ctx, 0, 0, out.width, out.height);
          drawer.draw(ctx, sample.timestamp);
          return canvas;
        },
      },
      showWarnings: false,
    });
    if (!conversion.isValid) throw fail('This video cannot be converted here.', 'burn_failed', { stage: 'init' });
    const audioDropped = conversion.discardedTracks.some(d => d.track.type === 'audio');
    if (audioDropped) throw fail('This video\u2019s audio cannot be carried over here.', 'audio_unsupported');
    const audio = conversion.utilizedTracks.some(t => t.type === 'audio') ? 'present' : 'none';

    let lastPct = -1;
    const arm = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { conversion?.cancel().catch(() => {}); conversion.__stalled = true; }, stallMs);
    };
    arm();
    conversion.onProgress = (p) => {
      arm();
      onProgress?.(p);
      const pct = Math.floor(p * 4) * 25; // log 0/25/50/75 only
      if (pct !== lastPct) { lastPct = pct; log('burn_progress', { pct, frames, ms: Date.now() - startedAt }); }
    };
    const onAbort = () => conversion?.cancel().catch(() => {});
    if (signal?.aborted) onAbort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      await conversion.execute();
    } catch (error) {
      if (error?.name === 'ConversionCanceledError' || conversion.state === 'canceled') {
        throw conversion.__stalled ? fail('The caption export stopped making progress.', 'stalled') : fail('Export cancelled.', 'cancelled');
      }
      throw fail(String(error?.message || error).slice(0, 120), 'burn_failed', { stage: 'run' });
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
    }
    if (conversion.state === 'canceled') throw conversion.__stalled ? fail('The caption export stopped making progress.', 'stalled') : fail('Export cancelled.', 'cancelled');
    const buffer = output.target.buffer;
    if (!buffer?.byteLength) throw fail('The export produced an empty file.', 'burn_failed', { stage: 'empty' });
    onProgress?.(1);
    log('burn_end', { ms: Date.now() - startedAt, bytes: buffer.byteLength, frames, font: fontOk ? 'subset' : 'system', audio });
    return { bytes: new Uint8Array(buffer), mime: 'video/mp4', width: out.width, height: out.height, codec, audio };
  } catch (error) {
    log('burn_error', { code: error?.code || 'burn_failed', stage: error?.stage, ms: Date.now() - startedAt });
    throw error;
  } finally {
    clearTimeout(stallTimer);
    try { input.dispose(); } catch { /* already gone */ }
  }
}
