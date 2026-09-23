import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

const fixtureDir = path.resolve('src/test/fixtures');
const speechMp4 = readFileSync(path.join(fixtureDir, 'elevenlabs-caption-test.mp4'));
const speechText = readFileSync(path.join(fixtureDir, 'elevenlabs-caption-test.txt'), 'utf8');

test.describe('live captioning with real generated video', () => {
  test.skip(process.env.FINALCUT_LIVE_E2E !== '1', 'Set FINALCUT_LIVE_E2E=1 to run live captioning E2E.');

  test('generates captions and burns them into an MP4', async ({ request }) => {
    const tokenRes = await request.get('/api/sample-access-token');
    expect(tokenRes.ok()).toBeTruthy();
    const { token } = await tokenRes.json();
    expect(token).toBeTruthy();

    const genRes = await request.post('/api/generate-captions', {
      headers: {
        'sample-access-token': token,
        'Content-Type': 'video/mp4',
        'x-args': JSON.stringify({ language: 'en' }),
      },
      data: speechMp4,
    });
    expect(genRes.status(), await genRes.text()).toBe(200);
    const gen = await genRes.json();
    expect(gen.srt).toContain('-->');
    expect(gen.vtt).toMatch(/^WEBVTT/);
    expect(gen.srt.toLowerCase()).toContain('caption');
    expect(gen.srt.toLowerCase()).toContain('video editing');
    expect(speechText.toLowerCase()).toContain('caption test');

    const burnRes = await request.post('/api/process-video', {
      headers: {
        'sample-access-token': token,
      },
      multipart: {
        video: {
          name: 'elevenlabs-caption-test.mp4',
          mimeType: 'video/mp4',
          buffer: speechMp4,
        },
        operation: 'burn_subtitles',
        args: JSON.stringify({
          srtContent: gen.srt,
          style: 'default',
          position: 'bottom',
        }),
      },
    });

    expect(burnRes.status(), await burnRes.text()).toBe(200);
    expect(burnRes.headers()['content-type'] || '').toMatch(/video\/mp4|octet-stream/i);
    const burned = await burnRes.body();
    expect(burned.byteLength).toBeGreaterThan(10_000);

    if (process.env.FINALCUT_PLAYWRIGHT_BURNED_OUT) {
      writeFileSync(process.env.FINALCUT_PLAYWRIGHT_BURNED_OUT, burned);
    }
  });
});
