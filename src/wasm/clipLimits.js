// Clip size/duration guard for in-browser editing (decision 2026-10-09).
// Defaults below; the server capability catalog may override them (limits.clip).
export const DEFAULT_CLIP_LIMITS = {
  desktop: { warnBytes: 1024 ** 3, blockBytes: Math.round(1.8 * 1024 ** 3) },
  mobile: { warnBytes: 300 * 1024 ** 2, blockBytes: 500 * 1024 ** 2 }, // mobile + Safari
  longClip: { minHeight: 1080, warnSeconds: 600 },
};

export function isConstrainedBrowser(ua = navigator.userAgent, maxTouchPoints = navigator.maxTouchPoints || 0) {
  const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS\/|Edg\/|FxiOS\//.test(ua);
  return mobile || safari;
}

/**
 * @returns {{level:'ok'|'warn'|'block', reasons:string[]}}
 */
export function checkClip({ bytes, durationSec, height }, { limits = DEFAULT_CLIP_LIMITS, constrained = isConstrainedBrowser() } = {}) {
  const tier = constrained ? limits.mobile : limits.desktop;
  const reasons = [];
  let level = 'ok';
  const mb = (n) => `${Math.round(n / 1024 ** 2)} MB`;
  if (bytes > tier.blockBytes) {
    return { level: 'block', reasons: [`This clip is ${mb(bytes)}; the limit in this browser is ${mb(tier.blockBytes)}.`] };
  }
  if (bytes > tier.warnBytes) {
    level = 'warn';
    reasons.push(`Large clip (${mb(bytes)}). Editing in the browser may be slow or run out of memory.`);
  }
  if (Number.isFinite(durationSec) && (height ?? 0) >= limits.longClip.minHeight && durationSec > limits.longClip.warnSeconds) {
    level = 'warn';
    reasons.push(`Long ${limits.longClip.minHeight}p clip (${Math.round(durationSec / 60)} min). Re-encoding edits may take a while.`);
  }
  return { level, reasons };
}
