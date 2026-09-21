// Provide required server env so importing config/middleware in unit tests
// does not process.exit(1) when CI has no secrets.
if (!process.env.XAI_API_TOKEN) process.env.XAI_API_TOKEN = 'test-xai-token-not-for-prod';
if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'test-session-secret-not-for-prod';

import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mock @ffmpeg/ffmpeg
vi.mock('@ffmpeg/ffmpeg', () => ({
  FFmpeg: vi.fn().mockImplementation(() => ({
    load: vi.fn(),
    exec: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    on: vi.fn(),
    terminate: vi.fn(),
    loaded: false,
  })),
}));

// Mock @ffmpeg/util
vi.mock('@ffmpeg/util', () => ({
  toBlobURL: vi.fn((url, mimeType, useCache, progressCallback) => {
    // Simulate progress callback if provided
    if (progressCallback) {
      progressCallback({ url, received: 1000 });
    }
    return Promise.resolve(url);
  }),
  fetchFile: vi.fn(),
}));

afterEach(() => {
  cleanup();
});
