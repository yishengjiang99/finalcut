// @vitest-environment node
// scripts/build-blog.mjs + scripts/blog/lint.mjs: opt-in only, the leak lint blocks internal details,
// static output (one h1, canonical, valid JSON-LD), RSS and the sitemap merge.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
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
    expect(() => loadPosts(fixture([['earsheet', 'x', '---\ntitle: T\npublish: true\n---\nbody\n']]))).toThrow(/"date" is required/);
  });
  it('builds the real posts: one h1, canonical, valid JSON-LD, RSS, sitemap', async () => {
    const dirs = Object.fromEntries(SOURCES.map((s) => [s.name, s.local ? ROOT : path.join(process.env.BLOG_SOURCES_DIR || path.join(ROOT, '.cache', 'blog-sources'), s.name)]));
    const out = mkdtempSync(path.join(tmpdir(), 'blog-out-'));
    writeFileSync(path.join(out, 'sitemap.xml'), readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8'));
    const r = await buildBlog({ outDir: out, dirs });
    expect(r.posts.length).toBeGreaterThanOrEqual(1);
    const slugs = readdirSync(path.join(out, 'blog'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'reference').map((d) => d.name);
    const sitemap = readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
    for (const slug of slugs) {
      const html = readFileSync(path.join(out, 'blog', slug, 'index.html'), 'utf8');
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="https://grepawk.com/blog/${slug}">`);
      const lds = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map((m) => JSON.parse(m[1]));
      expect(lds.map((o) => o['@type'])).toEqual(['BlogPosting', 'BreadcrumbList']);
      expect(html).not.toMatch(/<iframe|platform\.twitter\.com\/widgets\.js"|<script[^>]+src=/);
      for (const m of html.matchAll(/<img [^>]*>/g)) { expect(m[0]).toMatch(/ width="\d+" height="\d+"/); expect(m[0]).toMatch(/ alt="/); }
      expect(lds[0]).toMatchObject({ '@context': 'https://schema.org', mainEntityOfPage: `https://grepawk.com/blog/${slug}` });
      expect(lds[0].datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(html).not.toMatch(/final ?cut/i);
      expect(sitemap).toContain(`<loc>https://grepawk.com/blog/${slug}</loc>`);
    }
    expect(sitemap).toContain('<loc>https://grepawk.com/blog</loc>');
    expect(sitemap).toContain('<loc>https://grepawk.com/add-subtitles</loc>');
    expect(readFileSync(path.join(out, 'blog', 'rss.xml'), 'utf8')).toMatch(/<rss version="2.0"[\s\S]*<item>/);
    expect(existsSync(path.join(out, 'blog', 'sources.json'))).toBe(true);
  }, 180000);
  it('sitemap merge is idempotent', () => {
    const base = readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
    const posts = [{ slug: 'a-post', date: '2026-10-12' }];
    expect(mergeSitemap(mergeSitemap(base, posts), posts)).toBe(mergeSitemap(base, posts));
  });
});

describe('blog media', () => {
  const img = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#4060a0' } }).jpeg().toBuffer();
  async function mediaFixture(body, files) {
    const dirs = fixture([['earsheet', 'media-post', fm('publish: true\n', body)]]);
    for (const [name, buf] of Object.entries(files)) writeFileSync(path.join(dirs.earsheet, 'blog', 'media-post', name), buf);
    const out = mkdtempSync(path.join(tmpdir(), 'blog-out-'));
    return { dirs, out };
  }
  it('optimises images to AVIF/WebP/JPEG with srcset, size and lazy loading', async () => {
    const { dirs, out } = await mediaFixture('Intro.\n\n![A blue test image](a.jpg "Caption")\n\n```gallery\na.jpg | First | One\nb.jpg | Second\n```\n\n```youtube\nid: aqz-KE-bpKQ\ntitle: Test video\n```\n\n```x\nurl: https://x.com/Blender/status/2108217271717867606\n```', { 'a.jpg': await img(1400, 700), 'b.jpg': await img(600, 1200) });
    await buildBlog({ outDir: out, dirs });
    const html = readFileSync(path.join(out, 'blog', 'media-post', 'index.html'), 'utf8');
    expect(html).toMatch(/<source type="image\/avif" srcset="\/media\/blog\/a-[0-9a-f]{10}-480\.avif 480w, [^"]+1200w/);
    expect(html).toMatch(/<img src="\/media\/blog\/a-[0-9a-f]{10}-1400\.jpg"[^>]* width="1400" height="700" alt="A blue test image" loading="lazy" decoding="async">/);
    expect(html).toContain('<figcaption>Caption</figcaption>');
    expect(html).toContain('class="gallery"');
    // click-to-load: no iframe or third-party script until the click handler runs
    expect(html).toContain('data-yt="aqz-KE-bpKQ"');
    expect(html).toContain('data-x="https://twitter.com/Blender/status/2108217271717867606"');
    expect(html).not.toMatch(/<iframe|<script[^>]+src=/);
    expect(readdirSync(path.join(out, 'media', 'blog')).some((f) => f.startsWith('yt-aqz-ke-bpkq'))).toBe(true);
  }, 60000);
  it('fails on missing alt text, oversized originals and bad directives', async () => {
    let f = await mediaFixture('![](a.jpg)', { 'a.jpg': await img(400, 300) });
    await expect(buildBlog({ outDir: f.out, dirs: f.dirs })).rejects.toThrow(/needs alt text/);
    f = await mediaFixture('![Big](big.png)', { 'big.png': await sharp({ create: { width: 2000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).png().toBuffer() });
    await expect(buildBlog({ outDir: f.out, dirs: f.dirs })).rejects.toThrow(/over the 1.5 MB limit/);
    f = await mediaFixture('```video\nsrc: x.mp4\n```', {});
    await expect(buildBlog({ outDir: f.out, dirs: f.dirs })).rejects.toThrow(/video block needs src/);
    f = await mediaFixture('```youtube\nid: nope\ntitle: t\n```', {});
    await expect(buildBlog({ outDir: f.out, dirs: f.dirs })).rejects.toThrow(/youtube block needs id/);
  }, 60000);
});
