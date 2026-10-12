#!/usr/bin/env node
// Build the static SEO task pages (/add-subtitles, /translate-subtitles, /add-lyrics-to-video) into
// dist/<slug>.html. Part of `npm run build` (after the landing pre-render). Plain HTML + inline CSS,
// no React and no bundle: the pages render instantly and stay out of the app's JS.
// nginx serves them at the clean URL (nginx/finalcut-site.conf, `location = /<slug>`).
// Content and claims: scripts/task-pages/pages.mjs. Telemetry: one `page_view` {path:'/<slug>'}
// and `cta_click` {cta, source:<slug>, placement} to /api/telemetry, same anonymous ids and GPC/DNT
// opt-out as src/telemetry.js.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pages, SITE } from './task-pages/pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'dist');
const OG_IMAGE = `${SITE}/og/finalcap-og-1200x630.jpg`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
export const tryHref = (prompt) => `/?prompt=${encodeURIComponent(prompt)}&start=signin`;

export const CSS = `
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:#0b0e13;color:#e8edf4;font:17px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}
a{color:#a99ffb}a:hover{color:#c9c2ff}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}
header{border-bottom:1px solid #1a2230}header .wrap{display:flex;align-items:center;gap:16px;min-height:56px}
.brand{font-weight:700;color:#e8edf4;text-decoration:none;font-size:18px}.brand span{color:#9aa7bb;font-weight:400;font-size:14px;margin-left:6px}
header nav{margin-left:auto}header nav a{font-size:15px}
main{padding:32px 0 8px}
h1{font-size:clamp(28px,6vw,40px);line-height:1.15;margin:0 0 16px;letter-spacing:-.01em}
h2{font-size:24px;line-height:1.25;margin:40px 0 12px}h3{font-size:18px;margin:0 0 4px}
.lede{color:#c8d1df;font-size:18px}
.cta-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:22px 0 6px}
.cta{display:inline-block;background:#6a5ae0;color:#fff;text-decoration:none;font-weight:600;padding:13px 20px;border-radius:12px;min-height:48px}
.cta:hover{background:#5a4bd0;color:#fff}
.sec{display:inline-block;padding:12px 4px;min-height:48px}
.note{color:#9aa7bb;font-size:15px;margin:6px 0 0}
ol.steps{list-style:none;padding:0;margin:0;counter-reset:s}
ol.steps>li{counter-increment:s;position:relative;padding:0 0 18px 48px}
ol.steps>li:before{content:counter(s);position:absolute;left:0;top:0;width:32px;height:32px;border-radius:50%;background:#1a2230;border:1px solid #232c3a;text-align:center;line-height:30px;font-weight:700}
ol.steps p{margin:0 0 6px;color:#c8d1df}
.prompts{list-style:none;padding:0;margin:8px 0 0}
.prompts li{background:#121823;border:1px solid #232c3a;border-radius:10px;padding:8px 12px;margin:0 0 8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:15px}
ul.list{padding-left:20px;color:#c8d1df}ul.list li{margin:0 0 6px}
.privacy{background:#121823;border:1px solid #232c3a;border-radius:14px;padding:4px 20px 8px;margin-top:40px}
.privacy h2{margin-top:16px}
details{border-bottom:1px solid #1a2230;padding:12px 0}summary{cursor:pointer;font-weight:600;min-height:24px}
details p{margin:8px 0 0;color:#c8d1df}
.guides{list-style:none;padding:0;margin:0}.guides li{margin:0 0 4px}.guides a{display:inline-block;padding:8px 0}
footer{border-top:1px solid #1a2230;margin-top:48px;padding:20px 0 32px;color:#9aa7bb;font-size:15px}
footer a{display:inline-block;padding:8px 0;margin-right:16px}
`.replace(/\n/g, '');

