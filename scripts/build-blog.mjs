#!/usr/bin/env node
// Build https://grepawk.com/blog from opted-in Markdown in four repos (docs/blog.md):
//   <repo>/blog/<slug>/index.md with `publish: true` -> dist/blog/<slug>/index.html
// plus dist/blog/index.html, dist/blog/rss.xml, dist/blog/sources.json (for blog-sync.yml), a noindex
// formatting reference at /blog/reference, optimised media under dist/media/blog/ (scripts/blog/media.mjs)
// and the /blog URLs merged into dist/sitemap.xml (IndexNow). Static HTML and inline CSS; the only
// script besides telemetry is a click handler on pages with YouTube or X embeds.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { SITE, BLOG_URL, AUTHOR, PRODUCTS, SOURCES, PHOTO_ARTICLES_BASE } from './blog/sources.mjs';
import { parseFrontMatter } from './blog/frontmatter.mjs';
import { lintPost, titleCaseHeadings } from './blog/lint.mjs';
import { Media } from './blog/media.mjs';
import { telemetryScript } from './build-task-pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = esc;
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
const abs = (u) => (u.startsWith('http') ? u : `${SITE}${u}`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set(['reference', 'tag', 'media', 'rss', 'index']);
const DIRECTIVES = new Set(['video', 'youtube', 'x', 'gallery']);
const short = (p) => PRODUCTS[p].short || PRODUCTS[p].name;
const headingId = (text) => text.replace(/<[^>]+>/g, '').toLowerCase().replace(/&[a-z#0-9]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- styles ----------
const productVars = Object.entries(PRODUCTS).map(([k, p]) => `[data-p="${k}"]{--a:${p.accent};--a2:${p.accent2}}`).join('');
const CSS = `
:root{color-scheme:dark;--bg:#0b0e13;--bg2:#10141c;--fg:#e8edf4;--soft:#c8d1df;--muted:#9aa7bb;--card:#121823;--line:#232c3a;--line2:#1a2230;--link:#b3a9ff;--a:#8b7cf6;--a2:#5b8def;--shadow:0 10px 30px rgba(0,0,0,.35)}
@media (prefers-color-scheme:light){.hero.multi{background:radial-gradient(700px 340px at 5% -10%,rgba(139,124,246,.42),transparent 65%),radial-gradient(600px 320px at 55% -20%,rgba(255,122,89,.32),transparent 60%),radial-gradient(600px 340px at 100% 10%,rgba(45,212,191,.30),transparent 60%),var(--bg)}:root{color-scheme:light;--bg:#fbfbfd;--bg2:#f2f3f8;--fg:#131722;--soft:#2c3443;--muted:#566070;--card:#fff;--line:#dde1ea;--line2:#e8ebf1;--link:#4f3fd0;--shadow:0 10px 30px rgba(20,25,40,.10)}}
${productVars}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}
a{color:var(--link)}a:hover{text-decoration-thickness:2px}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}.wide{max-width:1080px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line2)}
.top .wrap{display:flex;align-items:center;gap:14px;min-height:56px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;color:var(--fg);text-decoration:none;font-size:18px;letter-spacing:-.01em;white-space:nowrap}
.dot{width:14px;height:14px;border-radius:5px;background:linear-gradient(135deg,#8b7cf6,#ff7a59 55%,#f5b83d)}
.brand .b{font-weight:600;color:var(--muted)}
.top nav{margin-left:auto;display:flex;gap:4px}.top nav a{font-size:15px;padding:10px 8px;color:var(--soft);text-decoration:none;white-space:nowrap}.top nav a:hover{color:var(--fg)}
@media (max-width:420px){.top nav .opt{display:none}}
.hero{position:relative;overflow:hidden;border-bottom:1px solid var(--line2);background:radial-gradient(900px 380px at 12% -10%,color-mix(in srgb,var(--a) 34%,transparent),transparent 65%),radial-gradient(700px 360px at 95% 0%,color-mix(in srgb,var(--a2) 28%,transparent),transparent 60%),var(--bg)}
.hero.multi{background:radial-gradient(700px 340px at 5% -10%,rgba(139,124,246,.38),transparent 65%),radial-gradient(600px 320px at 55% -20%,rgba(255,122,89,.26),transparent 60%),radial-gradient(600px 340px at 100% 10%,rgba(45,212,191,.22),transparent 60%),var(--bg)}
.hero .wrap{padding-top:44px;padding-bottom:36px}
.eyebrow{display:inline-block;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--soft)}
h1{font-size:clamp(30px,6.4vw,48px);line-height:1.1;letter-spacing:-.02em;margin:10px 0 14px}
.grad{background:linear-gradient(100deg,var(--fg) 30%,var(--a) 70%,var(--a2));-webkit-background-clip:text;background-clip:text;color:transparent}
.lede{color:var(--soft);font-size:clamp(17px,2.4vw,20px);margin:0;max-width:62ch}
.meta{color:var(--muted);font-size:15px;margin:16px 0 0}
.tag{display:inline-block;font-size:12.5px;font-weight:700;letter-spacing:.02em;color:#0b0e13;background:linear-gradient(135deg,var(--a),var(--a2));border-radius:999px;padding:3px 10px;text-decoration:none}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0 0;padding:0;border:0}
.filters label{cursor:pointer;font-size:14px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--soft);border-radius:999px;padding:8px 14px;min-height:40px;display:inline-flex;align-items:center;gap:8px}
.filters label i{width:9px;height:9px;border-radius:50%;background:linear-gradient(135deg,var(--a),var(--a2))}
.filters input:checked+label{border-color:var(--a);color:var(--fg);box-shadow:0 0 0 1px var(--a) inset}
.filters input:focus-visible+label{outline:2px solid var(--link);outline-offset:2px}
${Object.keys(PRODUCTS).map((k) => `main:has(#f-${k}:checked) .card:not([data-p="${k}"]){display:none}`).join('')}
.grid{display:grid;grid-template-columns:1fr;gap:20px;margin:28px 0 8px}
@media (min-width:700px){.grid{grid-template-columns:1fr 1fr}.grid .card.lead{grid-column:1/-1}.grid .card.lead .card-a{grid-template-columns:1.25fr 1fr}.grid .card.lead h3{font-size:26px}}
.card{position:relative;border-radius:18px;background:var(--card);border:1px solid var(--line);overflow:hidden;box-shadow:var(--shadow);transition:transform .25s ease,box-shadow .25s ease,border-color .25s}
.card:before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--a),var(--a2));z-index:1}
.card:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--a) 55%,var(--line))}
.card-a{display:grid;color:inherit;text-decoration:none;height:100%}
.card picture,.card img{display:block;width:100%;height:auto;aspect-ratio:1200/630;object-fit:cover;background:var(--bg2)}
.card .body{padding:16px 18px 20px}.card h3{font-size:20px;line-height:1.25;margin:10px 0 6px;letter-spacing:-.01em}
.card p{margin:0;color:var(--soft);font-size:15.5px}.card .k{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--muted);font-size:13.5px}
.card .out{color:var(--muted);font-size:13.5px;margin-top:10px}
h2.sec{font-size:22px;margin:44px 0 0;letter-spacing:-.01em}
@keyframes rise{from{transform:translateY(14px)}to{transform:none}}
.grid .card:not(.lead){animation:rise .6s cubic-bezier(.2,.7,.2,1) both}.grid .card:nth-child(2){animation-delay:.06s}.grid .card:nth-child(3){animation-delay:.12s}.grid .card:nth-child(4){animation-delay:.18s}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}.card:hover{transform:none}}
.crumbs{font-size:14px;color:var(--muted);margin:0 0 10px}.crumbs a{color:var(--muted)}
.toc{margin:28px 0 0;padding:14px 18px;border:1px solid var(--line);border-left:3px solid var(--a);border-radius:12px;background:var(--card)}
.toc p{margin:0 0 6px;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.toc ol{margin:0;padding-left:22px}.toc li::marker{color:var(--muted)}.toc li{margin:2px 0}.toc a{display:inline-block;padding:3px 0;text-decoration:none}
.prose{font-size:18px;line-height:1.75;margin-top:8px}.prose>*{max-width:68ch}
.prose h2{font-size:clamp(22px,3.4vw,27px);line-height:1.25;letter-spacing:-.01em;margin:46px 0 10px;scroll-margin-top:72px}
.prose h3{font-size:20px;margin:30px 0 6px}.prose p,.prose li{color:var(--soft)}.prose strong{color:var(--fg)}
.prose ul,.prose ol{padding-left:22px}.prose li{margin:0 0 6px}
.prose code{font:0.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:1px 5px}
.prose pre{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:14px 16px;overflow-x:auto;font-size:15px;line-height:1.55}.prose pre code{border:0;padding:0;background:none}
.prose table{border-collapse:collapse;width:100%;margin:18px 0;font-size:15.5px;display:block;overflow-x:auto}.prose th,.prose td{border-bottom:1px solid var(--line);padding:8px 12px;text-align:left}.prose th{color:var(--fg);border-bottom:2px solid var(--a)}
.prose blockquote{margin:20px 0;padding:6px 18px;border-left:3px solid var(--a);color:var(--soft);background:var(--card);border-radius:0 10px 10px 0}
figure{margin:28px 0;max-width:none}figure picture,figure img,figure video{display:block;width:100%;height:auto;border-radius:14px;border:1px solid var(--line);background:var(--bg2)}
figure.tall{max-width:340px;margin-left:auto;margin-right:auto}figcaption{color:var(--muted);font-size:14.5px;margin-top:8px;text-align:center}
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:28px 0;max-width:none!important}.gallery figure{margin:0}
.lite{position:relative;display:block;border-radius:14px;overflow:hidden;color:inherit;text-decoration:none}.lite picture,.lite img{border:0;border-radius:0}
.play{position:absolute;left:50%;top:50%;width:72px;height:50px;margin:-25px 0 0 -36px;border-radius:14px;background:rgba(0,0,0,.72);transition:background .2s}.play:after{content:"";position:absolute;left:29px;top:15px;border-style:solid;border-width:10px 0 10px 17px;border-color:transparent transparent transparent #fff}
.lite:hover .play{background:#e62117}
.yt-frame{display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:14px}
.xpost{border:1px solid var(--line);background:var(--card);padding:16px 18px}.xpost .h{font-weight:700;color:var(--fg)}.xpost .t{display:block;color:var(--soft);margin:6px 0 10px}.xpost .btn{display:inline-block;font-weight:700;font-size:14px;border-radius:999px;padding:7px 14px;background:var(--fg);color:var(--bg)}
.app{position:relative;margin:48px 0 0;padding:22px;border-radius:18px;border:1px solid var(--line);background:linear-gradient(135deg,color-mix(in srgb,var(--a) 18%,var(--card)),color-mix(in srgb,var(--a2) 12%,var(--card)))}
.app p{margin:0 0 12px;color:var(--soft)}.app strong{color:var(--fg);font-size:19px}
.cta{display:inline-block;background:linear-gradient(135deg,var(--a),var(--a2));color:#0b0e13;text-decoration:none;font-weight:800;padding:13px 20px;border-radius:12px;min-height:48px}.cta:hover{filter:brightness(1.08)}
.share{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;margin:22px 0 0;color:var(--muted);font-size:15px}.share a{display:inline-block;padding:8px 0}
.pn{display:grid;grid-template-columns:1fr;gap:12px;margin:36px 0 0}@media (min-width:640px){.pn{grid-template-columns:1fr 1fr}}
.pn a{display:block;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:var(--card);text-decoration:none;color:var(--fg)}.pn a span{display:block;font-size:13px;color:var(--muted)}.pn .next{text-align:right}
.related{margin:40px 0 0}.related .grid{margin-top:14px}
footer{border-top:1px solid var(--line2);margin-top:64px;padding:22px 0 36px;color:var(--muted);font-size:15px}footer a{display:inline-block;padding:8px 0;margin-right:18px;color:var(--soft)}
`.replace(/\n/g, '');

// ---------- markdown ----------
let ctx = null; // per-post render context: media lookups + collected headings
const md = new Marked({ gfm: true });
md.use({
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const ext = /^https?:\/\//.test(href) && !href.startsWith(SITE);
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener"' : ''}>${label}</a>`;
    },
    paragraph({ tokens }) {
      if (tokens.length === 1 && tokens[0].type === 'image') return this.parser.parseInline(tokens);
      return `<p>${this.parser.parseInline(tokens)}</p>\n`;
    },
    image({ href, text, title }) { return figure(ctx.images.get(href), text, title); },
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      const id = headingId(text);
      if (depth === 2) ctx.toc.push({ id, text: text.replace(/<[^>]+>/g, '') });
      return `<h${depth} id="${id}">${text}</h${depth}>\n`;
    },
    code({ text, lang }) {
      if (DIRECTIVES.has(lang)) return ctx.directives.get(`${lang}\n${text}`);
      return `<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(text)}</code></pre>\n`;
    },
  },
});

