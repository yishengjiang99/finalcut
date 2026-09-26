// Helpers for POST /api/chat with `execution: "client"`: the model plans tool calls,
// the native client executes them on device (media is never uploaded) and posts
// results back as OpenAI-style `role: "tool"` messages.
import { TOOLS_SCHEMA_VERSION } from './toolsSchema.js';

export const CLIENT_SCHEMA_VERSION = TOOLS_SCHEMA_VERSION;
export const MAX_THUMBNAILS = 4;
export const MAX_THUMBNAIL_BYTES = 300 * 1024;
/**
 * Max assistant tool-call rounds per user turn. Once reached, tools are withheld
 * (tool_choice "none") so the model must answer — prevents device retry loops.
 */
export const MAX_TOOL_ROUNDS = 6;
/** Tool-result error code meaning the user declined the step on device (not a failure). */
export const SKIPPED_BY_USER = 'skipped_by_user';
/** Tool-result code meaning the device cannot run this tool (safety net for the UA allowlist). */
export const UNSUPPORTED_ON_DEVICE = 'unsupported_on_device';

export class ClientRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ClientRequestError';
    this.status = status;
  }
}

/** Models that accept image inputs on the xAI chat completions API. */
export function modelSupportsVision(model) {
  return /vision|grok-4|grok-5/i.test(String(model || ''));
}

function optionalNumber(value, field, { min = 0, max = Infinity } = {}) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ClientRequestError(`media.${field} must be a number between ${min} and ${max}`);
  }
  return n;
}

/**
 * Validate `media: { type, duration, width, height, fps, hasAudio, codec? }`.
 * Returns a normalized object or null when absent.
 */
export function validateMedia(media) {
  if (media === undefined || media === null) return null;
  if (typeof media !== 'object' || Array.isArray(media)) {
    throw new ClientRequestError('media must be an object');
  }
  if (media.type !== 'video' && media.type !== 'image') {
    throw new ClientRequestError('media.type must be "video" or "image"');
  }
  const normalized = {
    type: media.type,
    duration: optionalNumber(media.duration, 'duration', { max: 24 * 3600 }),
    width: optionalNumber(media.width, 'width', { max: 32768 }),
    height: optionalNumber(media.height, 'height', { max: 32768 }),
    fps: optionalNumber(media.fps, 'fps', { max: 1000 }),
  };
  if (media.hasAudio !== undefined && media.hasAudio !== null) {
    if (typeof media.hasAudio !== 'boolean') throw new ClientRequestError('media.hasAudio must be a boolean');
    normalized.hasAudio = media.hasAudio;
  }
  if (media.codec !== undefined && media.codec !== null) {
    if (typeof media.codec !== 'string' || !/^[\w.\-+ ]{1,32}$/.test(media.codec)) {
      throw new ClientRequestError('media.codec must be a short codec name');
    }
    normalized.codec = media.codec;
  }
  return normalized;
}

/**
 * Validate `thumbnails: string[]` (raw base64 or data: URLs of JPEG/PNG).
 * ≤ MAX_THUMBNAILS items (else 400), each ≤ MAX_THUMBNAIL_BYTES decoded (else 413).
 * @returns {{ mime: string, dataUrl: string, bytes: number }[]}
 */
export function parseThumbnails(thumbnails) {
  if (thumbnails === undefined || thumbnails === null) return [];
  if (!Array.isArray(thumbnails)) throw new ClientRequestError('thumbnails must be an array of base64 JPEG strings');
  if (thumbnails.length > MAX_THUMBNAILS) {
    throw new ClientRequestError(`At most ${MAX_THUMBNAILS} thumbnails are allowed (got ${thumbnails.length})`);
  }
  return thumbnails.map((thumb, i) => {
    if (typeof thumb !== 'string' || !thumb.trim()) {
      throw new ClientRequestError(`thumbnails[${i}] must be a base64 string`);
    }
    let base64 = thumb.trim();
    const dataUrl = /^data:(image\/(?:jpeg|jpg|png));base64,(.*)$/is.exec(base64);
    if (dataUrl) base64 = dataUrl[2];
    base64 = base64.replace(/\s+/g, '');
    // Cheap size check before decoding (base64 is 4 chars per 3 bytes).
    if (Math.floor((base64.length * 3) / 4) > MAX_THUMBNAIL_BYTES + 3) {
      throw new ClientRequestError(`thumbnails[${i}] exceeds ${MAX_THUMBNAIL_BYTES / 1024}KB`, 413);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw new ClientRequestError(`thumbnails[${i}] is not valid base64`);
    }
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_THUMBNAIL_BYTES) {
      throw new ClientRequestError(`thumbnails[${i}] exceeds ${MAX_THUMBNAIL_BYTES / 1024}KB`, 413);
    }
    let mime;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mime = 'image/jpeg';
    else if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) mime = 'image/png';
    else throw new ClientRequestError(`thumbnails[${i}] must be a JPEG or PNG image`);
    return { mime, dataUrl: `data:${mime};base64,${base64}`, bytes: buf.length };
  });
}

