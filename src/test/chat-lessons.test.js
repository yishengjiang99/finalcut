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
  getRecentLessons: vi.fn().mockResolvedValue([]),
  saveLesson: vi.fn().mockResolvedValue(undefined),
  getPool: vi.fn(),
}));

import {
  extractLesson,
  createStreamFilter,
  applyStreamFilter,
  flushStreamFilter,
} from '../server/chat.js';

// ─── extractLesson ────────────────────────────────────────────────────────────

describe('extractLesson', () => {
  it('returns empty string when no Lesson marker is present', () => {
    expect(extractLesson('Some answer text without a lesson.')).toBe('');
  });

  it('extracts inline lesson text (same line as marker)', () => {
    const text = 'Answer text.\nLesson: Always validate input before processing.';
    expect(extractLesson(text)).toBe('Always validate input before processing.');
  });

  it('extracts lesson text from next line (indented format)', () => {
    const text = '- Answer:\n  The answer.\n- Lesson:\n  Cache results to avoid repeated work.';
    expect(extractLesson(text)).toBe('Cache results to avoid repeated work.');
  });

  it('strips "- " bullet prefix from the Lesson marker', () => {
    const text = 'Explanation.\n- Lesson: Use typed parameters to prevent injection.';
    expect(extractLesson(text)).toBe('Use typed parameters to prevent injection.');
  });

  it('truncates lesson text to 240 characters', () => {
    const long = 'x'.repeat(300);
    const text = `Answer.\nLesson: ${long}`;
    expect(extractLesson(text)).toHaveLength(240);
  });

  it('returns empty string when Lesson section is present but empty', () => {
    expect(extractLesson('Something.\nLesson:')).toBe('');
  });

  it('handles Lesson at the very start of text', () => {
    expect(extractLesson('Lesson: Start with simplest possible test.')).toBe(
      'Start with simplest possible test.'
    );
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
