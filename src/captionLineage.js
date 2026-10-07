// Burned-in captions can't be removed from the pixels, so captioning a video that already has
// burned captions shows the text twice (for example "add captions", then "translate them": the
// web flow feeds each tool the previous tool's output). Track which bytes carry burned captions:
//   - a caption burn records output → uncaptioned source, so a later caption call re-burns from
//     the source and *replaces* the captions instead of stacking a second copy;
//   - any edit applied on top of captioned bytes marks the result as captioned too, so captioning
//     it again is refused with a clear message instead of duplicating the text.
const burnSources = new WeakMap(); // captioned output → bytes it was burned from
const captionedDescendants = new WeakSet();

const isObject = (v) => v !== null && typeof v === 'object';

export const CAPTIONS_ALREADY_BURNED =
  'This video already has burned-in captions from an earlier step, followed by other edits. '
  + 'Captioning it again would show the text twice. Start from the original upload to re-caption.';

/** Bytes to caption from. Throws when the input carries burned captions that can't be replaced. */
export function captionSourceFor(videoBytes) {
  if (isObject(videoBytes) && burnSources.has(videoBytes)) {
    return { bytes: burnSources.get(videoBytes), replacing: true };
  }
  if (isObject(videoBytes) && captionedDescendants.has(videoBytes)) {
    throw new Error(CAPTIONS_ALREADY_BURNED);
  }
  return { bytes: videoBytes, replacing: false };
}

/** Call after burning captions from `source` into `output`. */
export function recordCaptionBurn(source, output) {
  if (isObject(output)) burnSources.set(output, source);
}

/** Call whenever an edit turns `previous` into `next` (the chat tool loop does this). */
export function noteDerivedVideo(previous, next) {
  if (!isObject(previous) || !isObject(next) || previous === next || burnSources.has(next)) return;
  if (burnSources.has(previous) || captionedDescendants.has(previous)) captionedDescendants.add(next);
}

export function videoHasBurnedCaptions(videoBytes) {
  return isObject(videoBytes) && (burnSources.has(videoBytes) || captionedDescendants.has(videoBytes));
}