/** Human-readable media context for the system prompt. */
export function mediaContextText(media, { thumbnailCount = 0, thumbnailsAsImages = false } = {}) {
  if (!media) return 'Media context: not provided by the client.';
  const parts = [`type=${media.type}`];
  if (media.width && media.height) parts.push(`resolution=${media.width}x${media.height}`);
  if (media.type === 'video') {
    if (media.duration !== undefined) parts.push(`duration=${media.duration}s`);
    if (media.fps !== undefined) parts.push(`fps=${media.fps}`);
    if (media.hasAudio !== undefined) parts.push(`hasAudio=${media.hasAudio}`);
  }
  if (media.codec) parts.push(`codec=${media.codec}`);
  let text = `Media context: ${parts.join(', ')}.`;
  if (thumbnailCount > 0) {
    text += thumbnailsAsImages
      ? ` ${thumbnailCount} thumbnail frame(s) are attached as images for visual context.`
      : ` ${thumbnailCount} thumbnail frame(s) were provided but this model has no image input; rely on the metadata.`;
  }
  if (media.type === 'image') {
    text += ' The media is a PHOTO: only frame edits apply (no trim, speed, audio, captions, or transitions).';
  }
  return text;
}

export const CLIENT_EXECUTION_INSTRUCTIONS =
  'Tool calls in this conversation are executed on the user\'s device, not on the server. ' +
  'Each tool result arrives as a role "tool" message whose content is JSON: ' +
  '{ ok, error?, executedOn: "device"|"server", output?: { duration, width, height } }. ' +
  'If ok is false, explain the error or try an alternative; do not repeat the same failing call. ' +
  'error "skipped_by_user" means the user deliberately declined that step: it is not a failure, ' +
  'do not call that tool again in this turn, and continue to the final answer. ' +
  'code "unsupported_on_device" means the phone cannot run that edit yet: do not call that tool again ' +
  'in this turn, and briefly tell the user that edit is not available on the phone yet. ' +
  'Use output metadata (duration, width, height) from earlier results when planning later edits.';

function contentToString(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/**
 * Normalize client-supplied conversation for the model. Drops client "system"
 * messages (the server owns the system prompt) and coerces tool results to strings.
 */
export function normalizeClientMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ClientRequestError('messages must be a non-empty array');
  }
  const out = [];
  for (const [i, msg] of messages.entries()) {
    if (!msg || typeof msg !== 'object') throw new ClientRequestError(`messages[${i}] must be an object`);
    switch (msg.role) {
      case 'system':
        break;
      case 'user': {
        const content = Array.isArray(msg.content)
          ? msg.content.filter(p => p && p.type === 'text' && typeof p.text === 'string')
            .map(p => ({ type: 'text', text: p.text }))
          : contentToString(msg.content);
        out.push({ role: 'user', content });
        break;
      }
      case 'assistant': {
        const next = { role: 'assistant', content: typeof msg.content === 'string' ? msg.content : (msg.content ?? null) };
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          next.tool_calls = msg.tool_calls.map((call, j) => {
            if (!call?.id || !call?.function?.name) {
              throw new ClientRequestError(`messages[${i}].tool_calls[${j}] needs id and function.name`);
            }
            return {
              id: String(call.id),
              type: 'function',
              function: {
                name: String(call.function.name),
                arguments: contentToString(call.function.arguments ?? '{}'),
              },
            };
          });
        }
        out.push(next);
        break;
      }
      case 'tool': {
        if (typeof msg.tool_call_id !== 'string' || !msg.tool_call_id) {
          throw new ClientRequestError(`messages[${i}].tool_call_id is required for tool results`);
        }
        out.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: annotateToolResult(contentToString(msg.content), toolNameForCall(out, msg.tool_call_id)),
        });
        break;
      }
      default:
        throw new ClientRequestError(`messages[${i}].role must be user, assistant, tool, or system`);
    }
  }
  return out;
}

