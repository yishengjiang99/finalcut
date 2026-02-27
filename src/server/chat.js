import express from 'express';
import { XAI_API_TOKEN } from './config.js';
import {
  apiLimiter,
  requireAuthenticatedUser,
  requireActiveSubscription,
} from './middleware.js';
import { getRecentLessons, saveLesson } from '../db.js';

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

function buildSystemMessage(recentLessons) {
  const outputContract =
    'Always end your FINAL response (after any tool use is complete) with exactly this format:\n' +
    '- Answer:\n' +
    '  <your answer here>\n' +
    '- Lesson:\n' +
    '  <1-2 sentences summarizing a key insight, max 240 chars, no private data>\n' +
    'No third section.';

  let content = outputContract;
  if (recentLessons.length > 0) {
    const bullets = recentLessons.map(l => `- ${l}`).join('\n');
    content += `\n\nRecent lessons (do not repeat verbatim unless relevant):\n${bullets}`;
  }
  return { role: 'system', content };
}

// ─── Route ───────────────────────────────────────────────────────────────────

// Proxy endpoint for xAI API with streaming support
router.post('/api/chat', apiLimiter, requireAuthenticatedUser, requireActiveSubscription, async (req, res) => {
  try {
    // Basic request validation
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    const userId = req.user?.id ?? null;

    // Build injected messages: prepend system message with output contract + recent lessons
    const recentLessons = userId ? await getRecentLessons(userId) : [];
    const systemMessage = buildSystemMessage(recentLessons);
    const injectedMessages = [systemMessage, ...req.body.messages];

    // Enable streaming for xAI API
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_TOKEN}`
      },
      body: JSON.stringify({
        ...req.body,
        messages: injectedMessages,
        model: 'grok-3', // Specify the new model here
        stream: true // Enable streaming
      })
    });

    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json({ error: error.message });
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
      res.end();
    }

    // Persist lesson after stream ends (errors are logged inside saveLesson)
    if (userId) {
      const lesson = extractLesson(assistantText);
      if (lesson) {
        await saveLesson(userId, lesson);
      }
    }
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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
    }
  });
});

export { router as chatRouter };
