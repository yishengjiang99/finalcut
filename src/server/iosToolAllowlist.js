// Server-side tool filtering for the FinalCap iOS app, keyed on its User-Agent.
//
// The iOS app sends `User-Agent: FinalCap-iOS/<build>` (build = CFBundleVersion, an integer).
// For that UA the model is offered only tools the app can run on device: a tool is offered
// when it is listed here AND the app build is >= its minBuild (intersected with the tools
// valid for the media type). A FinalCap-iOS UA with a missing/unparseable build, or a build
// older than every entry, gets NO allowlisted tools — never the full list.
//
// Any other UA (web, older iOS builds that don't send this UA and still upload to the server)
// is unaffected and gets every tool exactly as before.
//
// Seeded from docs/ios/native-tools.md "iOS allowlist (build 10)" (21 tools,
// including generate_captions — on-device speech; translation removed from the iOS definition).
// To ship a tool natively in a new build, add `tool_name: <that build>` here. An entry is either
// a number (minBuild) or `{ minBuild, maxBuild }` (both inclusive) to retire a tool in later builds.
// The grouped effect tools (iOS-only definitions in iosGroupedTools.js) are gated on
// GROUPED_EFFECTS_MIN_BUILD; see docs/api/IOS_GROUPED_TOOLS.md. lyric_captions (shared definition,
// iOS description below) is gated on LYRIC_CAPTIONS_MIN_BUILD; see docs/api/LYRIC_CAPTIONS.md.

import { parseFinalCapIosUserAgent } from './clientInfo.js';
import { APPLY_COLOR_FILTER_GROUPED_DESCRIPTION } from './iosGroupedTools.js';

/**
 * First FinalCap-iOS build that runs the grouped effect tools (channel_mixer, color_adjust, ...).
 * Set to first VALID TestFlight build with the grouped-tool executor, posted by FinalCut iOS.
 * Until then this is a placeholder no real build reaches: every real build keeps its tools.
 * Enabling is this one line: replace the placeholder with that build number.
 */
export const GROUPED_EFFECTS_MIN_BUILD = 1_000_000_000;

/**
 * First FinalCap-iOS build that runs lyric_captions (consent prompt, audio upload to
 * POST /api/lyric-captions, job polling, captions drawn on device from the result's `lines`).
 * Same placeholder as GROUPED_EFFECTS_MIN_BUILD: no real build reaches it yet.
 * Enabling is this one line: replace the placeholder with that build number.
 * See docs/api/LYRIC_CAPTIONS.md ("iOS").
 */
export const LYRIC_CAPTIONS_MIN_BUILD = 1_000_000_000;

/**
 * First FinalCap-iOS build with the server-side ffmpeg_cli fallback executor: when no
 * on-device (AVFoundation) tool can handle the request, the app uploads the video to
 * POST /api/ffmpeg-cli/run and the processed result downloads back as the new clip.
 * Builds below this never get the tool offered. Bump when the implementation ships.
 */
export const FFMPEG_CLI_MIN_BUILD = 11;

/** adjust_* are replaced by color_adjust from GROUPED_EFFECTS_MIN_BUILD on. */
const retiredAtGroupedEffects = () => Object.freeze({ minBuild: 10, maxBuild: GROUPED_EFFECTS_MIN_BUILD - 1 });

/**
 * @type {Readonly<Record<string, number | Readonly<{ minBuild: number, maxBuild?: number }>>>}
 * tool name → minimum FinalCap-iOS build, or an inclusive { minBuild, maxBuild } range
 */
