// /legal/licenses.html: GPL Corresponding Source is hosted on the same origin next to the wasm,
// every same-origin link resolves, archives match the pinned checksums, and no written offer remains.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lock = JSON.parse(readFileSync(path.join(ROOT, 'vendor', 'ffmpeg-source.lock.json'), 'utf8'));
const SRC = '/v2/vendor/ffmpeg/source/';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== 'mt', 'static pages: run once');
});

async function sameOriginLinks(page, baseURL) {
  const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.href));
  const origin = new URL(baseURL).origin;
  return [...new Set(hrefs.filter((h) => h.startsWith(origin)).map((h) => h.split('#')[0]))];
}

test('licenses page: same-origin source hosting, no written offer, all links resolve', async ({ page, request, baseURL }) => {
  const resp = await page.goto('/legal/licenses.html');
  expect(resp.status()).toBe(200);
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/written offer|three years|cost of physically performing/i);
  expect(text).toMatch(/GNU General Public License, version 2 or later/);

  const links = await sameOriginLinks(page, baseURL);
  const paths = links.map((l) => new URL(l).pathname);
  // Archives, checksums, version list, build notes, license texts.
  for (const c of lock.components) expect(paths, `licenses page links ${c.file}`).toContain(`${SRC}${c.file}`);
  for (const f of ['', 'SHA256SUMS', 'versions.json', 'BUILD.txt', 'licenses/ffmpeg/COPYING.GPLv2.txt', 'licenses/x264/COPYING.txt']) {
    expect(paths).toContain(`${SRC}${f}`);
  }

  // Every same-origin link on the page resolves (HEAD; archives also checked for size).
  const broken = [];
  for (const l of links) {
    const p = new URL(l).pathname;
    if (p === '/v2/') continue; // the editor page itself is covered by v2-trim
    if (p === '/legal/privacy.html' || p.startsWith('/legal/')) {
      const r = await request.get(l);
      if (r.status() !== 200) broken.push(`${r.status()} ${p}`);
      continue;
    }
    const r = await request.head(l);
    if (r.status() !== 200) { broken.push(`${r.status()} ${p}`); continue; }
    const c = lock.components.find((x) => `${SRC}${x.file}` === p);
    if (c) expect(Number(r.headers()['content-length']), p).toBe(c.bytes);
  }
  expect(broken).toEqual([]);
});

test('source dir: SHA256SUMS matches the pinned lock, archive bytes verify, index links resolve', async ({ page, request, baseURL }) => {
  const sums = await (await request.get(`${SRC}SHA256SUMS`)).text();
  const expected = lock.components.map((c) => `${c.sha256}  ${c.file}`).join('\n') + '\n';
  expect(sums).toBe(expected);

  for (const id of ['libass', 'x264']) { // download two archives and verify the bytes
    const c = lock.components.find((x) => x.id === id);
    const body = await (await request.get(`${SRC}${c.file}`)).body();
    expect(createHash('sha256').update(body).digest('hex')).toBe(c.sha256);
  }

  const versions = await (await request.get(`${SRC}versions.json`)).json();
  expect(versions.packages['@ffmpeg/core']).toBe('0.12.10');
  expect(versions.components.map((c) => c.id)).toEqual(lock.components.map((c) => c.id));

  await page.goto(SRC);
  const links = await sameOriginLinks(page, baseURL);
  expect(links.length).toBeGreaterThan(lock.components.length);
  for (const l of links) {
    const p = new URL(l).pathname;
    const r = p.startsWith('/legal/') ? await request.get(l) : await request.head(l);
    expect(r.status(), p).toBe(200);
  }
  const gpl = await (await request.get(`${SRC}licenses/ffmpeg/COPYING.GPLv2.txt`)).text();
  expect(gpl).toMatch(/GNU GENERAL PUBLIC LICENSE\s+Version 2/);
});
