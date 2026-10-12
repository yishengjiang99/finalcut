#!/usr/bin/env node
// Build https://grepawk.com/blog from opted-in Markdown in four repos (docs/blog.md):
//   <repo>/blog/<slug>/index.md with `publish: true` front matter -> dist/blog/<slug>/index.html
// plus dist/blog/index.html (posts + link-out cards for photo.grepawk.com/articles), dist/blog/rss.xml,
// dist/blog/sources.json (build time, for .github/workflows/blog-sync.yml) and the /blog URLs merged
// into dist/sitemap.xml (which the deploy's IndexNow step submits). Static HTML, inline CSS, no
// bundle. Every post passes the leak/style lint (scripts/blog/lint.mjs) or the build fails.
// Sibling repos come from scripts/fetch-blog-sources.mjs (or BLOG_SOURCES_DIR for tests).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { SITE, BLOG_URL, AUTHOR, PRODUCTS, SOURCES, PHOTO_ARTICLES_BASE } from './blog/sources.mjs';
import { parseFrontMatter } from './blog/frontmatter.mjs';
import { lintPost, titleCaseHeadings } from './blog/lint.mjs';
import { CSS as BASE_CSS, telemetryScript } from './build-task-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OG_IMAGE = `${SITE}/og/finalcap-og-1200x630.jpg`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = esc;
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CSS = BASE_CSS + `
article h2{font-size:22px}article p,article li{color:#d5dce7}article ul,article ol{padding-left:22px}article li{margin:0 0 6px}
article code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:#121823;border:1px solid #232c3a;border-radius:6px;padding:1px 5px}
article pre{background:#121823;border:1px solid #232c3a;border-radius:10px;padding:12px 14px;overflow-x:auto}article pre code{border:0;padding:0;background:none}
article table{border-collapse:collapse;width:100%;margin:12px 0;font-size:15px;display:block;overflow-x:auto}article th,article td{border:1px solid #232c3a;padding:6px 10px;text-align:left}
article blockquote{margin:16px 0;padding:4px 16px;border-left:3px solid #6a5ae0;color:#c8d1df}
.meta{color:#9aa7bb;font-size:15px;margin:0 0 20px}.crumbs{font-size:15px;color:#9aa7bb;margin:0 0 8px}.crumbs a{display:inline-block;padding:6px 0}
.app{background:#121823;border:1px solid #232c3a;border-radius:14px;padding:16px 20px;margin:36px 0 0}.app p{margin:0 0 10px}
.cards{list-style:none;padding:0;margin:0}.cards li{border-bottom:1px solid #1a2230;padding:18px 0}.cards h3{font-size:20px;margin:0 0 6px}
.cards h3 a{color:#e8edf4;text-decoration:none}.cards h3 a:hover{color:#c9c2ff}.cards p{margin:0 0 4px;color:#c8d1df}
.tag{display:inline-block;font-size:13px;color:#9aa7bb;border:1px solid #232c3a;border-radius:999px;padding:2px 10px;margin:0 6px 0 0}
`.replace(/\n/g, '');

// Raw HTML in Markdown is escaped, never passed through; links get rel=noopener off-site.
const md = new Marked({ gfm: true });
md.use({
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const ext = /^https?:\/\//.test(href) && !href.startsWith(SITE);
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener"' : ''}>${label}</a>`;
    },
    image() { throw new Error('images are not supported in blog posts yet'); },
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = text.replace(/<[^>]+>/g, '').toLowerCase().replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
  },
});

