// Export on a phone: the Web Share API with files opens the system share sheet ("Save Video" puts
// the file in Photos on iOS) instead of dropping it into Files. Desktop keeps the plain download.
// navigator.share() needs a transient user activation: call it from the tap itself. When the file is
// only ready after a long render, show a "Ready - Share" button and call share from that tap.

export const isMobileDevice = (nav = globalThis.navigator || {}) =>
  /iPhone|iPad|iPod|Android/i.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);

const MIME_BY_EXT = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', srt: 'text/plain', ass: 'text/plain', vtt: 'text/vtt', mp3: 'audio/mpeg', wav: 'audio/wav' };

/** A File with a sensible type and name, from bytes or a Blob. */
export function makeShareFile(data, filename, mimeType) {
  const ext = String(filename).split('.').pop().toLowerCase();
  const type = String(mimeType || MIME_BY_EXT[ext] || 'application/octet-stream').split(';')[0];
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  return new File([blob], filename, { type, lastModified: Date.now() });
}

/** True when this browser can share this file through the system sheet (and we are on a phone/tablet). */
export function canShareFile(file, nav = globalThis.navigator) {
  if (!file || !nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function' || !isMobileDevice(nav)) return false;
  try { return Boolean(nav.canShare({ files: [file] })); } catch { return false; }
}

/**
 * Share `file` if possible, else download it. Returns 'shared' | 'cancelled' | 'downloaded'.
 * Cancelling the sheet (AbortError) is not an error. If the activation has expired or the share is
 * refused, `needsTap` is returned so the caller can show a "Ready - Share" button; any other failure
 * falls back to the download. `log(event, data)` receives share_ok / share_cancel / share_fail.
 */
export async function shareOrDownload(file, { nav = globalThis.navigator, download, log = () => {}, kind = 'file' } = {}) {
  if (!canShareFile(file, nav)) {
    download?.(file);
    return 'downloaded';
  }
  try {
    await nav.share({ files: [file] });
    log('share_ok', { kind, bytes: file.size, type: file.type });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') { log('share_cancel', { kind }); return 'cancelled'; }
    log('share_fail', { kind, name: err?.name, msg: String(err?.message || '').replace(/[^\x20-\x7e]/g, '').slice(0, 80), bytes: file.size });
    if (err?.name === 'NotAllowedError') return 'needsTap';
    download?.(file);
    return 'downloaded';
  }
}
