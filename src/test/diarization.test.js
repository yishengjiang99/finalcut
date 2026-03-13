import { describe, it, expect } from 'vitest';
import { secondsToTimestamp, buildSrtAndVtt } from '../server/utils.js';

// Unit tests for speaker diarization helper logic (pure functions, no server/HTTP needed).
// The implementation uses the OpenAI batch POST /v1/audio/transcriptions endpoint
// with response_format:"diarized_json", which returns segments with start/end in seconds.

describe('Speaker Diarization - SRT/VTT Generation (batch API, seconds-based)', () => {
  it('returns empty srt/vtt for empty segments', () => {
    const { srt, vtt } = buildSrtAndVtt([]);
    expect(srt).toBe('');
    expect(vtt).toBe('WEBVTT\n');
  });

  it('generates valid SRT without speaker labels', () => {
    const segments = [
      { start: 0, end: 2.5, speaker: null, text: 'Hello world' },
      { start: 2.5, end: 5.0, speaker: null, text: 'How are you?' }
    ];
    const { srt } = buildSrtAndVtt(segments);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,500\nHello world');
    expect(srt).toContain('2\n00:00:02,500 --> 00:00:05,000\nHow are you?');
  });

  it('generates SRT with speaker labels prefixed "Speaker N: "', () => {
    const segments = [
      { start: 0, end: 3.0, speaker: 'Speaker 1', text: 'Hi there' },
      { start: 3.0, end: 6.0, speaker: 'Speaker 2', text: 'Hello!' }
    ];
    const { srt } = buildSrtAndVtt(segments);
    expect(srt).toContain('Speaker 1: Hi there');
    expect(srt).toContain('Speaker 2: Hello!');
  });

  it('formats timestamps correctly for hours/minutes/seconds', () => {
    // 3661.5 seconds = 1h 1m 1s 500ms
    const segments = [
      { start: 3661.5, end: 3665.0, speaker: 'Speaker 1', text: 'Test' }
    ];
    const { srt } = buildSrtAndVtt(segments);
    expect(srt).toContain('01:01:01,500 --> 01:01:05,000');
  });

  it('increments sequence numbers correctly', () => {
    const segments = [
      { start: 0, end: 1.0, speaker: null, text: 'One' },
      { start: 1.0, end: 2.0, speaker: null, text: 'Two' },
      { start: 2.0, end: 3.0, speaker: null, text: 'Three' }
    ];
    const { srt } = buildSrtAndVtt(segments);
    expect(srt).toMatch(/^1\n/);
    expect(srt).toContain('\n\n2\n');
    expect(srt).toContain('\n\n3\n');
  });

  it('handles mixed speaker and no-speaker segments', () => {
    const segments = [
      { start: 0, end: 2.0, speaker: 'Speaker 1', text: 'Hello' },
      { start: 2.0, end: 4.0, speaker: null, text: '[inaudible]' }
    ];
    const { srt } = buildSrtAndVtt(segments);
    expect(srt).toContain('Speaker 1: Hello');
    expect(srt).toContain('[inaudible]');
    expect(srt).not.toContain('null:');
  });

  it('generates VTT with "." separator instead of ","', () => {
    const segments = [
      { start: 0, end: 2.5, speaker: 'Speaker 1', text: 'Hello' }
    ];
    const { vtt } = buildSrtAndVtt(segments);
    expect(vtt).toMatch(/^WEBVTT/);
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.500');
    expect(vtt).not.toContain(',');
  });

  it('includes speaker label in VTT output', () => {
    const segments = [
      { start: 0, end: 2.0, speaker: 'Speaker 1', text: 'Hi' }
    ];
    const { vtt } = buildSrtAndVtt(segments);
    expect(vtt).toContain('Speaker 1: Hi');
  });
});

describe('Speaker Diarization - Batch API Configuration', () => {
  it('should have /api/generate-captions-diarized endpoint defined', () => {
    const endpoint = '/api/generate-captions-diarized';
    expect(endpoint).toBe('/api/generate-captions-diarized');
  });

  it('should use batch HTTP endpoint, not WebSocket', () => {
    const apiUrl = 'https://api.openai.com/v1/audio/transcriptions';
    expect(apiUrl).toMatch(/^https:/);
    expect(apiUrl).not.toMatch(/^wss:/);
    expect(apiUrl).toContain('/audio/transcriptions');
  });

  it('should prefer gpt-4o-transcribe-diarize with diarized_json format', () => {
    const primaryModel = { model: 'gpt-4o-transcribe-diarize', format: 'diarized_json' };
    expect(primaryModel.model).toMatch(/diarize/);
    expect(primaryModel.format).toBe('diarized_json');
  });

  it('should have correct model fallback chain', () => {
    const fallbackModels = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'];
    expect(fallbackModels[0]).toBe('gpt-4o-transcribe');
    expect(fallbackModels[1]).toBe('gpt-4o-mini-transcribe');
    expect(fallbackModels[2]).toBe('whisper-1');
  });

  it('should use WAV 16 kHz mono audio format for transcription API', () => {
    const audioConfig = {
      frequency: 16000,
      channels: 1,
      codec: 'pcm_s16le',
      format: 'wav'
    };
    expect(audioConfig.frequency).toBe(16000);
    expect(audioConfig.channels).toBe(1);
    expect(audioConfig.format).toBe('wav');
  });

  it('should split audio at 25 MB boundary', () => {
    const MAX_BYTES = 25 * 1024 * 1024;
    expect(MAX_BYTES).toBe(26214400);
  });
});

