// Draws one caption (original line, then its translation) onto a 2D canvas context, for the export that
// burns the captions into the frames (src/captionBurn.js). Same look as the overlay and the agreed style:
// bold CJK sans, white fill, black outline, soft shadow, bottom-centre about 20% up, sized from the frame
// height (48 px at 720x1280, scaled, times the track's size). Pure functions over a context, so it is
// testable with a recording stub and has no DOM dependency here.
import { activeLine, overlayFontFamily, DEFAULT_FONT_RATIO } from './captionTrack.js';
import { TOP_MARGIN_PCT, REFERENCE_SIZE } from './lyricShared.js';

export const CAPTION_FACE = 'FinalCap Caption';
export const CAPTION_FONT_URL = '/fonts/NotoSansSC-Subset.ttf';
const OUTLINE_PX = 3; // at 1280 px of frame height
const SHADOW_PX = 1;
const LINE_HEIGHT = 1.25;
const MAX_WIDTH_FRACTION = 0.9;

/** Sizes for a frame `height` px tall (everything scales from 1280 px). */
export function captionMetrics(track, height) {
  const scale = height / REFERENCE_SIZE.height;
  const px = Math.max(10, Math.round(height * DEFAULT_FONT_RATIO * (track?.style?.sizeScale ?? 1)));
  return { px, outline: OUTLINE_PX * scale, shadow: SHADOW_PX * scale, lineHeight: Math.round(px * LINE_HEIGHT) };
}

/** The canvas font: the overlay's family stack, with the bundled subset before the generic fallback. */
export function captionFont(track, px) {
  const family = overlayFontFamily(track?.style).replace(/, system-ui/, `, "${CAPTION_FACE}", system-ui`);
  return `bold ${px}px ${family}`;
}

/** Split `text` into lines no wider than `maxWidth`: at spaces for Latin, anywhere between CJK characters. */
export function wrapText(measure, text, maxWidth) {
  const tokens = String(text).match(/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]|[^\s\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]+|\s+/g) || [];
  const lines = [];
  let current = '';
  for (const token of tokens) {
    const attempt = current + token;
    if (current && measure(attempt.trimEnd()) > maxWidth && token.trim()) {
      lines.push(current.trimEnd());
      current = token.trimStart();
    } else {
      current = attempt;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

/**
 * A reusable drawer for one frame size: `draw(ctx, t)` paints the caption active at `t` seconds.
 * Wrapping is cached per line, so a long clip does not re-measure text on every frame.
 */
export function createCaptionDrawer(track, width, height) {
  const m = captionMetrics(track, height);
  const font = captionFont(track, m.px);
  const maxWidth = width * MAX_WIDTH_FRACTION;
  const cache = new Map();
  const alignment = track?.style?.alignment === 5 || track?.style?.alignment === 8 ? track.style.alignment : 2;
  const bottomPct = track?.style?.positionFromBottomPct ?? 20;

  return {
    metrics: m,
    font,
    draw(ctx, t) {
      const active = activeLine(track, t);
      if (!active) return false;
      const key = `${active.text}\n${active.translation}`;
      ctx.save();
      ctx.font = font;
      let lines = cache.get(key);
      if (!lines) {
        const measure = (s) => ctx.measureText(s).width;
        lines = [active.text, active.translation].filter(Boolean).flatMap(part => wrapText(measure, part, maxWidth));
        cache.set(key, lines);
        if (cache.size > 200) cache.delete(cache.keys().next().value);
      }
      const total = lines.length * m.lineHeight;
      const top = alignment === 5 ? (height - total) / 2
        : alignment === 8 ? height * TOP_MARGIN_PCT / 100
          : height * (1 - bottomPct / 100) - total;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = m.outline * 2; // stroked around the glyph edge, so the visible outline is `outline`
      lines.forEach((line, i) => {
        const y = Math.round(top + (i + 1) * m.lineHeight);
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowOffsetX = m.shadow;
        ctx.shadowOffsetY = m.shadow;
        ctx.shadowBlur = 0;
        ctx.strokeText(line, width / 2, y);
        ctx.shadowColor = 'transparent';
        ctx.fillText(line, width / 2, y);
      });
      ctx.restore();
      return true;
    },
  };
}

let facePromise = null;
/** Load the bundled caption font once (after the system fonts in the canvas stack). A failure is not fatal. */
export function loadCaptionFace({ FontFaceCtor = globalThis.FontFace, fonts = globalThis.document?.fonts, url = CAPTION_FONT_URL } = {}) {
  if (!FontFaceCtor || !fonts) return Promise.resolve(false);
  if (!facePromise) {
    facePromise = new FontFaceCtor(CAPTION_FACE, `url(${url})`, { weight: '400' }).load()
      .then((face) => { fonts.add(face); return true; })
      .catch(() => { facePromise = null; return false; });
  }
  return facePromise;
}
export const _resetCaptionFaceForTests = () => { facePromise = null; };