function picture(img, alt, sizes, { eager = false } = {}) {
  return `<picture><source type="image/avif" srcset="${img.avif}" sizes="${sizes}"><source type="image/webp" srcset="${img.webp}" sizes="${sizes}"><img src="${img.src}" srcset="${img.fallbackSet}" sizes="${sizes}" width="${img.width}" height="${img.height}" alt="${esc(alt)}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"></picture>`;
}
function figure(img, alt, caption, sizesOverride) {
  const tall = img.ratio > 1.3;
  const sizes = sizesOverride || (tall ? '(min-width: 760px) 340px, 80vw' : '(min-width: 800px) 720px, calc(100vw - 40px)');
  return `<figure${tall && !sizesOverride ? ' class="tall"' : ''}>${picture(img, alt, sizes)}${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>\n`;
}

/** `key: value` lines (video, youtube, x) or `file | alt | caption` lines (gallery). */
function parseDirective(lang, text, where) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lang === 'gallery') {
    return lines.map((l) => {
      const [file, alt, caption] = l.split('|').map((s) => s.trim());
      if (!file || !alt) throw new Error(`${where}: gallery line "${l}" needs "file | alt text | optional caption"`);
      return { file, alt, caption };
    });
  }
  const o = {};
  for (const l of lines) { const m = /^([a-z]+):\s*(.+)$/.exec(l); if (!m) throw new Error(`${where}: ${lang} block line "${l}" must be "key: value"`); o[m[1]] = m[2]; }
  return o;
}