export function telemetryScript(slug) {
  // Mirrors src/telemetry.js (ids, endpoint, GPC/DNT); props are limited to the server allowlist.
  return `(function(){try{var n=navigator,w=window;if(n.globalPrivacyControl===true||n.doNotTrack==='1'||w.doNotTrack==='1')return;
function id(){try{return crypto.randomUUID()}catch(e){return 'id-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12)}}
var pid=id();function st(s,k){try{var v=s.getItem(k);if(!v||!/^[A-Za-z0-9-]{8,64}$/.test(v)){v=id();s.setItem(k,v)}return v}catch(e){return pid}}
function send(ev,p){try{var b=JSON.stringify({event:ev,platform:'web',anon_id:st(w.localStorage,'finalcap.telemetry.install'),session_id:st(w.sessionStorage,'finalcap.telemetry.session'),props:p});
if(n.sendBeacon&&n.sendBeacon('/api/telemetry',new Blob([b],{type:'application/json'})))return;
fetch('/api/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:b,keepalive:true,credentials:'omit'}).catch(function(){})}catch(e){}}
var p={path:'/${slug}'};try{if(document.referrer){var h=new URL(document.referrer).hostname.toLowerCase();if(h&&h!==location.hostname)p.ref=h.slice(0,64)}}catch(e){}
try{var q=new URLSearchParams(location.search);['utm_source','utm_medium','utm_campaign'].forEach(function(k){var v=q.get(k);if(v&&/^[A-Za-z0-9_.:\\-\\/+ ]{1,64}$/.test(v))p[k]=v})}catch(e){}
send('page_view',p);
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[data-cta]');if(a)send('cta_click',{cta:a.getAttribute('data-cta'),source:'${slug}',placement:a.getAttribute('data-placement')||'body'})});
}catch(e){}})();`;
}

function renderPage(page) {
  const url = `${SITE}/${page.slug}`;
  const others = pages.filter((p) => p.slug !== page.slug);
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: page.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  const crumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'FinalCap', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: page.nav, item: url },
    ],
  };
  const cta = (placement) => `<div class="cta-row"><a class="cta" href="${esc(tryHref(page.prompt))}" data-cta="task_try" data-placement="${placement}" rel="nofollow">Try it in FinalCap</a><a class="sec" href="/?start=sample" data-cta="task_sample" data-placement="${placement}" rel="nofollow">Try the sample video (no sign-in)</a></div>`;
  const steps = page.steps.map(([name, text, prompts]) => `<li><h3>${esc(name)}</h3><p>${esc(text)}</p>${prompts ? `<ul class="prompts">${prompts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="theme-color" content="#0b0e13">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="FinalCap">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="FinalCap, a chat-to-edit AI video editor">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(page.title)}">
<meta name="twitter:description" content="${esc(page.description)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<style>${CSS}</style>
<script type="application/ld+json">${jsonLd(faqLd)}</script>
<script type="application/ld+json">${jsonLd(crumbLd)}</script>
</head>
<body>
<header><div class="wrap"><a class="brand" href="/">FinalCap<span>chat-to-edit AI video editor</span></a><nav aria-label="Guides"><a href="/#features">Features</a></nav></div></header>
<main class="wrap">
<h1>${esc(page.h1)}</h1>
<p class="lede">${esc(page.lede)}</p>
${cta('top')}
<p class="note">Opens FinalCap with "${esc(page.prompt)}" ready in the chat box. ${esc(page.signinNote)}</p>
<h2>How to do it in 3 steps</h2>
<ol class="steps">${steps}</ol>
<h2>What you can control</h2>
<ul class="list">${page.options.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
<section class="privacy" aria-labelledby="privacy-h"><h2 id="privacy-h">What runs on your device, and what goes to our server</h2>
<ul class="list">${page.privacy.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
<p class="note">Details: <a href="/legal/privacy.html">FinalCap privacy policy</a>.</p></section>
<h2>FAQ</h2>
${page.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n')}
<h2>Try it on your video</h2>
${cta('bottom')}
<h2>More FinalCap guides</h2>
<ul class="guides">${others.map((p) => `<li><a href="/${p.slug}">${esc(p.nav)}</a></li>`).join('')}<li><a href="/">FinalCap home: edit any video by chat</a></li></ul>
</main>
<footer><div class="wrap"><a href="/">FinalCap</a>${pages.map((p) => `<a href="/${p.slug}"${p.slug === page.slug ? ' aria-current="page"' : ''}>${esc(p.nav)}</a>`).join('')}<a href="/legal/privacy.html">Privacy</a><a href="/legal/terms.html">Terms</a><a href="/legal/support.html">Support</a></div></footer>
<script>${telemetryScript(page.slug)}</script>
</body>
</html>
`;
}

export function buildTaskPages(outDir = OUT_DIR) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const page of pages) {
    const html = renderPage(page);
    if ((html.match(/<h1[ >]/g) || []).length !== 1) throw new Error(`${page.slug}: expected exactly one <h1>`);
    if (/final ?cut/i.test(html.replace(/finalcap/gi, ''))) throw new Error(`${page.slug}: user-facing copy must not say "Final Cut"`);
    if (page.description.length < 150 || page.description.length > 160) throw new Error(`${page.slug}: meta description is ${page.description.length} chars (want 150-160)`);
    const file = path.join(outDir, `${page.slug}.html`);
    writeFileSync(file, html);
    written.push(`${page.slug}.html (${html.length} B)`);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`task pages: ${buildTaskPages().join(', ')}`);
}
