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
// Seeded from docs/ios/native-tools.md "iOS allowlist (build 10)" (20 tools), plus
// generate_captions (on-device speech; translation removed from the iOS definition).
// To ship a tool natively in a new build, add `tool_name: <that build>` here. An entry is either
// a number (minBuild) or `{ minBuild, maxBuild }` (both inclusive) to retire a tool in later builds.
// The grouped effect tools (iOS-only definitions in iosGroupedTools.js) are gated on
// GROUPED_EFFECTS_MIN_BUILD; see docs/api/IOS_GROUPED_TOOLS.md.

import { parseFinalCapIosUserAgent } from './clientInfo.js';
import { APPLY_COLOR_FILTER_GROUPED_DESCRIPTION } from './iosGroupedTools.js';

/**
 * First FinalCap-iOS build that runs the grouped effect tools (channel_mixer, color_adjust, ...).
 * Set to first VALID TestFlight build with the grouped-tool executor, posted by FinalCut iOS.
 * Until then this is a placeholder no real build reaches: every real build keeps its tools.
 * Enabling is this one line: replace the placeholder with that build number.
 */
export const GROUPED_EFFECTS_MIN_BUILD = 1_000_000_000;

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
});

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
    params: {
      position: {
        description: 'Burn-in position for the captions: "bottom" (default) or "top".',
      },
      burn_in: {
        description: 'If true (default), burn subtitles into the video frames. If false, only a soft SRT/VTT track (no re-render).',
      },
    },
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
