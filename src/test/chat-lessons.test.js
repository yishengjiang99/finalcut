import { describe, it, expect, beforeEach, vi } from 'vitest';

// Prevent config.js from calling process.exit when env vars are absent
vi.mock('../server/config.js', () => ({
  XAI_API_TOKEN: 'test-token',
  PORT: 3001,
  TMP_DIR: '/tmp',
  IS_PRODUCTION: false,
  OPENAI_API_KEY: null,
  STRIPE_SECRET_KEY: null,
  STRIPE_WEBHOOK_SECRET: null,
  GOOGLE_CLIENT_ID: null,
  GOOGLE_CLIENT_SECRET: null,
  GOOGLE_CALLBACK_URL: 'http://localhost:3001/auth/google/callback',
  SESSION_SECRET: 'test-secret',
  APP_BASE_URL: null,
  ALLOW_UNAUTH_SAMPLE_MODE: true,
  SAMPLE_TOKEN_TTL_MS: 600000,
  stripe: null,
  defaultStripePriceId: 'price_test',
  allowedStripePriceIds: new Set(['price_test']),
}));

// Stub out DB calls – not needed for unit-level filter tests
vi.mock('../db.js', () => ({
  enqueueChatInteraction: vi.fn(),
  getPool: vi.fn(),
}));

import {
  buildSystemMessage,
  createStreamFilter,
  applyStreamFilter,
  flushStreamFilter,
  restrictStreamingToolsToMedia,
  streamingMediaType,
} from '../server/chat.js';

describe('buildSystemMessage', () => {
  it('always includes the role and the output contract', () => {
    const message = buildSystemMessage();

    expect(message).toEqual(expect.objectContaining({ role: 'system' }));
    expect(message.content).toContain('editing assistant in FinalCap');
    expect(message.content).toContain('plain text, once, with no heading or label');
  });

  it('does not ask for an Answer section (the model repeated its reply inside it)', () => {
    expect(buildSystemMessage().content).not.toContain('Answer:');
  });

  it('does not ask for a Lesson line, but still hides one if the model writes it', () => {
    expect(buildSystemMessage().content).not.toContain('Lesson');
    const reply = 'Hello! How can I help?\nLesson: Greet briefly.';
    const filter = createStreamFilter();
    const shown = applyStreamFilter(filter, reply) + flushStreamFilter(filter);
    expect(shown).toBe('Hello! How can I help?');
  });

  it('states the media type and sends photo rules only when they can apply', () => {
    const video = buildSystemMessage({ mediaType: 'video' }).content;
    expect(video).toContain('Current media: a video.');
    expect(video).not.toContain('photo (');
    expect(video).not.toContain('apply_color_filter');

    expect(buildSystemMessage({ mediaType: 'audio' }).content).toContain('Current media: an audio file.');

    const photo = buildSystemMessage({ mediaType: 'image' }).content;
    expect(photo).toContain('Current media: a photo');
    expect(photo).toContain('convert_image_format');
    expect(photo).toContain('do not exist for a photo');
  });

  it('lists every photo-capable tool when the client did not say what the media is', () => {
    const unknown = buildSystemMessage().content;
    expect(unknown).toContain('may be a video or a photo');
    for (const name of ['crop_video', 'resize_video_preset', 'get_video_dimensions', 'get_supported_formats', 'convert_image_format']) {
      expect(unknown).toContain(name);
    }
    expect(unknown).not.toContain('trim_video');
  });

  it('never routes a photo to the FFmpeg fallback', () => {
    expect(buildSystemMessage({ ffmpegFallback: true, mediaType: 'image' }).content).not.toContain('ffmpeg_cli');
    expect(buildSystemMessage({ ffmpegFallback: true, mediaType: 'video' }).content).toContain('ffmpeg_cli');
    expect(buildSystemMessage({ ffmpegFallback: true }).content).toContain('never call ffmpeg_cli on a photo');
  });

  it('skips media guidance when nothing is attached', () => {
    const none = buildSystemMessage({ ffmpegFallback: true, mediaType: 'none' }).content;
    expect(none).not.toContain('Current media');
    expect(none).not.toContain('photo (');
    expect(none).not.toContain('ffmpeg_cli');
  });

  it('explains that later edits act on the output of earlier ones', () => {
    expect(buildSystemMessage().content).toContain('operates on the output of the one before it');
  });
});

describe('streaming media type', () => {
  it('accepts only known media types', () => {
    expect(streamingMediaType({ type: 'image' })).toBe('image');
    expect(streamingMediaType({ type: 'audio' })).toBe('audio');
    expect(streamingMediaType({ type: 'video' })).toBe('video');
    expect(streamingMediaType({ type: 'pdf' })).toBeNull();
    expect(streamingMediaType('image')).toBeNull();
    expect(streamingMediaType(undefined)).toBeNull();
  });

  it('offers only single-frame tools for a photo', () => {
    const tool = name => ({ type: 'function', function: { name } });
    const body = { tools: ['trim_video', 'crop_video', 'convert_image_format', 'ffmpeg_cli'].map(tool), tool_choice: 'auto' };
    expect(restrictStreamingToolsToMedia(body, 'image').tools.map(t => t.function.name))
      .toEqual(['crop_video', 'convert_image_format']);
    expect(restrictStreamingToolsToMedia(body, 'video')).toBe(body);
    expect(restrictStreamingToolsToMedia(body, null)).toBe(body);
    expect(restrictStreamingToolsToMedia({ tools: [tool('trim_video')], tool_choice: 'auto' }, 'image')).toEqual({});
  });
});

