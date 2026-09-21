import { describe, it, expect } from 'vitest';
import { resolveOutputMeta, applyOperation, OpValidationError } from '../server/ffmpegOps.js';

describe('ffmpegOps meta', () => {
  it('defaults process-video output to mp4', () => {
    const meta = resolveOutputMeta('trim_video', { start: 0, end: 1 });
    expect(meta.outputExt).toBe('mp4');
    expect(meta.contentType).toBe('video/mp4');
  });

  it('resolves extract_audio content type', () => {
    const meta = resolveOutputMeta('extract_audio', { format: 'mp3' });
    expect(meta.outputExt).toBe('mp3');
    expect(meta.contentType).toBe('audio/mpeg');
  });
});

describe('ffmpegOps validation', () => {
  it('rejects unknown operations', () => {
    expect(() => applyOperation({ videoFilters() { return this; } }, 'nope', {})).toThrow(OpValidationError);
  });
});

describe('Jobs API contract', () => {
  it('documents poll statuses and resultUrl shape', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed'];
    expect(statuses).toContain('queued');
    const poll = {
      jobId: 'uuid',
      status: 'succeeded',
      progress: 1,
      resultUrl: 'https://grepawk.com/api/jobs/uuid/result',
      contentType: 'video/mp4',
    };
    expect(poll.resultUrl).toContain('/api/jobs/');
  });
});