async function resolveMedia(p, media) {
  const tokens = md.lexer(p.body);
  const images = new Map(); const directives = new Map(); const problems = []; const videos = []; let embeds = false;
  const jobs = [];
  md.walkTokens(tokens, (t) => {
    if (t.type === 'image') {
      if (!t.text?.trim()) problems.push(`image "${t.href}" needs alt text: ![what the image shows](${t.href})`);
      if (/^https?:/.test(t.href)) problems.push(`image "${t.href}": put the file in blog/${p.slug}/ instead of linking it`);
      else jobs.push(media.image(path.join(p.dir, t.href)).then((img) => images.set(t.href, img)));
    }
    if (t.type === 'code' && DIRECTIVES.has(t.lang)) {
      const key = `${t.lang}\n${t.text}`;
      let d; try { d = parseDirective(t.lang, t.text, p.where); } catch (e) { problems.push(e.message); return; }
      if (t.lang === 'gallery') {
        jobs.push(Promise.all(d.map((g) => media.image(path.join(p.dir, g.file)))).then((imgs) => directives.set(key,
          `<div class="gallery">${imgs.map((img, i) => figure(img, d[i].alt, d[i].caption, '(min-width: 760px) 230px, 45vw')).join('')}</div>\n`)));
      } else if (t.lang === 'video') {
        if (!d.src || !d.poster || !d.title) { problems.push('video block needs src (blog-media release file), poster (image in the post folder) and title'); return; }
        jobs.push(Promise.all([media.video(d.src), media.image(path.join(p.dir, d.poster)), d.webm ? media.video(d.webm) : null, d.captions ? media.captions(path.join(p.dir, d.captions)) : null]).then(([v, poster, webm, cc]) => {
          const posterUrl = poster.webp.split(', ').map((s) => s.split(' ')).find(([, w]) => parseInt(w, 10) >= 720)?.[0] || poster.webp.split(', ').at(-1).split(' ')[0];
          const tall = poster.ratio > 1.3;
          videos.push({ title: d.title, caption: d.caption, duration: d.duration, url: v.url, poster: poster.largest });
          directives.set(key, `<figure class="video${tall ? ' tall' : ''}"><video controls preload="none" playsinline poster="${posterUrl}" width="${poster.width}" height="${poster.height}" aria-label="${esc(d.title)}">${webm ? `<source src="${webm.url}" type="${webm.type}">` : ''}<source src="${v.url}" type="${v.type}">${cc ? `<track kind="captions" src="${cc.url}" srclang="${esc(d.lang || 'en')}" label="${esc(d.label || 'English')}" default>` : ''}<a href="${v.url}">Download the video</a></video>${d.caption ? `<figcaption>${esc(d.caption)}</figcaption>` : ''}</figure>\n`);
        }));
      } else if (t.lang === 'youtube') {
        if (!/^[A-Za-z0-9_-]{11}$/.test(d.id || '') || !d.title) { problems.push('youtube block needs id (11 characters) and title'); return; }
        embeds = true;
        jobs.push(media.youtubeThumb(d.id).then((img) => directives.set(key,
          `<figure><a class="lite" href="https://www.youtube.com/watch?v=${d.id}" data-yt="${d.id}" data-title="${esc(d.title)}">${picture(img, '', '(min-width: 800px) 720px, calc(100vw - 40px)')}<span class="play" aria-hidden="true"></span><span class="sr">Play video: ${esc(d.title)}</span></a><figcaption>${esc(d.caption || d.title)} (YouTube, loads when you press play)</figcaption></figure>\n`)));
      } else if (t.lang === 'x') {
        const m = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/.exec(d.url || '');
        if (!m) { problems.push('x block needs url: https://x.com/<user>/status/<id>'); return; }
        embeds = true;
        directives.set(key, `<figure><a class="lite xpost" href="https://x.com/${m[1]}/status/${m[2]}" data-x="https://twitter.com/${m[1]}/status/${m[2]}"><span class="h">Post by @${esc(m[1])} on X</span><span class="t">${esc(d.text || 'Open the post on X.')}</span><span class="btn">Load post</span></a>${d.caption ? `<figcaption>${esc(d.caption)}</figcaption>` : ''}</figure>\n`);
      }
    }
  });
  try { await Promise.all(jobs); } catch (e) { problems.push(e.message); }
  if (problems.length) throw new Error(`${p.where}: ${problems.join('; ')}`);
  return { tokens, images, directives, videos, embeds };
}

