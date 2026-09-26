// Versioned tool-schema contract shared with native clients (iOS executes tools on device).
// Bump TOOLS_SCHEMA_VERSION and regenerate docs/api/tools-schema.v<N>.json
// (`npm run schema:tools`) whenever src/tools.js changes in a way clients must know about.
import { tools } from '../tools.js';
import { parseFinalCapIosUserAgent } from './clientInfo.js';
import { IOS_GROUPED_TOOLS, IOS_GROUPED_TOOL_MEDIA_TYPES } from './iosGroupedTools.js';
import { filterToolsForUserAgent } from './iosToolAllowlist.js';

export const TOOLS_SCHEMA_VERSION = '1';

/** Tools that operate on a single frame and therefore work on photos too. */
const PHOTO_AND_VIDEO_TOOLS = new Set([
  'resize_video',
  'resize_video_preset',
  'crop_video',
  'rotate_video',
  'flip_video_horizontal',
  'flip_video_vertical',
  'add_text',
  'adjust_brightness',
  'adjust_contrast',
  'adjust_hue',
  'adjust_saturation',
  'apply_color_filter',
  'get_video_dimensions',
  'get_supported_formats',
]);

const PHOTO_ONLY_TOOLS = new Set(['convert_image_format']);

/** Which media types each tool accepts. */
export function mediaTypesForTool(name) {
  if (Object.prototype.hasOwnProperty.call(IOS_GROUPED_TOOL_MEDIA_TYPES, name)) return [...IOS_GROUPED_TOOL_MEDIA_TYPES[name]];
  if (PHOTO_ONLY_TOOLS.has(name)) return ['image'];
  if (PHOTO_AND_VIDEO_TOOLS.has(name)) return ['video', 'image'];
  return ['video'];
}

function restrictToMediaType(list, mediaType) {
  if (mediaType !== 'video' && mediaType !== 'image') return list;
  return list.filter(t => mediaTypesForTool(t.function.name).includes(mediaType));
}

/**
 * Tools offered to a client: web/other UAs get src/tools.js (for a media type when given), the
 * same array/objects as before. FinalCap-iOS UAs pick from src/tools.js plus the iOS-only grouped
 * tools, filtered by the build allowlist (iosToolAllowlist.js).
 */
export function offeredToolsFor({ userAgent, mediaType } = {}) {
  const candidates = parseFinalCapIosUserAgent(userAgent).isFinalCapIos ? [...tools, ...IOS_GROUPED_TOOLS] : tools;
  return filterToolsForUserAgent(restrictToMediaType(candidates, mediaType), userAgent);
}

/**
 * The versioned tool schema. With a FinalCap-iOS `userAgent`, `tools` and `mediaTypes`
 * contain only that build's allowlisted tools; otherwise (and with no argument) all tools.
 */
export function buildToolsSchema({ userAgent } = {}) {
  const offered = offeredToolsFor({ userAgent });
  const mediaTypes = {};
  for (const tool of offered) {
    mediaTypes[tool.function.name] = mediaTypesForTool(tool.function.name);
  }
  return {
    schemaVersion: TOOLS_SCHEMA_VERSION,
    tools: offered,
    mediaTypes,
  };
}

/** Tool definitions applicable to a media type ("video" | "image"); all tools when unknown. */
export function toolsForMediaType(mediaType) {
  return restrictToMediaType(tools, mediaType);
}
