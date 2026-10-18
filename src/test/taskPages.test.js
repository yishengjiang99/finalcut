// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTaskPages, tryHref } from '../../scripts/build-task-pages.mjs';
import { pages } from '../../scripts/task-pages/pages.mjs';
import { tools } from '../tools.js';
import { readDeepLink } from '../pendingPrompt.js';

const dir = mkdtempSync(path.join(tmpdir(), 'task-pages-'));
buildTaskPages(dir);
const html = Object.fromEntries(pages.map((p) => [p.slug, readFileSync(path.join(dir, `${p.slug}.html`), 'utf8')]));
const toolNames = new Set(tools.map((t) => t.function?.name || t.name));

describe('static guide pages', () => {
  it('builds the three slugs', () => {
    expect(pages.map((p) => p.slug)).toEqual(['add-subtitles', 'translate-subtitles', 'add-lyrics-to-video']);
  });
  it('has unique titles, descriptions and canonicals; one h1 each; 150-160 char descriptions', () => {
    expect(new Set(pages.map((p) => p.title)).size).toBe(3);
    expect(new Set(pages.map((p) => p.description)).size).toBe(3);
    for (const p of pages) {
      const h = html[p.slug];
      expect(h.match(/<h1[ >]/g)).toHaveLength(1);
      expect(h).toContain(`<link rel="canonical" href="https://grepawk.com/${p.slug}">`);
      expect(h).toContain(`<meta property="og:url" content="https://grepawk.com/${p.slug}">`);
      expect(p.description.length).toBeGreaterThanOrEqual(150);
      expect(p.description.length).toBeLessThanOrEqual(160);
      expect(h).not.toMatch(/final ?cut/i);
      expect(h).not.toMatch(/nothing leaves your device/i);
    }
  });
  it('has valid FAQPage JSON-LD matching the visible FAQ', () => {
    for (const p of pages) {
      const blocks = [...html[p.slug].matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
      const faq = blocks.find((b) => b['@type'] === 'FAQPage');
      expect(faq.mainEntity.map((q) => q.name)).toEqual(p.faq.map(([q]) => q));
    }
  });
  it('links to the other guides and home, and deep-links the prompt into the editor', () => {
    for (const p of pages) {
      for (const o of pages) if (o.slug !== p.slug) expect(html[p.slug]).toContain(`href="/${o.slug}"`);
      expect(html[p.slug]).toContain('href="/"');
      const href = tryHref(p.prompt);
      expect(html[p.slug]).toContain(href.replace(/&/g, '&amp;'));
      expect(readDeepLink(href.slice(1))).toEqual({ prompt: p.prompt, start: 'signin' });
      expect(html[p.slug]).toContain(`send('page_view',p)`);
      expect(html[p.slug]).toContain(`{path:'/${p.slug}'}`);
    }
  });
  it('only names tools the app has', () => {
    expect(toolNames.has('generate_captions')).toBe(true);
    expect(toolNames.has('lyric_captions')).toBe(true);
  });
});
