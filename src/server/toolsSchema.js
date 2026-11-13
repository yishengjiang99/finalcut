// Versioned tool-schema contract shared with native clients (iOS executes tools on device).
// Bump TOOLS_SCHEMA_VERSION and regenerate docs/api/tools-schema.v<N>.json
// (`npm run schema:tools`) whenever src/tools.js changes in a way clients must know about.
import { tools } from '../tools.js';
import { parseFinalCapIosUserAgent } from './clientInfo.js';
import { IOS_GROUPED_TOOLS, IOS_GROUPED_TOOL_MEDIA_TYPES } from './iosGroupedTools.js';
import { IOS_TIMELINE_TOOLS, IOS_TIMELINE_TOOL_MEDIA_TYPES } from './iosTimelineTools.js';
import { filterToolsForUserAgent, supportsStillVideoFromPhotos } from './iosToolAllowlist.js';
import { ffmpegCliToolDefinition, FFMPEG_CLI_TOOL_NAME } from '../ffmpegFallback.js';

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
  if (Object.prototype.hasOwnProperty.call(IOS_TIMELINE_TOOL_MEDIA_TYPES, name)) return [...IOS_TIMELINE_TOOL_MEDIA_TYPES[name]];
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
 * tools, filtered by the build allowlist (iosToolAllowlist.js; youtube_soundtrack is a shared
 * tool gated to YOUTUBE_SOUNDTRACK_MIN_BUILD there, with an iOS description override). The
 * server-side ffmpeg_cli fallback is appended last for iOS so the
 * model treats it as the last resort; the allowlist (FFMPEG_CLI_MIN_BUILD) keeps it away from
 * builds that can't execute it.
 *
 * From STILL_VIDEO_PHOTOS_MIN_BUILD, FinalCap-iOS can turn a photo into a still
 * video, so timeline-capable tools are also offered for image media (not the
 * FFmpeg fallback or the multi-clip timeline tools). Older iOS builds and web
 * keep the frame-only photo list.
 */
export const STILL_VIDEO_PHOTO_CLAUSE =
  ' Works on videos. On a photo, the client first turns it into a still video (requested duration, else soundtrack length, else 10 seconds) and export is a video.';

const VIDEOS_ONLY_SUFFIX = /(?: Videos only — not supported for photos\.| Videos only\.| Videos only \(not photos\)\.)$/;

function isStillVideoAnnotatable(name) {
  if (!name || PHOTO_AND_VIDEO_TOOLS.has(name) || PHOTO_ONLY_TOOLS.has(name)) return false;
  if (name === FFMPEG_CLI_TOOL_NAME) return false;
  if (Object.prototype.hasOwnProperty.call(IOS_TIMELINE_TOOL_MEDIA_TYPES, name)) return false;
  return true;
}

/** Append the still-video photo clause to a tool description (idempotent). */
export function withStillVideoPhotoDescription(tool) {
  const desc = tool?.function?.description;
  if (typeof desc !== 'string') return tool;
  if (desc.includes('turns the photo into a still video') || desc.includes('turns it into a still video')) return tool;
  const copy = JSON.parse(JSON.stringify(tool));
  copy.function.description = desc.replace(VIDEOS_ONLY_SUFFIX, '') + STILL_VIDEO_PHOTO_CLAUSE;
  return copy;
}

function annotateStillVideoPhotoDescriptions(list, userAgent) {
  if (!supportsStillVideoFromPhotos(userAgent) || !Array.isArray(list)) return list;
  return list.map(t => (isStillVideoAnnotatable(t?.function?.name) ? withStillVideoPhotoDescription(t) : t));
}

export function offeredToolsFor({ userAgent, mediaType } = {}) {
  const isIos = parseFinalCapIosUserAgent(userAgent).isFinalCapIos;
  const shared = tools;
  const candidates = isIos ? [...shared, ...IOS_GROUPED_TOOLS, ...IOS_TIMELINE_TOOLS, ffmpegCliToolDefinition] : shared;
  if (supportsStillVideoFromPhotos(userAgent) && mediaType === 'image') {
    const timeline = new Set(IOS_TIMELINE_TOOLS.map(t => t.function.name));
    return annotateStillVideoPhotoDescriptions(
      filterToolsForUserAgent(
        candidates.filter(t => {
          const n = t?.function?.name;
          return n && n !== FFMPEG_CLI_TOOL_NAME && !timeline.has(n);
        }),
        userAgent,
      ),
      userAgent,
    );
  }
  return annotateStillVideoPhotoDescriptions(
    filterToolsForUserAgent(restrictToMediaType(candidates, mediaType), userAgent),
    userAgent,
  );
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
