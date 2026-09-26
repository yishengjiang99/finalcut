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
  generate_captions: 10, // on-device speech → SRT/VTT + burn-in; no translation (narrowed below)
});

/**
 * Definition narrowing for the FinalCap-iOS schema (device limits from native-tools.md).
 * Per tool: `params` patches (merged into a property), `removeParams` (dropped, and removed
 * from `required`), and an optional replacement `description`.
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
});

function applyIosOverrides(tool) {
  const override = IOS_TOOL_OVERRIDES[tool?.function?.name];
  if (!override) return tool;
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