/** Read, validate and lint every opted-in post. Throws with all problems listed. */
export function loadPosts(dirs) {
  const posts = []; const problems = [];
  for (const s of SOURCES) {
    const base = path.join(dirs[s.name], 'blog');
    if (!existsSync(base)) continue;
    for (const slug of readdirSync(base).sort()) {
      const file = path.join(base, slug, 'index.md');
      if (slug.startsWith('_') || !existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
      const { data, body } = parseFrontMatter(raw);
      if (data.publish !== true || data.draft === true) continue; // opt-in only
      const where = `${s.repo}/blog/${slug}`;
      const p = { ...data, slug: data.slug || slug, repo: s.repo, body, where };
      const err = (m) => problems.push(`${where}: ${m}`);
      if (!SLUG.test(p.slug)) err(`slug "${p.slug}" must be lowercase-with-dashes`);
      for (const k of ['title', 'description', 'date', 'product']) if (!p[k]) err(`front matter "${k}" is required`);
      if (p.date && !DATE.test(p.date)) err('date must be YYYY-MM-DD');
      if (p.updated && !DATE.test(p.updated)) err('updated must be YYYY-MM-DD');
      if (p.product && !PRODUCTS[p.product]) err(`unknown product "${p.product}" (${Object.keys(PRODUCTS).join(', ')})`);
      if (p.description && (p.description.length < 70 || p.description.length > 160)) err(`description is ${p.description.length} chars (want 70-160)`);
      if (p.canonical && !/^https:\/\//.test(p.canonical)) err('canonical must be an absolute https URL');
      for (const f of [...lintPost(raw), ...titleCaseHeadings(body, p.properNouns || [])]) err(f);
      if (/^#\s/m.test(body)) err('no "# " heading in the body; the title is the h1');
      posts.push(p);
    }
  }
  const seen = new Map();
  for (const p of posts) { if (seen.has(p.slug)) problems.push(`duplicate slug "${p.slug}": ${seen.get(p.slug)} and ${p.where}`); seen.set(p.slug, p.where); }
  if (problems.length) throw new Error(`blog: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  return posts.sort((a, b) => (b.date + b.slug).localeCompare(a.date + a.slug));
}

/** photo-recipes articles/<slug>/article.html front matter -> link-out cards (canonical stays there). */
export function loadPhotoArticles(dir) {
  const base = path.join(dir, 'articles');
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => !d.startsWith('_') && existsSync(path.join(base, d, 'article.html'))).map((d) => {
    const { data } = parseFrontMatter(readFileSync(path.join(base, d, 'article.html'), 'utf8'));
    return { ...data, slug: data.slug || d };
  }).filter((a) => a.draft !== true && a.title && a.description && DATE.test(a.date || ''))
    .map((a) => ({ title: a.title, description: a.description, date: a.date, url: `${PHOTO_ARTICLES_BASE}/${a.slug}` }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const readingTime = (text) => Math.max(1, Math.round(text.split(/\s+/).length / 220));

function shell({ title, description, url, type, ld, body, telemetry }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#0b0e13">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="GrepAwk blog" href="${BLOG_URL}/rss.xml">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="GrepAwk blog">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<style>${CSS}</style>
${ld.map((o) => `<script type="application/ld+json">${jsonLd(o)}</script>`).join('\n')}
</head>
<body>
<header><div class="wrap"><a class="brand" href="/blog">GrepAwk blog<span>notes from building the apps</span></a><nav aria-label="Site"><a href="/">FinalCap</a></nav></div></header>
<main class="wrap">
${body}
</main>
<footer><div class="wrap"><a href="/blog">Blog</a><a href="/blog/rss.xml">RSS</a><a href="/">FinalCap</a><a href="https://photo.grepawk.com/">ProTune AI Camera</a><a href="https://music.grepawk.com/">AI Music Radar</a><a href="/legal/privacy.html">Privacy</a></div></footer>
<script>${telemetryScript(telemetry)}</script>
</body>
</html>
`;
}

const PUBLISHER = { '@type': 'Organization', name: 'GrepAwk LLC', url: `${SITE}/` };

function renderPost(p) {
  const url = p.canonical || `${BLOG_URL}/${p.slug}`;
  const prod = PRODUCTS[p.product];
  const html = md.parse(p.body);
  const ld = [{
    '@context': 'https://schema.org', '@type': 'BlogPosting',
    headline: p.title, description: p.description, url, mainEntityOfPage: url,
    datePublished: p.date, dateModified: p.updated || p.date,
    author: { '@type': 'Person', name: p.author || AUTHOR }, publisher: PUBLISHER, image: OG_IMAGE,
    ...(p.tags?.length ? { keywords: p.tags.join(', ') } : {}),
    about: { '@type': 'SoftwareApplication', name: prod.name, url: prod.site || prod.url, applicationCategory: p.product === 'finalcap' ? 'MultimediaApplication' : 'MusicApplication', ...(p.product === 'finalcap' ? { operatingSystem: 'Web' } : { operatingSystem: 'iOS' }) },
  }, {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Blog', item: BLOG_URL },
      { '@type': 'ListItem', position: 2, name: p.title, item: url },
    ],
  }];
  if (p.product === 'protune') ld[0].about.applicationCategory = 'PhotographyApplication';
  const updated = p.updated && p.updated !== p.date ? `, updated <time datetime="${p.updated}">${fmtDate(p.updated)}</time>` : '';
  const body = `<p class="crumbs"><a href="/blog">Blog</a> / ${esc(prod.name)}</p>
<article>
<h1>${esc(p.title)}</h1>
<p class="meta">${esc(p.author || AUTHOR)} · <time datetime="${p.date}">${fmtDate(p.date)}</time>${updated} · ${readingTime(p.body)} min read</p>
${html}
<aside class="app"><p><strong>${esc(prod.name)}</strong></p><p><a class="cta" href="${esc(prod.url)}" data-cta="blog_app" data-placement="post_end">${esc(prod.cta)}</a></p></aside>
</article>`;
  const out = shell({ title: `${p.seoTitle || p.title} | GrepAwk blog`, description: p.description, url, type: 'article', ld, body, telemetry: `blog/${p.slug}` });
  if ((out.match(/<h1[ >]/g) || []).length !== 1) throw new Error(`${p.where}: expected exactly one <h1>`);
  return out;
}

function renderIndex(posts, photo) {
  const ld = [{
    '@context': 'https://schema.org', '@type': 'Blog', name: 'GrepAwk blog', url: BLOG_URL, publisher: PUBLISHER,
    blogPost: posts.map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: `${BLOG_URL}/${p.slug}`, datePublished: p.date, author: { '@type': 'Person', name: p.author || AUTHOR } })),
  }];
  const card = (p) => `<li><h3><a href="/blog/${p.slug}">${esc(p.title)}</a></h3><p>${esc(p.description)}</p><p class="note"><span class="tag">${esc(PRODUCTS[p.product].name)}</span><time datetime="${p.date}">${fmtDate(p.date)}</time></p></li>`;
  const ext = (a) => `<li><h3><a href="${esc(a.url)}">${esc(a.title)}</a></h3><p>${esc(a.description)}</p><p class="note"><span class="tag">ProTune AI Camera</span>on photo.grepawk.com · <time datetime="${a.date}">${fmtDate(a.date)}</time></p></li>`;
  const body = `<h1>GrepAwk blog</h1>
<p class="lede">Notes from building FinalCap, ProTune AI Camera, AI Music Radar and Music Reader: how the apps work and the decisions behind them.</p>
<h2>Posts</h2>
<ul class="cards">${posts.map(card).join('')}</ul>
${photo.length ? `<h2>ProTune articles</h2>\n<ul class="cards">${photo.map(ext).join('')}</ul>` : ''}`;
  return shell({ title: 'GrepAwk blog: notes from building FinalCap, ProTune, AI Music Radar and Music Reader', description: 'How FinalCap, ProTune AI Camera, AI Music Radar and Music Reader work, written by the developer: on-device AI, FFmpeg, Core ML and ONNX.', url: BLOG_URL, type: 'website', ld, body, telemetry: 'blog' });
}

