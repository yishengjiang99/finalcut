// @vitest-environment node
// Unused files removed in the cleanup; nothing imports or serves them. Keep them out of public/ (served as-is).
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

const GONE = ['public/ffmpeg.wasm', 'public/ffmpeg.js', 'public/canvas-subtitles-demo.html', 'public/_headers', 'logo.jpeg', 'deploy.sh', 'assets/app-store/screenshots'];

describe('removed dead files', () => {
  for (const f of GONE) it(`${f} is gone`, () => expect(existsSync(new URL(`../../${f}`, import.meta.url))).toBe(false));
});
