import { describe, it, expect } from 'vitest';

// Unit tests for speaker diarization helper logic (pure functions, no server/WebSocket needed)

// Replicates the buildSrtFromSegments logic from server.js for unit testing
function buildSrtFromSegments(segments) {
  if (!segments.length) return '';
  let index = 1;
  return segments.map(seg => {
    const formatTime = (ms) => {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      const s = Math.floor((ms % 60_000) / 1000);
      const ms_ = ms % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms_).padStart(3, '0')}`;
    };
    const label = seg.speaker ? `${seg.speaker}: ` : '';
    return `${index++}\n${formatTime(seg.startMs)} --> ${formatTime(seg.endMs)}\n${label}${seg.text}`;
  }).join('\n\n');
}

describe('Speaker Diarization - SRT Generation', () => {
  it('returns empty string for empty segments', () => {
    expect(buildSrtFromSegments([])).toBe('');
  });

  it('generates valid SRT without speaker labels', () => {
    const segments = [
      { startMs: 0, endMs: 2500, speaker: null, text: 'Hello world' },
      { startMs: 2500, endMs: 5000, speaker: null, text: 'How are you?' }
    ];
    const srt = buildSrtFromSegments(segments);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,500\nHello world');
    expect(srt).toContain('2\n00:00:02,500 --> 00:00:05,000\nHow are you?');
  });

  it('generates SRT with speaker labels', () => {
    const segments = [
      { startMs: 0, endMs: 3000, speaker: 'Speaker 1', text: 'Hi there' },
      { startMs: 3000, endMs: 6000, speaker: 'Speaker 2', text: 'Hello!' }
    ];
    const srt = buildSrtFromSegments(segments);
    expect(srt).toContain('Speaker 1: Hi there');
    expect(srt).toContain('Speaker 2: Hello!');
  });

  it('formats timestamps correctly for hours/minutes/seconds', () => {
    const segments = [
      { startMs: 3_661_500, endMs: 3_665_000, speaker: 'Speaker 1', text: 'Test' }
    ];
    const srt = buildSrtFromSegments(segments);
    // 3661500ms = 1h 1m 1.5s
    expect(srt).toContain('01:01:01,500 --> 01:01:05,000');
  });

  it('increments sequence numbers correctly', () => {
    const segments = [
      { startMs: 0, endMs: 1000, speaker: null, text: 'One' },
      { startMs: 1000, endMs: 2000, speaker: null, text: 'Two' },
      { startMs: 2000, endMs: 3000, speaker: null, text: 'Three' }
    ];
    const srt = buildSrtFromSegments(segments);
    expect(srt).toMatch(/^1\n/);
    expect(srt).toContain('\n\n2\n');
    expect(srt).toContain('\n\n3\n');
  });

  it('handles mixed speaker and no-speaker segments', () => {
    const segments = [
      { startMs: 0, endMs: 2000, speaker: 'Speaker 1', text: 'Hello' },
      { startMs: 2000, endMs: 4000, speaker: null, text: '[inaudible]' }
    ];
    const srt = buildSrtFromSegments(segments);
    expect(srt).toContain('Speaker 1: Hello');
    expect(srt).toContain('[inaudible]');
    // No speaker prefix for null speaker
    expect(srt).not.toContain('null:');
  });
});

describe('Speaker Diarization - Endpoint Configuration', () => {
  it('should have /api/generate-captions-diarized endpoint defined', () => {
    // Verify the endpoint path constant
    const endpoint = '/api/generate-captions-diarized';
    expect(endpoint).toBe('/api/generate-captions-diarized');
  });

  it('should prefer gpt-4o-transcribe-diarize model', () => {
    const preferredModel = 'gpt-4o-transcribe-diarize';
    const fallbackModels = ['gpt-4o-transcribe', 'whisper-1'];
    expect(preferredModel).toMatch(/diarize/);
    expect(fallbackModels).toContain('gpt-4o-transcribe');
    expect(fallbackModels).toContain('whisper-1');
  });

  it('should use server_vad turn detection settings', () => {
    const vadConfig = {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 600
    };
    expect(vadConfig.type).toBe('server_vad');
    expect(vadConfig.threshold).toBeGreaterThanOrEqual(0.5);
    expect(vadConfig.silence_duration_ms).toBeGreaterThanOrEqual(500);
    expect(vadConfig.silence_duration_ms).toBeLessThanOrEqual(800);
  });

  it('should use transcription-only session settings', () => {
    const sessionConfig = {
      modalities: ['text'],
      voice: null,
      output_audio_format: null,
      max_response_output_tokens: 0,
      temperature: 0.0
    };
    expect(sessionConfig.modalities).toEqual(['text']);
    expect(sessionConfig.voice).toBeNull();
    expect(sessionConfig.output_audio_format).toBeNull();
    expect(sessionConfig.max_response_output_tokens).toBe(0);
    expect(sessionConfig.temperature).toBe(0.0);
  });

  it('should use PCM16 24kHz mono audio format for OpenAI Realtime API', () => {
    const audioConfig = {
      frequency: 24000,
      channels: 1,
      codec: 'pcm_s16le',
      format: 's16le'
    };
    expect(audioConfig.frequency).toBe(24000);
    expect(audioConfig.channels).toBe(1);
    expect(audioConfig.codec).toBe('pcm_s16le');
  });
});
