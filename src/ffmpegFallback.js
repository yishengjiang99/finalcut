// Client-safe definition of the FFmpeg CLI fallback tool (no server imports), shared by the web client and server.
import { tools as builtinTools } from './tools.js';

export const FFMPEG_CLI_TOOL_NAME = 'ffmpeg_cli';

export const ffmpegCliToolDefinition = {
  type: 'function',
  function: {
    name: FFMPEG_CLI_TOOL_NAME,
    description: 'FALLBACK ONLY. Use ONLY when none of the other tools can do what the user asks. Runs FFmpeg directly. First call with action "discover" and a query to find matching FFmpeg filters/codecs, then "plan" to validate a command and show the user what it will do, then "run" to execute it.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['discover', 'plan', 'run'], description: 'discover = search FFmpeg filters/codecs/encoders; plan = build and validate a command without running it; run = build, validate and execute.' },
        query: { type: 'string', description: 'For discover: keywords such as "reverb", "vignette" or "h265".' },
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

export const FFMPEG_FALLBACK_GUIDANCE =
  `Routing: always prefer the dedicated editing tools. Only if NONE of them can fulfil the request, use ${FFMPEG_CLI_TOOL_NAME}: ` +
  'discover relevant filters, plan the command, tell the user briefly which approach you chose and why, then run it.';

/** Existing tools first; the FFmpeg CLI tool is appended only as the last-resort entry. */
export function withFfmpegFallback(tools = builtinTools) {
  if (tools.some(t => t.function.name === FFMPEG_CLI_TOOL_NAME)) return tools;
  return [...tools, ffmpegCliToolDefinition];
}