const EMBED_JS = `document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-yt],a[data-x]');if(!a)return;e.preventDefault();
if(a.dataset.yt){var f=document.createElement('iframe');f.src='https://www.youtube-nocookie.com/embed/'+a.dataset.yt+'?autoplay=1';f.title=a.dataset.title||'YouTube video';f.allow='accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';f.allowFullscreen=true;f.className='yt-frame';a.replaceWith(f);return}
var b=document.createElement('blockquote');b.className='twitter-tweet';b.setAttribute('data-dnt','true');b.setAttribute('data-theme',matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');var l=document.createElement('a');l.href=a.dataset.x;l.textContent=a.href;b.appendChild(l);a.replaceWith(b);
if(!document.getElementById('x-wjs')){var s=document.createElement('script');s.id='x-wjs';s.async=true;s.src='https://platform.twitter.com/widgets.js';document.body.appendChild(s)}else if(window.twttr&&twttr.widgets)twttr.widgets.load()});`;

// ---------- loading ----------
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
      const p = { ...data, slug: data.slug || slug, repo: s.repo, body, where, dir: path.join(base, slug) };
      const err = (m) => problems.push(`${where}: ${m}`);
      if (!SLUG.test(p.slug)) err(`slug "${p.slug}" must be lowercase-with-dashes`);
      if (RESERVED.has(p.slug)) err(`slug "${p.slug}" is reserved`);
      const warn = (m) => console.warn(`::warning title=blog SEO::${where}: ${m}`);
      if (!p.description) {
        const para = body.split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !/^(#|```|[-*|>!]|\d+\.)/.test(x)) || '';
        const plain = para.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ');
        p.description = plain.length > 155 ? `${plain.slice(0, 152).replace(/\s+\S*$/, '')}...` : plain;
        warn('missing front matter "description"; using the first paragraph'); p.descFallback = true;
      }
      if (!p.keyword) warn('missing front matter "keyword" (primary search phrase)');
      else {
        const kw = String(p.keyword).toLowerCase();
        if (!String(p.title || '').toLowerCase().includes(kw)) warn(`keyword "${p.keyword}" is not in the title`);
        if (!new RegExp(`^#{2,4} .*${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im').test(body)) warn(`keyword "${p.keyword}" is not in any heading`);
      }
      if (!p.image_alt && !p.heroAlt) warn('missing front matter "image_alt" (alt text for the share image)');
      if (p.description && p.description.length > 155) warn(`description is ${p.description.length} chars (aim for <=155)`);
      for (const k of ['title', 'description', 'date', 'product']) if (!p[k]) err(`front matter "${k}" is required`);
      if (p.date && !DATE.test(p.date)) err('date must be YYYY-MM-DD');
      if (p.updated && !DATE.test(p.updated)) err('updated must be YYYY-MM-DD');
      if (p.product && !PRODUCTS[p.product]) err(`unknown product "${p.product}" (${Object.keys(PRODUCTS).join(', ')})`);
      if (p.description && !p.descFallback && (p.description.length < 70 || p.description.length > 160)) err(`description is ${p.description.length} chars (want 70-160)`);
      if (p.canonical && !/^https:\/\//.test(p.canonical)) err('canonical must be an absolute https URL');
      if (p.hero && !p.heroAlt) err('hero needs heroAlt (what the image shows)');
      if (p.hero && !existsSync(path.join(p.dir, p.hero))) err(`hero "${p.hero}" not found in blog/${slug}/`);
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

export function loadPhotoArticles(dir) {
  const base = path.join(dir, 'articles');
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => !d.startsWith('_') && existsSync(path.join(base, d, 'article.html'))).map((d) => {
    const { data } = parseFrontMatter(readFileSync(path.join(base, d, 'article.html'), 'utf8'));
    return { ...data, slug: data.slug || d };
  }).filter((a) => a.draft !== true && a.title && a.description && DATE.test(a.date || ''))
    .map((a) => ({ title: a.title, description: a.cardSummary || a.description, date: a.date, url: `${PHOTO_ARTICLES_BASE}/${a.slug}`, slug: a.slug, product: 'protune', external: true }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- rendering ----------
const fmtDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const readingTime = (text) => Math.max(1, Math.round(text.replace(/```[\s\S]*?```/g, '').split(/\s+/).length / 220));
const PUBLISHER = { '@type': 'Organization', name: 'GrepAwk LLC', url: `${SITE}/` };

function shell({ title, description, url, type, ld, ogAlt, head = '', body, telemetry, og, robots = 'index, follow, max-image-preview:large', js = '', p = 'finalcap' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="${robots}">
<meta name="theme-color" content="#0b0e13" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#fbfbfd" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="GrepAwk blog" href="${BLOG_URL}/rss.xml">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="GrepAwk blog">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${abs(og)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(ogAlt || title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${abs(og)}">
<meta name="twitter:image:alt" content="${esc(ogAlt || title)}">
${head}<style>${CSS}</style>
${ld.map((o) => `<script type="application/ld+json">${jsonLd(o)}</script>`).join('\n')}
</head>
<body data-p="${p}">
<header class="top"><div class="wrap wide"><a class="brand" href="/blog"><span class="dot" aria-hidden="true"></span>GrepAwk <span class="b">Blog</span></a><nav aria-label="Site"><a href="/blog/rss.xml" class="opt">RSS</a><a href="/">FinalCap</a></nav></div></header>
${body}
<footer><div class="wrap wide"><a href="/blog">Blog</a><a href="/blog/rss.xml">RSS</a><a href="/">FinalCap</a><a href="https://photo.grepawk.com/">ProTune AI Camera</a><a href="https://music.grepawk.com/">AI Music Radar</a><a href="/legal/privacy.html">Privacy</a></div></footer>
<script>${telemetryScript(telemetry)}</script>${js ? `\n<script>${js}</script>` : ''}
</body>
</html>
`;
}

function card(p, { lead = false, eager = false } = {}) {
  const href = p.external ? p.url : `/blog/${p.slug}`;
  const sizes = lead ? '(min-width: 1080px) 580px, (min-width: 700px) 55vw, calc(100vw - 40px)' : '(min-width: 1080px) 520px, (min-width: 700px) 50vw, calc(100vw - 40px)';
  return `<article class="card${lead ? ' lead' : ''}" data-p="${p.product}"><a class="card-a" href="${esc(href)}">${picture(p.card, '', sizes, { eager })}<div class="body"><div class="k"><span class="tag">${esc(short(p.product))}</span><time datetime="${p.date}">${fmtDate(p.date)}</time>${p.minutes ? `<span>· ${p.minutes} min read</span>` : ''}</div><h3>${esc(p.title)}</h3><p>${esc(p.description)}</p>${p.external ? '<p class="out">On photo.grepawk.com</p>' : ''}</div></a></article>`;
}

function renderPost(p, all) {
  const url = p.canonical || `${BLOG_URL}/${p.slug}`;
  const prod = PRODUCTS[p.product];
  ctx = { images: p.media.images, directives: p.media.directives, toc: [] };
  const html = md.parser(p.media.tokens);
  const toc = ctx.toc;
  const i = all.indexOf(p);
  const newer = all[i - 1]; const older = all[i + 1];
  const related = [...all.filter((q) => q !== p && q.product === p.product), ...all.filter((q) => q !== p && q.product !== p.product)].filter((q) => q !== newer && q !== older).slice(0, 2);
  const images = [abs(p.og), ...(p.heroImg ? [abs(p.heroImg.largest)] : [])];
  const posting = {
    '@context': 'https://schema.org', '@type': 'BlogPosting',
    headline: p.title, description: p.description, url, mainEntityOfPage: url,
    datePublished: p.date, dateModified: p.updated || p.date,
    author: { '@type': 'Person', name: p.author || AUTHOR }, publisher: PUBLISHER, image: images,
    ...(p.keyword || p.tags?.length ? { keywords: [p.keyword, ...(p.tags || [])].filter(Boolean).join(', ') } : {}),
    ...(prod.url ? { about: { '@type': 'SoftwareApplication', name: prod.name, url: prod.site || prod.url, applicationCategory: { finalcap: 'MultimediaApplication', protune: 'PhotographyApplication' }[p.product] || 'MusicApplication', operatingSystem: p.product === 'finalcap' ? 'Web' : 'iOS' } } : {}),
  };
  if (p.media.videos.length) posting.video = p.media.videos.map((v) => ({ '@type': 'VideoObject', name: v.title, description: v.caption || p.description, thumbnailUrl: abs(v.poster), uploadDate: p.date, contentUrl: abs(v.url), ...(v.duration ? { duration: v.duration } : {}) }));
  const ld = [posting, { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Blog', item: BLOG_URL },
    { '@type': 'ListItem', position: 2, name: p.title, item: url },
  ] }];
  const updated = p.updated && p.updated !== p.date ? ` · Updated <time datetime="${p.updated}">${fmtDate(p.updated)}</time>` : '';
  const share = encodeURIComponent(url);
  const body = `<div class="hero" data-p="${p.product}"><div class="wrap"><p class="crumbs"><a href="/blog">Blog</a> / ${esc(short(p.product))}</p><span class="tag">${esc(short(p.product))}</span>
<h1><span class="grad">${esc(p.title)}</span></h1>
<p class="lede">${esc(p.description)}</p>
<p class="meta">By ${esc(p.author || AUTHOR)} · <time datetime="${p.date}">${fmtDate(p.date)}</time>${updated} · ${p.minutes} min read</p></div></div>
<main class="wrap">
<article>
${toc.length >= 4 ? `<nav class="toc" aria-label="On this page"><p>On this page</p><ol>${toc.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ol></nav>` : ''}
<div class="prose">
${html}</div>
${prod.url ? `<aside class="app" aria-label="${esc(prod.name)}"><p><strong>${esc(prod.name)}</strong></p><p><a class="cta" href="${esc(prod.url)}" data-cta="blog_app" data-placement="post_end">${esc(prod.cta)}</a></p></aside>` : ''}
<p class="share">Share: <a href="https://x.com/intent/post?url=${share}&amp;text=${encodeURIComponent(p.title)}" rel="noopener">X</a><a href="https://www.linkedin.com/sharing/share-offsite/?url=${share}" rel="noopener">LinkedIn</a><a href="mailto:?subject=${encodeURIComponent(p.title)}&amp;body=${share}">Email</a></p>
</article>
${newer || older ? `<nav class="pn" aria-label="More posts">${older ? `<a class="prev" href="/blog/${older.slug}"><span>Previous</span>${esc(older.title)}</a>` : '<span></span>'}${newer ? `<a class="next" href="/blog/${newer.slug}"><span>Next</span>${esc(newer.title)}</a>` : ''}</nav>` : ''}
${related.length ? `<section class="related" aria-labelledby="rel-h"><h2 class="sec" id="rel-h">Related posts</h2><div class="grid">${related.map((q) => card(q)).join('')}</div></section>` : ''}
</main>`;
  const out = shell({ title: `${p.seoTitle || p.title} | GrepAwk blog`, description: p.description, url, type: 'article', ld, body, telemetry: `blog/${p.slug}`, og: p.og, ogAlt: p.image_alt || p.heroAlt, p: p.product,
    head: `<meta property="article:published_time" content="${p.date}">\n`, js: p.media.embeds ? EMBED_JS : '' });
  if ((out.match(/<h1[ >]/g) || []).length !== 1) throw new Error(`${p.where}: expected exactly one <h1>`);
  return out;
}

function renderIndex(posts, photo, og) {
  const ld = [{
    '@context': 'https://schema.org', '@type': 'Blog', name: 'GrepAwk blog', url: BLOG_URL, publisher: PUBLISHER, image: abs(og),
    blogPost: posts.map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: `${BLOG_URL}/${p.slug}`, datePublished: p.date, image: abs(p.og), author: { '@type': 'Person', name: p.author || AUTHOR } })),
  }];
  const used = Object.keys(PRODUCTS).filter((k) => posts.some((p) => p.product === k) || photo.some((a) => a.product === k));
  const filters = `<fieldset class="filters"><legend class="sr">Filter by app</legend><input class="sr" type="radio" name="f" id="f-all" checked><label for="f-all">All apps</label>${used.map((k) => `<input class="sr" type="radio" name="f" id="f-${k}"><label for="f-${k}" data-p="${k}"><i></i>${esc(short(k))}</label>`).join('')}</fieldset>`;
  const body = `<div class="hero multi"><div class="wrap wide"><span class="eyebrow">Notes from the developer</span>
<h1><span class="grad">How the apps are built</span></h1>
<p class="lede">FinalCap, ProTune AI Camera, AI Music Radar and Music Reader: on-device AI, FFmpeg in the browser, Core ML and ONNX, and the decisions behind them.</p></div></div>
<main class="wrap wide">
${filters}
<h2 class="sr">Posts</h2>
<div class="grid">${posts.map((p, i) => card(p, { lead: i === 0, eager: i === 0 })).join('')}</div>
${photo.length ? `<h2 class="sec">ProTune articles</h2><div class="grid">${photo.map((a) => card(a)).join('')}</div>` : ''}
</main>`;
  return shell({ title: 'GrepAwk blog: how FinalCap, ProTune, AI Music Radar and Music Reader are built', description: 'How FinalCap, ProTune AI Camera, AI Music Radar and Music Reader work, written by the developer: on-device AI, FFmpeg, Core ML and ONNX.', url: BLOG_URL, type: 'website', ld, body, telemetry: 'blog', og, p: 'finalcap' });
}

