// Client-safe definition of the FFmpeg CLI fallback tool (no server imports), shared by the web client and server.
import { tools as builtinTools } from './tools.js';

export const FFMPEG_CLI_TOOL_NAME = 'ffmpeg_cli';

export const ffmpegCliToolDefinition = {
  type: 'function',
  function: {
    name: FFMPEG_CLI_TOOL_NAME,
    description: 'FALLBACK ONLY. Use when none of the other tools can do what the user asks, and try it BEFORE telling the user something is not supported. Runs FFmpeg directly. First call with action "discover" and a query to find matching FFmpeg filters/codecs (add help_topic to read the FFmpeg help for a filter), then "plan" to validate a command and show the user what it will do, then "run" to execute it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['discover', 'plan', 'run'], description: 'discover = search FFmpeg filters/codecs/encoders; plan = build and validate a command without running it; run = build, validate and execute.' },
        query: { type: 'string', description: 'For discover: one or two keywords such as "reverb", "vignette" or "h265". Any keyword may match; retry with different words if nothing is found.' },
        help_topic: { type: 'string', description: 'For discover: optional filter name to fetch its full FFmpeg help (ffmpeg -h filter=NAME).' },
        video_filters: { type: 'string', description: 'FFmpeg -vf filter chain, e.g. "vignette,hue=s=0".' },
        audio_filters: { type: 'string', description: 'FFmpeg -af filter chain.' },
        video_codec: { type: 'string', description: 'Encoder name, e.g. libx264, or "copy".' },
        audio_codec: { type: 'string', description: 'Encoder name, e.g. aac, or "copy".' },
        output_format: { type: 'string', description: 'Output container/extension, e.g. mp4, gif, mp3.' },
        start_time: { type: 'number', description: 'Seek offset in seconds.' },
        duration: { type: 'number', description: 'Output duration in seconds.' },
        no_audio: { type: 'boolean' },
        no_video: { type: 'boolean' },
        crf: { type: 'number' },
        video_bitrate: { type: 'string' },
        audio_bitrate: { type: 'string' },
        frame_rate: { type: 'number' },
      },
      required: ['action'],
    },
  },
};

// Shared rule: an unsupported request must go through FFmpeg discovery before any refusal.
const DISCOVER_BEFORE_REFUSING =
  `Never answer that an edit is unsupported just because no dedicated tool exists: first call ${FFMPEG_CLI_TOOL_NAME} with action "discover" ` +
  '(and help_topic to read the FFmpeg help for a promising filter) to find out how the FFmpeg CLI can do it, retrying with other keywords if nothing matches. ' +
  'Only say it cannot be done after discovery or planning shows FFmpeg cannot do it here, and then say what you tried.';

export const FFMPEG_FALLBACK_GUIDANCE =
  `Routing: always prefer the dedicated editing tools. Only if NONE of them can fulfil the request, use ${FFMPEG_CLI_TOOL_NAME}: ` +
  'discover relevant filters, plan the command, tell the user briefly which approach you chose and why, then run it. ' +
  DISCOVER_BEFORE_REFUSING;

/**
 * Same last-resort routing for the iOS app, where the tool executes on the server:
 * the app uploads the current video, the server processes it with FFmpeg, and the
 * result downloads back as the new clip. Videos only — never call it for photos.
 */
export const FFMPEG_FALLBACK_GUIDANCE_IOS =
  `Routing: always prefer the on-device editing tools. Only if NONE of them can fulfil the request, use ${FFMPEG_CLI_TOOL_NAME}: ` +
  'it runs on the server (the app uploads the current video and the processed result downloads back as the new clip). ' +
  'First call with action "discover" and a query to find matching FFmpeg filters/codecs, then "plan" to validate the command, ' +
  'tell the user briefly which approach you chose and why, then call with action "run" to execute it. Videos only. ' +
  DISCOVER_BEFORE_REFUSING;

/**
 * Web: the fallback is not a tool. When the reply carries no tool call, the app asks inference
 * for the FFmpeg CLI string for the request (POST /api/ffmpeg-cli, action "command") and runs it.
 */
export const FFMPEG_CLI_STRING_GUIDANCE =
  'Routing: always prefer the editing tools. If NONE of them can fulfil an edit the user asks for, do not call a tool and never answer that it is unsupported: ' +
  'reply with one short sentence saying you will work it out with FFmpeg directly. The app then finds and runs the FFmpeg command itself.';

/** Existing tools first; the FFmpeg CLI tool is appended only as the last-resort entry. */
export function withFfmpegFallback(tools = builtinTools) {
  if (tools.some(t => t.function.name === FFMPEG_CLI_TOOL_NAME)) return tools;
  return [...tools, ffmpegCliToolDefinition];
}
