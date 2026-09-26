import express from 'express';
import { XAI_API_TOKEN } from './config.js';
import {
  apiLimiter,
  requireAuthenticatedUser,
  requireActiveSubscription,
  requireInferenceAccess,
} from './middleware.js';
import { enqueueChatInteraction, saveLesson } from '../db.js';
import { PHOTO_SUPPORTED_OPS, PHOTO_OUTPUT_FORMATS, COLOR_FILTER_PRESETS } from './ffmpegOps.js';
import { buildToolsSchema, toolsForMediaType } from './toolsSchema.js';
import {
  CLIENT_SCHEMA_VERSION,
  CLIENT_EXECUTION_INSTRUCTIONS,
  ClientRequestError,
  MAX_TOOL_ROUNDS,
  countToolRounds,
  mediaContextText,
  modelSupportsVision,
  normalizeClientMessages,
  parseThumbnails,
  skippedToolsInTurn,
  toClientToolCalls,
  validateMedia,
} from './clientExecution.js';

const router = express.Router();

// ─── Streaming filter helpers (exported for unit tests) ──────────────────────

/**
 * Extract the lesson text from a completed assistant message.
 * Handles both inline ("Lesson: text") and next-line ("Lesson:\n  text") formats,
 * with or without a leading "- " bullet.
 */
export function extractLesson(text) {
  const markerRe = /(?:^|\n)[- ]*Lesson:[ \t]*(.*)/;
  const match = markerRe.exec(text);
  if (!match) return '';

  const sameLine = match[1].trim();
  if (sameLine) return sameLine.slice(0, 240);

  // Lesson text is on the next line(s)
  const markerEnd = match.index + match[0].length;
  const remaining = text.slice(markerEnd);
  for (const line of remaining.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 240);
  }
  return '';
}

/**
 * Create a new streaming filter state object.
 * The filter strips the "Answer:" heading and hides the "Lesson:" section
 * from the forwarded SSE stream while still accumulating the full text.
 */
export function createStreamFilter() {
  return {
    passThrough: true,
    holdBuffer: '',
    answerPrefixHandled: false,
    HOLD_SIZE: 32,
  };
}

// Answer prefixes to strip from the start of the stream
const ANSWER_PREFIXES = ['- Answer:\n', 'Answer:\n'];
const MAX_PREFIX_LEN = Math.max(...ANSWER_PREFIXES.map(p => p.length));

// Lesson marker variants (with optional leading "- " bullet)
const LESSON_MARKERS = ['\n- Lesson:', '\nLesson:'];

/**
 * Process a new delta content chunk through the filter.
 * Returns the content that should be forwarded to the client (may be '').
 * Uses a small rolling hold-buffer to detect markers split across chunk boundaries.
 */
export function applyStreamFilter(filter, newContent) {
  if (!filter.passThrough) return '';

  filter.holdBuffer += newContent;

  // ── Strip "Answer:\n" / "- Answer:\n" prefix once at stream start ──────────
  if (!filter.answerPrefixHandled) {
    if (filter.holdBuffer.length >= MAX_PREFIX_LEN) {
      filter.answerPrefixHandled = true;
      for (const prefix of ANSWER_PREFIXES) {
        if (filter.holdBuffer.startsWith(prefix)) {
          // Strip the heading and any horizontal whitespace that follows
          filter.holdBuffer = filter.holdBuffer.slice(prefix.length).replace(/^[ \t]+/, '');
          break;
        }
      }
    } else {
      // Not enough data yet — only hold if buffer could still be a valid prefix
      const couldMatch = ANSWER_PREFIXES.some(p => p.startsWith(filter.holdBuffer));
      if (couldMatch) return '';
      filter.answerPrefixHandled = true; // Definitely not a prefix
    }
  }

  // ── Detect "Lesson:" marker (handles split across chunk boundaries) ─────────
  for (const marker of LESSON_MARKERS) {
    const idx = filter.holdBuffer.indexOf(marker);
    if (idx !== -1) {
      const toForward = filter.holdBuffer.slice(0, idx);
      filter.holdBuffer = '';
      filter.passThrough = false;
      return toForward;
    }
  }
  // "Lesson:" / "- Lesson:" at the very start of buffer (no preceding newline)
  if (filter.holdBuffer.startsWith('Lesson:') || filter.holdBuffer.startsWith('- Lesson:')) {
    filter.holdBuffer = '';
    filter.passThrough = false;
    return '';
  }

  // ── Forward content, holding back HOLD_SIZE chars to catch split markers ───
  if (filter.holdBuffer.length > filter.HOLD_SIZE) {
    const toForward = filter.holdBuffer.slice(0, filter.holdBuffer.length - filter.HOLD_SIZE);
    filter.holdBuffer = filter.holdBuffer.slice(filter.holdBuffer.length - filter.HOLD_SIZE);
    return toForward;
  }

  return '';
}