function renderRss(posts) {
  const items = posts.map((p) => `<item><title>${xml(p.title)}</title><link>${BLOG_URL}/${p.slug}</link><guid isPermaLink="true">${BLOG_URL}/${p.slug}</guid><pubDate>${new Date(`${p.date}T16:00:00Z`).toUTCString()}</pubDate><description>${xml(p.description)}</description><category>${xml(PRODUCTS[p.product].name)}</category><enclosure url="${abs(p.og)}" type="image/jpeg" length="0"/></item>`).join('\n');
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

export function mergeSitemap(sitemap, posts) {
  const kept = sitemap.replace(/\s*<url><loc>https:\/\/grepawk\.com\/blog[^<]*<\/loc>.*?<\/url>/g, '');
  const latest = posts.map((p) => p.updated || p.date).sort().pop();
  const urls = [`  <url><loc>${BLOG_URL}</loc>${latest ? `<lastmod>${latest}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.7</priority></url>`,
    ...posts.filter((p) => !p.canonical).map((p) => `  <url><loc>${BLOG_URL}/${p.slug}</loc><lastmod>${p.updated || p.date}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`)];
  return kept.replace('</urlset>', `${urls.join('\n')}\n</urlset>`);
}

/** The noindex formatting reference (scripts/blog/reference/index.md) at /blog/reference. */
async function renderReference(media, outDir) {
  const dir = path.join(ROOT, 'scripts', 'blog', 'reference');
  const file = path.join(dir, 'index.md');
  if (!existsSync(file)) return;
  const { data, body } = parseFrontMatter(readFileSync(file, 'utf8'));
  const p = { ...data, slug: 'reference', product: 'finalcap', body, dir, where: 'scripts/blog/reference' };
  p.media = await resolveMedia(p, media);
  ctx = { images: p.media.images, directives: p.media.directives, toc: [] };
  const html = md.parser(p.media.tokens);
  const body2 = `<div class="hero"><div class="wrap"><span class="eyebrow">For writers and agents</span><h1><span class="grad">${esc(p.title)}</span></h1><p class="lede">${esc(p.description)}</p></div></div><main class="wrap"><div class="prose">${html}</div></main>`;
  mkdirSync(path.join(outDir, 'blog', 'reference'), { recursive: true });
  writeFileSync(path.join(outDir, 'blog', 'reference', 'index.html'), shell({ title: `${p.title} | GrepAwk blog`, description: p.description, url: `${BLOG_URL}/reference`, type: 'website', ld: [], body: body2, telemetry: 'blog/reference', og: p.og || '/og/finalcap-og-1200x630.jpg', robots: 'noindex, follow', js: p.media.embeds ? EMBED_JS : '' }));
}

export async function buildBlog({ outDir = path.join(ROOT, 'dist'), dirs } = {}) {
  const posts = loadPosts(dirs);
  const photo = loadPhotoArticles(dirs['photo-recipes']);
  const blogDir = path.join(outDir, 'blog');
  rmSync(blogDir, { recursive: true, force: true });
  rmSync(path.join(outDir, 'media', 'blog'), { recursive: true, force: true });
  mkdirSync(blogDir, { recursive: true });
  const media = new Media(outDir);
  const problems = [];
  for (const p of posts) {
    try {
      p.media = await resolveMedia(p, media);
      p.heroImg = p.hero ? await media.image(path.join(p.dir, p.hero)) : null;
      const og = await media.ogCard({ key: p.slug, title: p.title, product: PRODUCTS[p.product].name, accent: PRODUCTS[p.product].accent, accent2: PRODUCTS[p.product].accent2, hero: p.hero ? path.join(p.dir, p.hero) : null });
      p.og = og.og; p.card = og.card; p.minutes = readingTime(p.body);
      if (p.ogImage) p.og = await media.ogImage({ key: p.slug, file: path.join(p.dir, p.ogImage) });
    } catch (e) { problems.push(e.message); }
  }
  if (problems.length) throw new Error(`blog: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
  for (const a of photo) Object.assign(a, await media.ogCard({ key: `photo-${a.slug}`, title: a.title, product: 'ProTune AI Camera', accent: PRODUCTS.protune.accent, accent2: PRODUCTS.protune.accent2 }));
  const indexOg = (await media.ogCard({ key: 'index', title: 'How FinalCap, ProTune, AI Music Radar and Music Reader are built', product: 'GrepAwk blog' })).og;
  for (const p of posts) {
    mkdirSync(path.join(blogDir, p.slug), { recursive: true });
    writeFileSync(path.join(blogDir, p.slug, 'index.html'), renderPost(p, posts));
  }
  writeFileSync(path.join(blogDir, 'index.html'), renderIndex(posts, photo, indexOg));
  writeFileSync(path.join(blogDir, 'rss.xml'), renderRss(posts));
  await renderReference(media, outDir);
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
  const r = await buildBlog({ outDir: process.argv[2] ? path.resolve(process.argv[2]) : undefined, dirs });
  console.log(`blog: ${r.posts.length} post(s): ${r.posts.join(', ') || 'none'}; ${r.photo} photo article link(s)`);
}