export const IOS_TOOL_ALLOWLIST = Object.freeze({
  trim_video: 10,
  adjust_speed: 10,
  crop_video: 10,
  rotate_video: 10,
  flip_video_horizontal: 10,
  flip_video_vertical: 10,
  resize_video: 10,
  resize_video_preset: 10,
  adjust_brightness: retiredAtGroupedEffects(),
  adjust_contrast: retiredAtGroupedEffects(),
  adjust_saturation: retiredAtGroupedEffects(),
  adjust_hue: retiredAtGroupedEffects(),
  apply_color_filter: 10,
  add_text: 10,
  adjust_audio_volume: 10,
  audio_fade: 10,
  get_video_dimensions: 10,
  get_supported_formats: 10,
  convert_video_format: 10, // mp4/mov only on device (narrowed below)
  convert_image_format: 10, // jpg/png only on device (narrowed below)
  generate_captions: 10, // on-device speech → SRT/VTT + burn-in; no translation (narrowed below)
  // Audio upload (with consent) → POST /api/lyric-captions → captions drawn on device (described below).
  lyric_captions: LYRIC_CAPTIONS_MIN_BUILD,
  // Grouped effect tools (iOS-only definitions, iosGroupedTools.js).
  channel_mixer: GROUPED_EFFECTS_MIN_BUILD,
  color_adjust: GROUPED_EFFECTS_MIN_BUILD,
  apply_filter: GROUPED_EFFECTS_MIN_BUILD,
  stylize: GROUPED_EFFECTS_MIN_BUILD,
  blur_sharpen: GROUPED_EFFECTS_MIN_BUILD,
  lut: GROUPED_EFFECTS_MIN_BUILD,
  vignette_grain: GROUPED_EFFECTS_MIN_BUILD,
  segment: GROUPED_EFFECTS_MIN_BUILD,
  audio_effect: GROUPED_EFFECTS_MIN_BUILD,
  // Server-side last resort: no AVFoundation tool can do it → upload, process, download.
  ffmpeg_cli: FFMPEG_CLI_MIN_BUILD,
});

/** iOS description of lyric_captions: same routing rules as the web one, plus the on-device flow. */
export const LYRIC_CAPTIONS_IOS_DESCRIPTION = 'Translated captions, run by the app: the original line plus a translation, for speech and for songs. ' +
  'This is the tool for any request to caption or subtitle the video in another language, e.g. "add Chinese captions", ' +
  '"add captions in Chinese", "Chinese subtitles", "translate the video into Chinese and burn the captions", ' +
  '"translate the speech to Spanish", and for music: "add lyrics captions", "subtitle the song in Chinese", ' +
  '"translate the lyrics on the video to Spanish". Set mode "speech" for ordinary talking (interviews, vlogs, dialogue: ' +
  'only obvious recognition errors are fixed, no song lookup), mode "lyrics" for a song or music video, and leave mode "auto" ' +
  'if unsure. Fill target_language from the language the user wants the translation in (Chinese is "zh-Hans" unless they ask ' +
  'for Traditional, then "zh-Hant"); the spoken or sung language is detected automatically, so set source_language only if ' +
  'they name it. If they name two languages ("in German and Chinese"), the sung language is the source and the other is ' +
  'target_language. If they name no translation language, ask which one they want. The app asks the user before uploading ' +
  'anything, then sends only this video\'s audio (never the picture) to FinalCap, which transcribes it, translates each line ' +
  '(for songs it also identifies the song and checks the words against the published lyrics); the app then draws two-line ' +
  'captions on the video (original on top, translation below, about 20% up from the bottom). If Cloud processing is off or the ' +
  'user says Not now, nothing is uploaded and the step is skipped: do not call it again this turn. The result names the ' +
  'language(s) and, for songs, the song, never the lyrics or the speech text; do not quote lines back. Use generate_captions only for same-language ' +
  'subtitles without translation. Videos only — not supported for photos.';

/**
 * generate_captions description for builds that also have lyric_captions: it is same-language only and
 * translation goes to lyric_captions. Older builds keep the unchanged description above (their tool text is pinned).
 */
export const GENERATE_CAPTIONS_WITH_LYRIC_DESCRIPTION = 'Generate same-language subtitles from the video audio with on-device speech ' +
  'recognition (SRT/VTT). Use ISO language codes when possible (en, es, fr, de, ja, zh). When burn_in is true (default), burns the ' +
  'captions into the video; when false, adds a soft subtitle track only. This tool never translates: for captions in another ' +
  'language ("add Chinese captions", "translate the video into Chinese") call lyric_captions instead. ' +
  'Use for accessibility or social content in the spoken language. Videos only — not supported for photos.';

/**
 * Definition narrowing for the FinalCap-iOS schema (device limits from native-tools.md).
 * Per tool: `params` patches (merged into a property), `removeParams` (dropped, and removed
 * from `required`), an optional replacement `description`, and an optional `minBuild` (the
 * override only applies from that build on; without it, to every build).
 * Applied to copies; the shared tool definitions (web) are never mutated.
 */