/**
 * Flush the remaining hold-buffer at stream end.
 * Returns any content that should still be forwarded.
 */
export function flushStreamFilter(filter) {
  if (!filter.passThrough) return '';
  const result = filter.holdBuffer;
  filter.holdBuffer = '';
  return result;
}

// ─── System prompt builder ───────────────────────────────────────────────────

export function buildSystemMessage() {
  const photoGuidance =
    'The current media may be a video OR a photo (jpg, png, webp, heic). For a photo, only call frame edits (' +
    PHOTO_SUPPORTED_OPS.join(', ') +
    '); color looks such as "red filter", "sepia" or "black and white" use apply_color_filter. ' +
    'Never call trim, speed, audio, caption, or transition tools on a photo — explain they only apply to videos.\n\n';
  const outputContract =
    photoGuidance +
    'When a request requires multiple edits, emit one tool call for each edit in the order they should be applied. The tool calls will be executed sequentially on the current media.\n\n' +
    'Always end your FINAL response (after any tool use is complete) with exactly this format:\n' +
    '- Answer:\n' +
    '  <your answer here>\n' +
    '- Lesson:\n' +
    '  <1-2 sentences summarizing a key insight, max 240 chars, no private data>\n' +
    'No third section.';

  return { role: 'system', content: outputContract };
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function getLatestUserMessageText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') {
      return messageContentToText(message.content);
    }
  }
  return '';
}

function serializeError(error) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

function enqueueChatError({ userId, message, source, requestMessageCount, metadata = {} }) {
  enqueueChatInteraction({
    userId,
    interactionType: 'error',
    content: message,
    metadata: {
      source,
      requestMessageCount,
      ...metadata,
    },
  });
}

// ─── Client-execution mode (tools run on the device) ─────────────────────────

/** Strip the "Answer:" heading and hidden "Lesson:" section from a final reply. */
export function cleanFinalText(text) {
  const filter = createStreamFilter();
  const head = applyStreamFilter(filter, String(text || ''));
  return (head + flushStreamFilter(filter)).trim();
}

/** Model for client-execution turns (defaults to the same model as the streaming chat). */
export function getClientExecutionModel() {
  return process.env.XAI_CLIENT_MODEL || 'grok-3';
}

/**
 * POST /api/chat with `execution: "client"`.
 * One model call per request: returns either tool calls for the device to run or the final answer.
 * Never runs ffmpeg or touches uploaded media.
 */
