// Export a captioned clip, all in the browser: burn the captions into the picture (WebCodecs + canvas,
// src/captionBurn.js) so they show everywhere, including Photos. If this browser cannot do that, the
// clip gets the captions as a soft caption track (mov_text, stream copy) plus an SRT. If even the track
// cannot be added, the SRT alone. Never a server step. Returns what to hand to the user; the caller
// shares or saves it and shows the one line.
import { trackToSrt } from './captionTrack.js';

/** Phones: shrink pictures above 1080p on the long edge so the encoder keeps few frames in memory. */
export const CONSTRAINED_MAX_LONG_EDGE = 1920;

export const EXPORT_NOTICES = Object.freeze({
  burned: 'Exported with the captions in the video.',
  soft_track: 'This browser cannot put the captions into the picture, so the video has a caption track (turn it on in the player) and the captions were also saved as an SRT file.',
  srt_unsupported: 'This video format cannot hold a caption track, so the captions were saved as an SRT file.',
  srt: 'The captions could not be added to the video here, so they were saved as an SRT file.',
  cancelled: 'Export cancelled.',
});

/**
 * @param {object} p
 * @param {Uint8Array} p.bytes
 * @param {string} p.mime
 * @param {object} p.track
 * @param {object} p.deps { burn, mux, webCodecs } the WebCodecs burn, the soft-track mux, availability check
 * @returns {Promise<{kind:'burned'|'soft_track'|'srt', bytes?:Uint8Array, mime?:string, ext?:string, srt?:string, notice:string, burnError?:string}>}
 */
export async function exportCaptionedVideo({ bytes, mime = 'video/mp4', track, clog, onProgress, signal, constrained = false, deps }) {
  const { burn, mux, webCodecs } = deps;
  let burnError = null;
  if (webCodecs()) {
    try {
      const out = await burn({ bytes, mime, track, clog, onProgress, signal, maxLongEdge: constrained ? CONSTRAINED_MAX_LONG_EDGE : 0 });
      return { kind: 'burned', bytes: out.bytes, mime: out.mime, ext: 'mp4', notice: EXPORT_NOTICES.burned };
    } catch (error) {
      if (error?.code === 'cancelled') throw error;
      burnError = error?.code || 'burn_failed';
    }
  } else {
    burnError = 'webcodecs_unsupported';
    clog?.log?.('burn_error', { code: burnError, stage: 'unavailable' });
  }
  clog?.log?.('export_fallback', { burn: burnError });
  const srt = trackToSrt(track);
  try {
    const out = await mux({ bytes, mime, track, clog });
    return { kind: 'soft_track', bytes: out.bytes, mime: out.mime, ext: out.mime === 'video/quicktime' ? 'mov' : 'mp4', srt, notice: EXPORT_NOTICES.soft_track, burnError };
  } catch (error) {
    clog?.log?.('export_srt_fallback', { code: error?.code || null });
    return { kind: 'srt', srt, notice: error?.code === 'soft_track_unsupported' ? EXPORT_NOTICES.srt_unsupported : EXPORT_NOTICES.srt, burnError };
  }
}