function toolNameForCall(messages, toolCallId) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const call = messages[i].tool_calls?.find(c => c.id === toolCallId);
    if (call) return call.function.name;
  }
  return null;
}

function parseToolResult(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function isSkippedByUser(result) {
  return Boolean(result) && result.ok === false && result.error === SKIPPED_BY_USER;
}

/**
 * `{ ok:false, code:"unsupported_on_device" }`. `code` is the documented field (like the
 * server error codes); `reason` and `error` are accepted for tolerance.
 */
export function isUnsupportedOnDevice(result) {
  return Boolean(result) && result.ok === false
    && [result.code, result.reason, result.error].includes(UNSUPPORTED_ON_DEVICE);
}

/**
 * Rewrite a `skipped_by_user` / `unsupported_on_device` tool result so the model reads it
 * correctly (a user decision / a device limitation, not a failure) and does not retry the
 * same tool this turn. Other results pass through unchanged.
 */
export function annotateToolResult(content, toolName) {
  const result = parseToolResult(content);
  const name = toolName || 'this tool';
  if (isSkippedByUser(result)) {
    return JSON.stringify({
      ...result,
      skipped: true,
      note: `The user intentionally skipped this step (${name}). This is NOT a failure — do not apologize or retry. ` +
        `Do not call ${name} again in this turn; continue with any remaining steps and then give the final answer.`,
    });
  }
  if (isUnsupportedOnDevice(result)) {
    return JSON.stringify({
      ...result,
      unsupportedOnDevice: true,
      note: `This edit (${name}) is not available on the phone yet, so nothing was changed. Do not call ${name} ` +
        'again in this turn and do not retry it with other arguments. Briefly tell the user this edit is not ' +
        'available on the phone yet, continue with any remaining steps, and then give the final answer.',
    });
  }
  return content;
}

/** Messages after the most recent user message (the current turn's tool loop). */
function currentTurn(messages) {
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === 'user') lastUser = i; });
  return messages.slice(lastUser + 1);
}

/** Assistant tool-call rounds in the current user turn. */
export function countToolRounds(messages) {
  return currentTurn(messages)
    .filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length).length;
}

/** Tool results with `ok: true` in the current user turn (edits the device applied). */
export function countOkToolResultsInTurn(messages) {
  return currentTurn(messages)
    .filter(m => m.role === 'tool' && parseToolResult(m.content)?.ok === true).length;
}

function toolsInTurnMatching(messages, predicate) {
  const turn = currentTurn(messages);
  const names = new Set();
  for (const m of turn) {
    if (m.role !== 'tool') continue;
    if (!predicate(parseToolResult(m.content))) continue;
    const name = toolNameForCall(messages, m.tool_call_id);
    if (name) names.add(name);
  }
  return [...names];
}

/** Tool names the user skipped in the current turn (from `skipped_by_user` results). */
export function skippedToolsInTurn(messages) {
  return toolsInTurnMatching(messages, isSkippedByUser);
}

/** Tool names the device reported as `unsupported_on_device` in the current turn. */
export function unsupportedToolsInTurn(messages) {
  return toolsInTurnMatching(messages, isUnsupportedOnDevice);
}

/** Map model tool_calls to the client contract `{ id, name, arguments }` (arguments parsed). */
export function toClientToolCalls(toolCalls = []) {
  return toolCalls.map((call) => {
    const raw = call?.function?.arguments;
    let args = {};
    let argumentsError;
    if (raw && typeof raw === 'object') {
      args = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        argumentsError = 'invalid_arguments_json';
      }
    }
    const out = { id: call.id, name: call?.function?.name, arguments: args };
    if (argumentsError) out.argumentsError = argumentsError;
    return out;
  });
}