async function handleClientExecution(req, res, userId) {
  let media;
  let thumbnails;
  let conversation;
  try {
    media = validateMedia(req.body.media);
    thumbnails = parseThumbnails(req.body.thumbnails);
    conversation = normalizeClientMessages(req.body.messages);
  } catch (error) {
    if (error instanceof ClientRequestError) {
      return res.status(error.status).json({ error: error.message, schemaVersion: CLIENT_SCHEMA_VERSION });
    }
    throw error;
  }

  const latestUserText = getLatestUserMessageText(conversation);
  enqueueChatInteraction({
    userId,
    interactionType: 'human2ai',
    content: latestUserText,
    metadata: {
      authMethod: req.authMethod || (req.headers['sample-access-token'] ? 'sample' : null),
      messageCount: conversation.length,
      execution: 'client',
      mediaType: media?.type ?? null,
    },
  });

  const model = getClientExecutionModel();
  const thumbnailsAsImages = thumbnails.length > 0 && modelSupportsVision(model);
  const rounds = countToolRounds(conversation);
  const skippedTools = skippedToolsInTurn(conversation);
  const roundCapReached = rounds >= MAX_TOOL_ROUNDS;

  const offeredTools = toolsForMediaType(media?.type).filter(t => !skippedTools.includes(t.function.name));
  const contextLines = [
    CLIENT_EXECUTION_INSTRUCTIONS,
    mediaContextText(media, { thumbnailCount: thumbnails.length, thumbnailsAsImages }),
  ];
  if (skippedTools.length) {
    contextLines.push(`The user declined these steps this turn (not failures): ${skippedTools.join(', ')}. Do not call them again in this turn.`);
  }
  if (roundCapReached) {
    contextLines.push(`Tool-call limit (${MAX_TOOL_ROUNDS} rounds) reached for this turn: do not call tools; give the final answer now.`);
  }
  const baseSystem = buildSystemMessage();
  const systemMessage = { role: 'system', content: `${baseSystem.content}\n\n${contextLines.join('\n')}` };

  const modelMessages = [systemMessage];
  if (thumbnailsAsImages) {
    modelMessages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Thumbnail frame(s) of the current media, for visual context only:' },
        ...thumbnails.map(t => ({ type: 'image_url', image_url: { url: t.dataUrl, detail: 'low' } })),
      ],
    });
  }
  modelMessages.push(...conversation);

  const requestBody = {
    model,
    messages: modelMessages,
    stream: false,
  };
  if (offeredTools.length && !roundCapReached) {
    requestBody.tools = offeredTools;
    requestBody.tool_choice = 'auto';
  }

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${XAI_API_TOKEN}`
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    let errorBody = {};
    try {
      errorBody = await response.json();
    } catch {
      errorBody = { message: response.statusText };
    }
    const message = errorBody.error?.message || errorBody.message || response.statusText || 'xAI API request failed';
    enqueueChatError({
      userId,
      message,
      source: 'xai_api',
      requestMessageCount: conversation.length,
      metadata: { status: response.status, statusText: response.statusText, execution: 'client' },
    });
    return res.status(response.status).json({ error: message, schemaVersion: CLIENT_SCHEMA_VERSION });
  }

  const data = await response.json();
  const choice = data?.choices?.[0]?.message || {};
  const allowedNames = new Set(offeredTools.map(t => t.function.name));
  const modelToolCalls = (Array.isArray(choice.tool_calls) ? choice.tool_calls : [])
    .filter(call => !roundCapReached && allowedNames.has(call?.function?.name));

  if (modelToolCalls.length) {
    const assistantMessage = {
      role: 'assistant',
      content: typeof choice.content === 'string' ? choice.content : null,
      tool_calls: modelToolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: typeof call.function.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function.arguments ?? {}),
        },
      })),
    };
    return res.json({
      schemaVersion: CLIENT_SCHEMA_VERSION,
      status: 'tool_calls',
      toolCalls: toClientToolCalls(assistantMessage.tool_calls),
      messages: [...conversation, assistantMessage],
      round: rounds + 1,
      maxRounds: MAX_TOOL_ROUNDS,
      thumbnailsSentAsImages: thumbnailsAsImages,
    });
  }

  const rawText = typeof choice.content === 'string' ? choice.content : '';
  const message = cleanFinalText(rawText)
    || (skippedTools.length ? 'Okay — I skipped the steps you declined.' : 'Done.');
  enqueueChatInteraction({
    userId,
    interactionType: 'ai2human',
    content: rawText,
    metadata: { model, streamed: false, execution: 'client' },
  });
  if (userId) {
    const lesson = extractLesson(rawText);
    if (lesson) await saveLesson(userId, lesson);
  }
  return res.json({
    schemaVersion: CLIENT_SCHEMA_VERSION,
    status: 'final',
    message,
    messages: [...conversation, { role: 'assistant', content: message }],
    thumbnailsSentAsImages: thumbnailsAsImages,
  });
}

// ─── Route ───────────────────────────────────────────────────────────────────

// Proxy endpoint for xAI API with streaming support
router.post('/api/chat', apiLimiter, requireAuthenticatedUser, requireInferenceAccess, async (req, res) => {
  const userId = req.user?.id ?? null;
  try {
    // Basic request validation
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    if (req.body.execution !== undefined) {
      if (req.body.execution !== 'client') {
        return res.status(400).json({ error: 'execution must be "client" (omit it for the default streaming mode)' });
      }
      return await handleClientExecution(req, res, userId);
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    const latestUserText = getLatestUserMessageText(req.body.messages);
    enqueueChatInteraction({
      userId,
      interactionType: 'human2ai',
      content: latestUserText,
      metadata: {
        authMethod: req.authMethod || (req.headers['sample-access-token'] ? 'sample' : null),
        messageCount: req.body.messages.length,
      },
    });

    // Keep the client payload focused on the latest actionable request, but
    // always restore the server-owned system contract.
    const systemMessage = buildSystemMessage();

    // Enable streaming for xAI API
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_TOKEN}`
      },
      body: JSON.stringify({
        ...req.body,
        messages: [systemMessage, ...req.body.messages],
        model: 'grok-3', // Specify the new model here
        stream: true // Enable streaming
      })
    });

    if (!response.ok) {
      let errorBody = {};
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { message: response.statusText };
      }
      const message = errorBody.error?.message || errorBody.message || response.statusText || 'xAI API request failed';
      enqueueChatError({
        userId,
        message,
        source: 'xai_api',
        requestMessageCount: req.body.messages.length,
        metadata: {
          status: response.status,
          statusText: response.statusText,
        },
      });
      return res.status(response.status).json({ error: message });
    }

    // Set headers for Server-Sent Events (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Stream the response chunks to the client, filtering out the Lesson section
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let lineBuffer = '';
    let assistantText = '';
    const filter = createStreamFilter();
    let doneFlushed = false;
    let lastParsed = null; // keep reference for flush emit

    // Emit a synthetic SSE data line with the given content, reusing parsed event structure
    function emitContent(parsed, content) {
      const modified = JSON.parse(JSON.stringify(parsed));
      modified.choices[0].delta.content = content;
      res.write(`data: ${JSON.stringify(modified)}\n\n`);
    }

    // Flush hold-buffer and emit remaining content (called once at stream end)
    function flushAndEmit(parsed) {
      if (doneFlushed) return;
      doneFlushed = true;
      const remaining = flushStreamFilter(filter);
      if (remaining && parsed) emitContent(parsed, remaining);
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          flushAndEmit(lastParsed);
          break;
        }

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.replace(/\r$/, ''); // handle \r\n line endings
          if (!line.startsWith('data: ')) {
            // Non-data SSE lines (event:, id:, comments) – forward as-is
            if (line.trim() !== '') {
              res.write(`${line}\n`);
            }
            continue;
          }

          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            flushAndEmit(lastParsed);
            res.write('data: [DONE]\n\n');
            continue;
          }

          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            // Unparseable line – forward as-is
            res.write(`${line}\n\n`);
            continue;
          }

          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            assistantText += delta.content;
            lastParsed = parsed;
            const toForward = applyStreamFilter(filter, delta.content);
            if (toForward.length > 0) {
              emitContent(parsed, toForward);
            }
          } else {
            // Non-content delta (role, tool_calls, finish_reason, etc.) – forward as-is
            res.write(`${line}\n\n`);
          }
        }
      }
      res.end();
    } catch (streamError) {
      console.error('Error streaming response:', streamError);
      enqueueChatError({
        userId,
        message: serializeError(streamError),
        source: 'xai_stream',
        requestMessageCount: req.body.messages.length,
      });
      res.end();
    }

    // Queue model response storage after stream ends; this never blocks the client.
    enqueueChatInteraction({
      userId,
      interactionType: 'ai2human',
      content: assistantText,
      metadata: {
        model: 'grok-3',
        streamed: true,
      },
    });

    // Persist lesson after stream ends (errors are logged inside saveLesson)
    if (userId) {
      const lesson = extractLesson(assistantText);
      if (lesson) {
        await saveLesson(userId, lesson);
      }
    }
  } catch (error) {
    console.error('Error in /api/chat:', error);
    enqueueChatError({
      userId,
      message: serializeError(error),
      source: 'chat_route',
      requestMessageCount: Array.isArray(req.body?.messages) ? req.body.messages.length : null,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/api/chat-error', apiLimiter, requireAuthenticatedUser, requireActiveSubscription, (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ error: 'Error message is required' });
  }

  enqueueChatError({
    userId: req.user?.id ?? null,
    message,
    source: 'client',
    requestMessageCount: Number.isInteger(req.body?.messageCount) ? req.body.messageCount : null,
    metadata: {
      name: typeof req.body?.name === 'string' ? req.body.name : null,
      stack: typeof req.body?.stack === 'string' ? req.body.stack.slice(0, 4000) : null,
      context: req.body?.context && typeof req.body.context === 'object' ? req.body.context : null,
    },
  });

  res.status(202).json({ ok: true });
});

// Versioned tool-schema contract for native clients (static; no quota).
router.get('/api/tools/schema', apiLimiter, (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(buildToolsSchema());
});

// Supported formats introspection endpoint
router.get('/api/supported-formats', apiLimiter, requireAuthenticatedUser, requireActiveSubscription, (req, res) => {
  res.json({
    video: {
      formats: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv', 'ogv'],
      codecs: ['libx264', 'libx265', 'libvpx-vp9', 'auto']
    },
    audio: {
      formats: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma'],
      bitrates: ['64k', '128k', '192k', '256k', '320k']
    },
    extract: {
      formats: ['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a']
    },
    image: {
      inputFormats: ['jpg', 'png', 'webp', 'heic', 'gif', 'bmp', 'tiff'],
      outputFormats: PHOTO_OUTPUT_FORMATS,
      operations: PHOTO_SUPPORTED_OPS,
      colorFilters: COLOR_FILTER_PRESETS,
    }
  });
});

export { router as chatRouter };