function renderRss(posts) {
  const items = posts.map((p) => `<item><title>${xml(p.title)}</title><link>${BLOG_URL}/${p.slug}</link><guid isPermaLink="true">${BLOG_URL}/${p.slug}</guid><pubDate>${new Date(`${p.date}T16:00:00Z`).toUTCString()}</pubDate><description>${xml(p.description)}</description><category>${xml(PRODUCTS[p.product].name)}</category></item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>GrepAwk blog</title>
<link>${BLOG_URL}</link>
<atom:link href="${BLOG_URL}/rss.xml" rel="self" type="application/rss+xml"/>
<description>Notes from building FinalCap, ProTune AI Camera, AI Music Radar and Music Reader.</description>
<language>en-us</language>
${posts[0] ? `<lastBuildDate>${new Date(`${posts.map((p) => p.updated || p.date).sort().pop()}T16:00:00Z`).toUTCString()}</lastBuildDate>` : ''}
${items}
</channel>
</rss>
`;
}

/** dist/sitemap.xml (a copy of public/sitemap.xml) + /blog and every post. */
export function mergeSitemap(sitemap, posts) {
  const kept = sitemap.replace(/\s*<url><loc>https:\/\/grepawk\.com\/blog[^<]*<\/loc>.*?<\/url>/g, '');
  const latest = posts.map((p) => p.updated || p.date).sort().pop();
  const urls = [`  <url><loc>${BLOG_URL}</loc>${latest ? `<lastmod>${latest}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.7</priority></url>`,
    ...posts.filter((p) => !p.canonical).map((p) => `  <url><loc>${BLOG_URL}/${p.slug}</loc><lastmod>${p.updated || p.date}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`)];
  return kept.replace('</urlset>', `${urls.join('\n')}\n</urlset>`);
}

export function buildBlog({ outDir = path.join(ROOT, 'dist'), dirs } = {}) {
  const posts = loadPosts(dirs);
  const photo = loadPhotoArticles(dirs['photo-recipes']);
  const blogDir = path.join(outDir, 'blog');
  rmSync(blogDir, { recursive: true, force: true });
  mkdirSync(blogDir, { recursive: true });
  for (const p of posts) {
    mkdirSync(path.join(blogDir, p.slug), { recursive: true });
    writeFileSync(path.join(blogDir, p.slug, 'index.html'), renderPost(p));
  }
  writeFileSync(path.join(blogDir, 'index.html'), renderIndex(posts, photo));
  writeFileSync(path.join(blogDir, 'rss.xml'), renderRss(posts));
  writeFileSync(path.join(blogDir, 'sources.json'), JSON.stringify({ builtAt: new Date().toISOString(), posts: posts.map((p) => ({ slug: p.slug, repo: p.repo })) }, null, 2));
  const sm = path.join(outDir, 'sitemap.xml');
  const base = existsSync(sm) ? readFileSync(sm, 'utf8') : readFileSync(path.join(ROOT, 'public', 'sitemap.xml'), 'utf8');
  writeFileSync(sm, mergeSitemap(base, posts));
  return { posts: posts.map((p) => `${p.slug} (${p.repo})`), photo: photo.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let dirs;
  if (process.env.BLOG_SOURCES_DIR) {
    const d = path.resolve(process.env.BLOG_SOURCES_DIR);
    dirs = Object.fromEntries(SOURCES.map((s) => [s.name, s.local ? ROOT : path.join(d, s.name)]));
  } else {
    const { fetchBlogSources, CACHE } = await import('./fetch-blog-sources.mjs');
    fetchBlogSources();
    dirs = Object.fromEntries(SOURCES.map((s) => [s.name, s.local ? ROOT : path.join(CACHE, s.name)]));
  }
  const r = buildBlog({ outDir: process.argv[2] ? path.resolve(process.argv[2]) : undefined, dirs });
  console.log(`blog: ${r.posts.length} post(s): ${r.posts.join(', ') || 'none'}; ${r.photo} photo article link(s)`);
}