// ─── applyStreamFilter / flushStreamFilter ────────────────────────────────────

describe('applyStreamFilter', () => {
  let filter;
  beforeEach(() => {
    filter = createStreamFilter();
  });

  it('forwards normal content that contains no markers', () => {
    // Feed more than HOLD_SIZE (32) chars so content is released
    const chunk = 'Hello, this is a fairly long answer that exceeds 32 chars easily.';
    const out = applyStreamFilter(filter, chunk);
    expect(out.length).toBeGreaterThan(0);
    expect(filter.passThrough).toBe(true);
  });

  it('strips leading "Answer:\\n" prefix and does not forward it', () => {
    // Feed the prefix in one go
    const chunk = 'Answer:\nThe real answer content.';
    const out = applyStreamFilter(filter, chunk);
    // The prefix itself should not appear in forwarded content
    expect(out + filter.holdBuffer).not.toContain('Answer:\n');
    expect(filter.answerPrefixHandled).toBe(true);
  });

  it('strips leading "- Answer:\\n" prefix', () => {
    const chunk = '- Answer:\n  The real answer content with enough length.';
    const out = applyStreamFilter(filter, chunk);
    expect((out + filter.holdBuffer)).not.toMatch(/^- Answer:\n/);
    expect(filter.answerPrefixHandled).toBe(true);
  });

  it('holds content while prefix is ambiguous (partial match)', () => {
    // "- Ans" could be the start of "- Answer:\n"
    expect(applyStreamFilter(filter, '- Ans')).toBe('');
    expect(filter.answerPrefixHandled).toBe(false);
  });

  it('stops forwarding at "\\nLesson:" marker', () => {
    // Enough leading content so the hold buffer releases some, then lesson marker
    const chunk = 'The answer to your question is 42.\nLesson: Numbers matter.';
    let out = applyStreamFilter(filter, chunk);
    out += flushStreamFilter(filter);
    expect(out).not.toContain('Lesson:');
    expect(out).not.toContain('Numbers matter');
    expect(filter.passThrough).toBe(false);
  });

  it('stops forwarding at "\\n- Lesson:" marker', () => {
    const chunk = 'Answer content here.\n- Lesson: Key takeaway insight.';
    let out = applyStreamFilter(filter, chunk);
    out += flushStreamFilter(filter);
    expect(out).not.toContain('Lesson:');
    expect(filter.passThrough).toBe(false);
  });

  it('handles "Lesson:" marker split across two chunks', () => {
    // Simulate marker split: first chunk ends mid-marker
    const chunk1 = 'The answer text.\nLes';
    const chunk2 = 'son: Split-boundary lesson.';

    let out = applyStreamFilter(filter, chunk1);
    out += applyStreamFilter(filter, chunk2);
    out += flushStreamFilter(filter);

    expect(out).not.toContain('Lesson:');
    expect(out).not.toContain('Split-boundary lesson');
    expect(filter.passThrough).toBe(false);
  });

  it('handles "\\n" split across two chunks (newline before Lesson:)', () => {
    const chunk1 = 'Answer content';
    const chunk2 = '\nLesson: Another split case.';

    let out = applyStreamFilter(filter, chunk1);
    out += applyStreamFilter(filter, chunk2);
    out += flushStreamFilter(filter);

    expect(out).not.toContain('Lesson:');
    expect(filter.passThrough).toBe(false);
  });

  it('returns "" for all chunks after passThrough becomes false', () => {
    applyStreamFilter(filter, 'Content.\nLesson: Stop here.');
    expect(applyStreamFilter(filter, 'More content after lesson')).toBe('');
  });

  it('flushes hold buffer content that has no marker', () => {
    // Short content - all held in holdBuffer, flushed at end
    const chunk = 'Short';
    applyStreamFilter(filter, chunk);
    const flushed = flushStreamFilter(filter);
    expect(flushed).toBe('Short');
  });

  it('does not forward lesson content when "Lesson:" appears at buffer start', () => {
    // Simulate first content chunk IS the lesson
    const out = applyStreamFilter(filter, 'Lesson: Immediate lesson with no answer prefix.');
    expect(out).toBe('');
    expect(filter.passThrough).toBe(false);
  });

  it('flushStream returns "" when passThrough is already false', () => {
    applyStreamFilter(filter, 'Text.\nLesson: Done.');
    expect(flushStreamFilter(filter)).toBe('');
  });
});
