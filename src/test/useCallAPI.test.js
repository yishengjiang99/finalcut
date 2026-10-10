import { describe, expect, it } from 'vitest';
import { assertToolCallApplied, buildChatRequestBody, messagesForCurrentTurn, needsFollowUp, NO_MEDIA_NOTE } from '../useCallAPI.js';

describe('assertToolCallApplied', () => {
  it('accepts a successful tool result', () => {
    expect(assertToolCallApplied('Audio volume adjusted successfully.', 'adjust_volume'))
      .toBe('Audio volume adjusted successfully.');
  });

  it('rejects a failed tool result', () => {
    expect(() => assertToolCallApplied('Failed to adjust volume: FFmpeg error', 'adjust_volume'))
      .toThrow('adjust_volume');
  });

  it('rejects a missing tool result', () => {
    expect(() => assertToolCallApplied('', 'adjust_brightness'))
      .toThrow('no result returned');
  });
});

describe('buildChatRequestBody', () => {
  const messages = [{ role: 'user', content: 'What can you do?', id: 1 }];

  it('offers the editing tools when media is attached', () => {
    const body = buildChatRequestBody(messages, true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tool_choice).toBe('auto');
    expect(body.messages).toEqual([{ role: 'user', content: 'What can you do?' }]);
  });

  it('sends a plain chat request without tools when no media is attached', () => {
    const body = buildChatRequestBody(messages, false);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body.messages).toEqual([
      { role: 'system', content: NO_MEDIA_NOTE },
      { role: 'user', content: 'What can you do?' }
    ]);
  });
});

describe('ffmpeg_cli follow-up rounds', () => {
  const call = (name, args) => ({ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } });

  it('follows up after discover and plan, but not after run or a regular edit', () => {
    expect(needsFollowUp([call('ffmpeg_cli', { action: 'discover', query: 'thumbnail' })])).toBe(true);
    expect(needsFollowUp([call('ffmpeg_cli', { action: 'plan' })])).toBe(true);
    expect(needsFollowUp([call('ffmpeg_cli', { action: 'run' })])).toBe(false);
    expect(needsFollowUp([call('adjust_brightness', { brightness: -0.3 })])).toBe(false);
  });

  it('sends the tool exchange after the latest request back to the model', () => {
    const discover = call('ffmpeg_cli', { action: 'discover', query: 'thumbnail' });
    const messages = [
      { role: 'user', content: 'make it darker', id: 1 },
      { role: 'assistant', content: null, tool_calls: [call('adjust_brightness', {})], id: 2 },
      { role: 'user', content: 'add cover image', id: 3 },
      { role: 'assistant', content: null, tool_calls: [discover], id: 4 },
      { role: 'tool', tool_call_id: 'c1', name: 'ffmpeg_cli', content: '{"ok":true}', id: 5 },
      { role: 'assistant', content: 'Processed video:', excludeFromAPI: true, id: 6 }
    ];
    expect(messagesForCurrentTurn(messages)).toEqual([
      { role: 'user', content: 'add cover image' },
      { role: 'assistant', content: null, tool_calls: [discover] },
      { role: 'tool', tool_call_id: 'c1', name: 'ffmpeg_cli', content: '{"ok":true}' }
    ]);
  });
});