export const IOS_TOOL_OVERRIDES = Object.freeze({
  convert_video_format: {
    params: { format: { enum: ['mp4', 'mov'], description: 'The target format to convert to: "mp4" or "mov".' } },
  },
  convert_image_format: {
    params: { format: { enum: ['jpg', 'png'], description: 'Target image format: "jpg" or "png".' } },
  },
  adjust_speed: {
    params: { speed: { minimum: 0.25, maximum: 4 } },
  },
  generate_captions: {
    // No on-device translator in the edit path, and nothing here runs on the server.
    removeParams: ['translate_language'],
    description: 'Generate subtitles from the video audio with on-device speech recognition (SRT/VTT). ' +
      'Use ISO language codes when possible (en, es, fr, de, ja, zh). When burn_in is true (default), burns the ' +
      'captions into the video; when false, adds a soft subtitle track only. Translation is not available. ' +
      'Use for accessibility or social content. Videos only — not supported for photos.',
    descriptionFromBuild: { minBuild: LYRIC_CAPTIONS_MIN_BUILD, description: GENERATE_CAPTIONS_WITH_LYRIC_DESCRIPTION },
    params: {
      position: {
        description: 'Burn-in position for the captions: "bottom" (default) or "top".',
      },
      burn_in: {
        description: 'If true (default), burn subtitles into the video frames. If false, only a soft SRT/VTT track (no re-render).',
      },
    },
  },
  lyric_captions: {
    // The app runs it (client mode), not the server: the description says what the user will see.
    description: LYRIC_CAPTIONS_IOS_DESCRIPTION,
  },
  apply_color_filter: {
    // Points film looks to lut, styles to stylize, amounts to color_adjust (grouped builds only).
    minBuild: GROUPED_EFFECTS_MIN_BUILD,
    description: APPLY_COLOR_FILTER_GROUPED_DESCRIPTION,
  },
});

function applyIosOverrides(tool, build) {
  const name = tool?.function?.name;
  const override = Object.prototype.hasOwnProperty.call(IOS_TOOL_OVERRIDES, name) ? IOS_TOOL_OVERRIDES[name] : null;
  if (!override) return tool;
  if (override.minBuild !== undefined && !(build >= override.minBuild)) return tool;
  const copy = JSON.parse(JSON.stringify(tool));
  const parameters = copy.function.parameters || {};
  const props = parameters.properties || {};
  for (const [param, patch] of Object.entries(override.params || {})) {
    if (props[param]) props[param] = { ...props[param], ...patch };
  }
  for (const param of override.removeParams || []) {
    delete props[param];
    if (Array.isArray(parameters.required)) parameters.required = parameters.required.filter(r => r !== param);
  }
  if (override.description) copy.function.description = override.description;
  const from = override.descriptionFromBuild;
  if (from && build >= from.minBuild) copy.function.description = from.description;
  return copy;
}

export { parseFinalCapIosUserAgent };

/**
 * Normalize an allowlist entry to `{ minBuild, maxBuild }` (maxBuild Infinity when open-ended).
 * Returns null for anything that isn't a number or an object with a numeric minBuild.
 */
export function iosBuildRange(entry) {
  if (typeof entry === 'number') return Number.isFinite(entry) ? { minBuild: entry, maxBuild: Infinity } : null;
  if (!entry || typeof entry !== 'object' || typeof entry.minBuild !== 'number' || !Number.isFinite(entry.minBuild)) return null;
  const maxBuild = entry.maxBuild === undefined ? Infinity : entry.maxBuild;
  if (typeof maxBuild !== 'number' || Number.isNaN(maxBuild)) return null;
  return { minBuild: entry.minBuild, maxBuild };
}

/** True when `toolName` is allowlisted for this FinalCap-iOS build (minBuild <= build <= maxBuild). */
export function isToolAllowedForIosBuild(toolName, build, allowlist = IOS_TOOL_ALLOWLIST) {
  if (!Number.isSafeInteger(build)) return false;
  if (!Object.prototype.hasOwnProperty.call(allowlist, toolName)) return false;
  const range = iosBuildRange(allowlist[toolName]);
  return !!range && build >= range.minBuild && build <= range.maxBuild;
}

/**
 * Filter tool definitions (`{ type: "function", function: { name } }`) for a User-Agent.
 * Non-FinalCap-iOS UAs get the input array back unchanged (same reference).
 */
export function filterToolsForUserAgent(tools, userAgent, allowlist = IOS_TOOL_ALLOWLIST) {
  const { isFinalCapIos, build } = parseFinalCapIosUserAgent(userAgent);
  if (!isFinalCapIos) return tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(t => isToolAllowedForIosBuild(t?.function?.name, build, allowlist))
    .map(t => applyIosOverrides(t, build));
}
