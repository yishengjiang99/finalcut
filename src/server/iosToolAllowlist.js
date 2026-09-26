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
// Seeded from docs/ios/native-tools.md "iOS allowlist (build 10)": exactly those 20 tools.
// To ship a tool natively in a new build, add `tool_name: <that build>` here.

import { parseFinalCapIosUserAgent } from './clientInfo.js';

/** @type {Readonly<Record<string, number>>} tool name → minimum FinalCap-iOS build */
export const IOS_TOOL_ALLOWLIST = Object.freeze({
  trim_video: 10,
  adjust_speed: 10,
  crop_video: 10,
  rotate_video: 10,
  flip_video_horizontal: 10,
  flip_video_vertical: 10,
  resize_video: 10,
  resize_video_preset: 10,
  adjust_brightness: 10,
  adjust_contrast: 10,
  adjust_saturation: 10,
  adjust_hue: 10,
  apply_color_filter: 10,
  add_text: 10,
  adjust_audio_volume: 10,
  audio_fade: 10,
  get_video_dimensions: 10,
  get_supported_formats: 10,
  convert_video_format: 10, // mp4/mov only on device (narrowed below)
  convert_image_format: 10, // jpg/png only on device (narrowed below)
});

/**
 * Argument narrowing for the FinalCap-iOS schema (device limits from native-tools.md).
 * Applied to copies; the shared tool definitions (web) are never mutated.
 */
export const IOS_TOOL_PARAM_OVERRIDES = Object.freeze({
  convert_video_format: {
    format: { enum: ['mp4', 'mov'], description: 'The target format to convert to: "mp4" or "mov".' },
  },
  convert_image_format: {
    format: { enum: ['jpg', 'png'], description: 'Target image format: "jpg" or "png".' },
  },
  adjust_speed: {
    speed: { minimum: 0.25, maximum: 4 },
  },
});

function applyIosOverrides(tool) {
  const overrides = IOS_TOOL_PARAM_OVERRIDES[tool?.function?.name];
  if (!overrides) return tool;
  const copy = JSON.parse(JSON.stringify(tool));
  const props = copy.function.parameters?.properties || {};
  for (const [param, patch] of Object.entries(overrides)) {
    if (props[param]) props[param] = { ...props[param], ...patch };
  }
  return copy;
}

export { parseFinalCapIosUserAgent };

/** True when `toolName` is allowlisted for this FinalCap-iOS build. */
export function isToolAllowedForIosBuild(toolName, build, allowlist = IOS_TOOL_ALLOWLIST) {
  if (!Number.isSafeInteger(build)) return false;
  if (!Object.prototype.hasOwnProperty.call(allowlist, toolName)) return false;
  return build >= allowlist[toolName];
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
    .map(applyIosOverrides);
}
