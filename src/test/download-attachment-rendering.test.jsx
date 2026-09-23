import { describe, it, expect } from 'vitest';
import { shouldRenderVideoPreview, isDownloadOnlyAttachment } from '../App.jsx';

describe('Download attachment rendering', () => {
  it('does not render subtitle downloads as video previews', () => {
    const message = {
      videoUrl: 'blob:https://example.test/captions',
      videoType: 'subtitle-srt',
      mimeType: 'text/plain',
    };

    expect(isDownloadOnlyAttachment(message)).toBe(true);
    expect(shouldRenderVideoPreview(message)).toBe(false);
  });

  it('still renders video and audio attachments as media previews', () => {
    expect(shouldRenderVideoPreview({
      videoUrl: 'blob:https://example.test/video',
      videoType: 'processed',
      mimeType: 'video/mp4',
    })).toBe(true);

    expect(shouldRenderVideoPreview({
      videoUrl: 'blob:https://example.test/audio',
      videoType: 'processed',
      mimeType: 'audio/mpeg',
    })).toBe(true);
  });
});
