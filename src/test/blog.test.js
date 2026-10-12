// @vitest-environment node
// scripts/build-blog.mjs + scripts/blog/lint.mjs: opt-in only, the leak lint blocks internal details,
// static output (one h1, canonical, valid JSON-LD), RSS and the sitemap merge.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildBlog, loadPosts, mergeSitemap } from '../../scripts/build-blog.mjs';
import { lintPost, titleCaseHeadings } from '../../scripts/blog/lint.mjs';
import { SOURCES } from '../../scripts/blog/sources.mjs';

const ROOT = path.resolve(__dirname, '../..');
const fm = (extra = '', body = 'A plain paragraph about the app.\n\n## How it works\n\nIt works.') =>
  `---\ntitle: A test post about the app\ndescription: A description that is long enough for the blog check, between seventy and one hundred sixty characters.\ndate: 2026-10-12\nproduct: finalcap\n${extra}---\n${body}\n`;

function fixture(posts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'blog-src-'));
  const dirs = {};
  for (const s of SOURCES) { dirs[s.name] = path.join(dir, s.name); mkdirSync(dirs[s.name], { recursive: true }); }
  for (const [repo, slug, text] of posts) {
    mkdirSync(path.join(dirs[repo], 'blog', slug), { recursive: true });
    writeFileSync(path.join(dirs[repo], 'blog', slug, 'index.md'), text);
  }
  // an internal doc next to the blog folder: must never be read
  mkdirSync(path.join(dirs.earsheet, 'docs'), { recursive: true });
  writeFileSync(path.join(dirs.earsheet, 'docs', 'secret.md'), fm('publish: true\n'));
  return dirs;
}

describe('blog leak lint', () => {
  const leaks = {
    'IPv4 address': 'The server is at 10.1.2.3 today.',
    'ssh target': 'Run ssh root@example.com to look.',
    'GitHub secret reference': 'It reads ${{ secrets.DEPLOY_SSH_KEY }}.',
    'token-like string': 'key ghp_abcdefghijklmnopqrstuvwxyz0123',
    'secret variable name': 'Set XAI_API_KEY first.',
    'API endpoint path': 'The app calls /api/v2/chat for each turn.',
    'App Store Connect detail': 'Then upload it to TestFlight.',
    'server path': 'Files live in /etc/nginx/snippets.',
    'em dash': 'Fast \u2014 and small.',
    'Final Cut': 'Unlike Final Cut, it runs in a browser.',
    'AI vocabulary': 'We delve into the pipeline.',
  };
  for (const [name, text] of Object.entries(leaks)) {
    it(`flags ${name}`, () => { expect(lintPost(text).length).toBeGreaterThan(0); });
  }
  it('passes clean copy and App Store URLs', () => {
    expect(lintPost('Get it on the App Store: https://apps.apple.com/us/app/protune-ai-camera/id6813991381 today. ONNX Runtime 1.24.2 is fine.')).toEqual([]);
  });
  it('flags Title Case headings but not proper nouns', () => {
    expect(titleCaseHeadings('## How We Built The Encoder')).toHaveLength(1);
    expect(titleCaseHeadings('## Why the app draws its own staff')).toEqual([]);
    expect(titleCaseHeadings('## Two ways to run Core ML', ['Core'])).toEqual([]);
  });
  it('fails the build on a leaking post, naming the repo and slug', () => {
    const dirs = fixture([['earsheet', 'leaky', fm('publish: true\n', 'Deploy with ssh root@host.example and the DEPLOY_SSH_KEY secret.')]]);
    expect(() => loadPosts(dirs)).toThrow(/yishengjiang99\/earsheet\/blog\/leaky: ssh target/);
  });
});

describe('blog build', () => {
  it('publishes only blog/<slug>/index.md with publish: true (never docs/, drafts or unflagged posts)', () => {
    const dirs = fixture([
      ['earsheet', 'yes-post', fm('publish: true\n')],
      ['omr-sheet-cam', 'no-flag', fm('')],
      ['photo-recipes', 'draft-post', fm('publish: true\ndraft: true\n')],
    ]);
    expect(loadPosts(dirs).map((p) => p.slug)).toEqual(['yes-post']);
  });
  it('rejects duplicate slugs and missing fields', () => {
    expect(() => loadPosts(fixture([['earsheet', 'same', fm('publish: true\n')], ['omr-sheet-cam', 'same', fm('publish: true\n')]]))).toThrow(/duplicate slug/);
    expect(() => loadPosts(fixture([['earsheet', 'x', '---\ntitle: T\npublish: true\n---\nbody\n']]))).toThrow(/"description" is required/);
  });
  it('builds the real posts: one h1, canonical, valid JSON-LD, RSS, sitemap', () => {
    const dirs = Object.fromEntries(SOURCES.map((s) => [s.name, s.local ? ROOT : path.join(process.env.BLOG_SOURCES_DIR || path.join(ROOT, '.cache', 'blog-sources'), s.name)]));
    const out = mkdtempSync(path.join(tmpdir(), 'blog-out-'));
    writeFileSync(path.join(out, 'sitemap.xml'), readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8'));
    const r = buildBlog({ outDir: out, dirs });
    expect(r.posts.length).toBeGreaterThanOrEqual(1);
    const slugs = readdirSync(path.join(out, 'blog'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const sitemap = readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
    for (const slug of slugs) {
      const html = readFileSync(path.join(out, 'blog', slug, 'index.html'), 'utf8');
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="https://grepawk.com/blog/${slug}">`);
      const lds = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
      expect(lds.map((o) => o['@type'])).toEqual(['BlogPosting', 'BreadcrumbList']);
      expect(lds[0]).toMatchObject({ '@context': 'https://schema.org', mainEntityOfPage: `https://grepawk.com/blog/${slug}` });
      expect(lds[0].datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(html).not.toMatch(/final ?cut/i);
      expect(sitemap).toContain(`<loc>https://grepawk.com/blog/${slug}</loc>`);
    }
    expect(sitemap).toContain('<loc>https://grepawk.com/blog</loc>');
    expect(sitemap).toContain('<loc>https://grepawk.com/add-subtitles</loc>');
    expect(readFileSync(path.join(out, 'blog', 'rss.xml'), 'utf8')).toMatch(/<rss version="2.0"[\s\S]*<item>/);
    expect(existsSync(path.join(out, 'blog', 'sources.json'))).toBe(true);
  });
  it('sitemap merge is idempotent', () => {
    const base = readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
    const posts = [{ slug: 'a-post', date: '2026-10-12' }];
    expect(mergeSitemap(mergeSitemap(base, posts), posts)).toBe(mergeSitemap(base, posts));
  });
});
