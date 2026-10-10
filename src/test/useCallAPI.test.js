import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { ChatRequestError, useCallAPI, assertToolCallApplied, buildChatRequestBody, mediaForInference, messagesForCurrentTurn, needsFollowUp, NO_MEDIA_NOTE, cliStringFallbackRequest } from '../useCallAPI.js';

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

  it('tells the server what kind of file is attached', () => {
    expect(mediaForInference('image/png')).toEqual({ type: 'image' });
    expect(mediaForInference('audio/mpeg')).toEqual({ type: 'audio' });
    expect(mediaForInference('video/quicktime')).toEqual({ type: 'video' });
    expect(mediaForInference('')).toBeNull();
    expect(buildChatRequestBody(messages, true, { type: 'image' }).media).toEqual({ type: 'image' });
    expect(buildChatRequestBody(messages, true)).not.toHaveProperty('media');
    expect(buildChatRequestBody(messages, false, { type: 'image' })).not.toHaveProperty('media');
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
    expect(needsFollowUp([call('get_video_dimensions', {})])).toBe(true);
    expect(needsFollowUp([call('get_video_dimensions', {}), call('add_text', { text: 'Hi' })])).toBe(false);
    expect(needsFollowUp([])).toBe(false);
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

describe('ffmpeg CLI string fallback trigger', () => {
  const messages = [{ role: 'user', content: 'add cover image to the video', id: 1 }, { role: 'assistant', content: 'I will work it out with FFmpeg.', id: 2 }];
  const call = { id: 'c1', type: 'function', function: { name: 'trim_video', arguments: '{}' } };

  it('asks for the CLI string only when a video/audio reply carries no tool call', () => {
    expect(cliStringFallbackRequest(messages, [], true, 'video/mp4')).toBe('add cover image to the video');
    expect(cliStringFallbackRequest(messages, [], true, 'audio/mpeg')).toBe('add cover image to the video');
    expect(cliStringFallbackRequest(messages, [call], true, 'video/mp4')).toBeNull();
    expect(cliStringFallbackRequest(messages, [], false, null)).toBeNull();
    expect(cliStringFallbackRequest(messages, [], true, 'image/png')).toBeNull();
  });
});

describe('ChatRequestError', () => {
  it('reports a 401 from our own auth layer as an expired session, not an xAI failure', () => {
    const error = new ChatRequestError(401, { error: 'Authentication required' }, 'Unauthorized');
    expect(error.authExpired).toBe(true);
    expect(error.message).toBe('Your session has expired. Sign in again to continue.');
  });

  it('attributes a 401 relayed from xAI to xAI', () => {
    const error = new ChatRequestError(401, { error: 'Incorrect API key provided', source: 'xai' }, 'Unauthorized');
    expect(error.authExpired).toBe(false);
    expect(error.message).toBe('xAI API error (401): Incorrect API key provided');
  });

  it('shows the server error text, falling back to the status line', () => {
    expect(new ChatRequestError(403, { error: 'Active subscription required' }, 'Forbidden').message)
      .toBe('Request failed (403): Active subscription required');
    expect(new ChatRequestError(502, {}, 'Bad Gateway').message).toBe('Request failed (502): Bad Gateway');
  });
});

describe('useCallAPI auth failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const reply = () => new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n');
  const setup = (props) => {
    const addMessage = vi.fn();
    const { result } = renderHook(() => useCallAPI({
      setIsCallingAPI: vi.fn(), setProcessing: vi.fn(), setMessages: vi.fn(), setVideoFileData: vi.fn(),
      messageIdCounterRef: { current: 1 }, videoFileData: null, uploadedVideos: [], addMessage, ...props,
    }));
    return { callAPI: result.current, addMessage };
  };
  const turn = [{ role: 'user', content: 'hi', id: 1 }];

  it('renews an expired sample token and retries the request once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(401, { error: 'Invalid or expired sample access token' }))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal('fetch', fetchMock);
    const refreshSampleAccessToken = vi.fn().mockResolvedValue('fresh');
    const { callAPI, addMessage } = setup({ isSampleMode: true, sampleAccessToken: 'stale', refreshSampleAccessToken });

    expect(await callAPI([...turn])).not.toBe('error');
    expect(refreshSampleAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.headers['sample-access-token']]))
      .toEqual([['/api/chat', 'stale'], ['/api/chat', 'fresh']]);
    expect(addMessage).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('expired') }));
  });

  it('asks a signed-in user to sign in again instead of blaming xAI', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, { error: 'Authentication required' }));
    vi.stubGlobal('fetch', fetchMock);
    const onAuthExpired = vi.fn();
    const { callAPI, addMessage } = setup({ isSampleMode: false, sampleAccessToken: null, onAuthExpired });

    expect(await callAPI([...turn])).toBe('error');
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(addMessage).toHaveBeenCalledWith({ text: 'Your session has expired. Sign in again to continue.' });
  });
});
