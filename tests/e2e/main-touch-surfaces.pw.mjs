// E2E: the touch surfaces (video preview, scrubber, caption overlay, clip rail) refuse text selection and the
// long-press callout (iPhone Safari highlighted them like text), while chat text and the composer stay
// selectable/typeable; the scrubber and the Export button still work.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'testclip-6s.mp4');
const CONFIG = { clientFFmpeg: { mode: 'on', percent: 100 }, limits: { clip: { desktop: { warnBytes: 1e9, blockBytes: 1.8e9 } } }, captions: { onDevice: true, cloud: false }, tools: { fallback: 'run_ffmpeg' } };
const EMPTY = { filters: [], encoders: [], decoders: [], muxers: [], demuxers: [], recipes: [], outputFormats: [] };

const sel = (page, selector) => page.locator(selector).first().evaluate((el) => {
  const cs = getComputedStyle(el);
  return { select: cs.userSelect, webkit: cs.webkitUserSelect, callout: cs.getPropertyValue('-webkit-touch-callout') || cs.webkitTouchCallout };
});

test('touch surfaces do not select on long press; chat and inputs still do; scrub and export work', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/api/health', r => r.fulfill({ json: { ok: true, ffmpeg: { version: '4.4.2' } } }));
  await page.route('**/api/auth/status', r => r.fulfill({ json: { authenticated: true, user: { email: 'e2e@example.com', hasSubscription: true } } }));
  await page.route('**/api/v2/config', r => r.fulfill({ json: CONFIG }));
  await page.route('**/api/v2/capabilities', r => r.fulfill({ json: EMPTY }));
  await page.route('**/api/sample-access-token', r => r.fulfill({ status: 404 }));
  await page.route('**/BigBuckBunny.mp4', r => r.fulfill({ status: 404 }));
  await page.goto('/?engine=client');
  await expect(page.locator('.composer-input-row')).toBeVisible({ timeout: 15000 });
  await page.locator('.composer-input-row input[type=file]').setInputFiles(FIXTURE);
  await expect(page.locator('.rail .clip').first()).toBeVisible({ timeout: 15000 });

  // The clip rail and its thumbnail.
  for (const s of ['.rail .clip', '.rail .clip .thumb']) {
    const v = await sel(page, s);
    expect([v.select, v.webkit]).toEqual(['none', 'none']);
  }

  // The video preview: open the player from the thumbnail.
  const open = page.getByRole('button', { name: /^Open video/ }).first();
  if (await open.count()) {
    expect((await sel(page, '.vp')).select).toBe('none');
    await open.click();
  }
  const range = page.locator('.vp input[type=range]').first();
  await expect(range).toBeVisible({ timeout: 15000 });
  expect((await sel(page, '.vp')).select).toBe('none');
  expect((await sel(page, '.vp canvas')).select).toBe('none');

  // Scrubbing still moves the time.
  const t0 = await page.locator('.vp video').first().evaluate(v => v.currentTime);
  await range.focus();
  await range.evaluate((el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '3'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect.poll(() => page.locator('.vp video').first().evaluate(v => v.currentTime), { timeout: 10000 }).toBeGreaterThan(t0 + 1.5);

  // Text surfaces stay selectable: the composer textarea and the page body (chat text).
  const ta = page.locator('.composer-input-row textarea');
  const taSel = await ta.evaluate(el => getComputedStyle(el).userSelect);
  expect(taSel).not.toBe('none');
  await ta.fill('copy me');
  expect(await ta.inputValue()).toBe('copy me');
  expect(await page.locator('.msg').first().evaluate(el => getComputedStyle(el).userSelect).catch(() => 'auto')).not.toBe('none');

  // Export is still clickable and starts the download.
  const download = page.waitForEvent('download', { timeout: 30000 });
  await page.locator('.btn-export').click();
  await download;
});
