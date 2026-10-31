// Blog media (scripts/build-blog.mjs, docs/blog.md):
// - images next to a post (blog/<slug>/*.jpg|png|webp) -> AVIF + WebP + JPEG/PNG fallback at several
//   widths under dist/media/blog/, content-hashed (nginx serves /media/ with an immutable cache);
// - videos: assets of the `blog-media` GitHub release of yishengjiang99/finalcut, downloaded at build
//   time (kept out of every git history) and copied to dist/media/blog/ (nginx: range requests);
// - YouTube thumbnails fetched at build time, so a page makes no third-party request until a click;
// - Open Graph cards (1200x630) drawn per post with sharp + Inter Bold.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// sharp defaults to concurrency 1 on glibc Linux without jemalloc (CI runners, the deploy box), which
// makes libvips/libaom encode every AVIF single-threaded: ~4x slower, and AVIF is ~70% of the blog
// build. This is a short-lived build process, so the allocator-fragmentation concern behind that
// default does not apply; use every core.
sharp.concurrency(availableParallelism());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FONT = path.join(HERE, 'fonts', 'Inter-Bold.ttf');
export const MEDIA_URL = '/media/blog';
export const IMAGE_MAX_BYTES = 1_500_000; // per original image in a repo
export const IMAGE_MAX_EDGE = 3000;
export const VIDEO_MAX_BYTES = 60_000_000; // per release asset
export const RELEASE = 'https://github.com/yishengjiang99/finalcut/releases/download/blog-media';
const WIDTHS = [480, 800, 1200, 1600];
const CACHE = path.join(ROOT, '.cache', 'blog-media');

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 10);
const safe = (name) => path.basename(name).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Network fetch with a hard timeout and one retry, so a stalled connection fails the build with a
// clear message instead of hanging it.
async function download(url, httpError, { timeoutMs = 60_000, tries = 2 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw Object.assign(new Error(httpError(res.status)), { final: res.status < 500 });
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (e.final) throw e;
      last = e;
    }
  }
  throw new Error(`${url}: ${last?.cause?.message || last?.message || last}`);
}

export class Media {
  constructor(outDir) {
    this.dir = path.join(outDir, 'media', 'blog');
    mkdirSync(this.dir, { recursive: true });
  }

  /** Optimise one image file. Returns { width, height, sources, fallback, sizes } for <picture>. */
  async image(file, { maxWidth = 1600 } = {}) {
    if (!existsSync(file)) throw new Error(`image not found: ${file}`);
    const buf = readFileSync(file);
    if (buf.length > IMAGE_MAX_BYTES) throw new Error(`${file}: ${(buf.length / 1e6).toFixed(2)} MB is over the ${IMAGE_MAX_BYTES / 1e6} MB limit; resize or recompress the original`);
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) throw new Error(`${file}: not an image`);
    if (Math.max(meta.width, meta.height) > IMAGE_MAX_EDGE) throw new Error(`${file}: ${meta.width}x${meta.height} is over ${IMAGE_MAX_EDGE}px on the long edge`);
    if (meta.height / meta.width > 1.3) maxWidth = Math.min(maxWidth, 800); // phone screenshots show narrow
    const id = `${safe(file)}-${hash(buf)}`;
    const alpha = meta.hasAlpha && meta.format === 'png';
    const fb = alpha ? 'png' : 'jpg';
    const top = Math.min(meta.width, maxWidth);
    const widths = [...new Set([...WIDTHS.filter((w) => w < top), top])];
    const out = { avif: [], webp: [], [fb]: [] };
    // Encode every width x format at once (libuv/libvips spread them over the cores); the srcset
    // order is fixed by `widths`, not by completion order.
    const encodes = [];
    for (const w of widths) {
      const base = sharp(buf).rotate().resize({ width: w, withoutEnlargement: true });
      const jobs = {
        avif: () => base.clone().avif({ quality: 55, effort: 4 }),
        webp: () => base.clone().webp({ quality: 78 }),
        jpg: () => base.clone().flatten({ background: '#ffffff' }).jpeg({ quality: 80, mozjpeg: true }),
        png: () => base.clone().png({ compressionLevel: 9, palette: true }),
      };
      for (const f of ['avif', 'webp', fb]) {
        const name = `${id}-${w}.${f}`;
        const dest = path.join(this.dir, name);
        if (!existsSync(dest)) encodes.push(jobs[f]().toBuffer().then((b) => writeFileSync(dest, b)));
        out[f].push(`${MEDIA_URL}/${name} ${w}w`);
      }
    }
    await Promise.all(encodes);
    const height = Math.round(meta.height * (top / meta.width));
    return { width: top, height, ratio: meta.height / meta.width, avif: out.avif.join(', '), webp: out.webp.join(', '), fallbackSet: out[fb].join(', '), src: out[fb].at(-1).split(' ')[0], largest: `${MEDIA_URL}/${id}-${top}.${fb}` };
  }

  /** Download a blog-media release video into .cache/blog-media/ (no-op when cached); returns the path. */
  async fetchVideo(name) {
    const cached = path.join(CACHE, name);
    if (!existsSync(cached)) {
      const buf = await download(`${RELEASE}/${name}`, (status) => `video "${name}": ${status} from the blog-media release (upload it with: gh release upload blog-media ${name} -R yishengjiang99/finalcut)`);
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cached, buf);
    }
    return cached;
  }

  /** Download a YouTube thumbnail into .cache/blog-media/ (no-op when cached); returns the path. */
  async fetchYoutubeThumb(id) {
    const cached = path.join(CACHE, `yt-${id}.jpg`);
    if (!existsSync(cached)) {
      const buf = await download(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, (status) => `youtube ${id}: thumbnail ${status} (is the id right?)`);
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(cached, buf);
    }
    return cached;
  }

  /** A video asset from the blog-media release (downloaded once into .cache/blog-media/). */
  async video(name) {
    if (!/^[A-Za-z0-9._-]+\.(mp4|webm)$/.test(name)) throw new Error(`video "${name}": use a file name of the blog-media release (.mp4 or .webm)`);
    const cached = await this.fetchVideo(name);
    const size = statSync(cached).size;
    if (size > VIDEO_MAX_BYTES) throw new Error(`video "${name}" is ${(size / 1e6).toFixed(1)} MB, over ${VIDEO_MAX_BYTES / 1e6} MB`);
    const ext = path.extname(name);
    const out = `${safe(name)}-${hash(readFileSync(cached))}${ext}`;
    copyFileSync(cached, path.join(this.dir, out));
    return { url: `${MEDIA_URL}/${out}`, type: ext === '.webm' ? 'video/webm' : 'video/mp4', bytes: size };
  }

  /** WebVTT captions file from the post folder, content-hashed. */
  captions(file) {
    if (!existsSync(file)) throw new Error(`captions file not found: ${file}`);
    const buf = readFileSync(file);
    if (path.extname(file) !== '.vtt' || !buf.toString('utf8', 0, 6).startsWith('WEBVTT')) throw new Error(`captions must be a WebVTT .vtt file: ${file}`);
    const out = `${safe(file)}-${hash(buf)}.vtt`;
    writeFileSync(path.join(this.dir, out), buf);
    return { url: `${MEDIA_URL}/${out}` };
  }

  /** YouTube thumbnail, fetched at build time and cropped to 16:9. */
  async youtubeThumb(id) {
    const cached = await this.fetchYoutubeThumb(id);
    const cropped = path.join(CACHE, `yt-${id}-16x9.jpg`);
    if (!existsSync(cropped)) await sharp(cached).resize(480, 270, { fit: 'cover' }).jpeg({ quality: 85 }).toFile(cropped);
    return this.image(cropped, { maxWidth: 480 });
  }

  /** Image-led index card art (1200x630, no title text): product gradient + the hero screenshot. */
  async cardArt({ key, product, accent, accent2, hero }) {
    const W = 1200, H = 630;
    const bg = Buffer.from(`<svg width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${accent}"/><stop offset="1" stop-color="${accent2}"/></linearGradient><radialGradient id="r" cx=".5" cy="1.1" r=".9"><stop offset="0" stop-color="#0b0e13" stop-opacity=".55"/><stop offset="1" stop-color="#0b0e13" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/><rect width="${W}" height="${H}" fill="url(#r)"/><circle cx="1040" cy="90" r="220" fill="#fff" fill-opacity=".10"/><circle cx="140" cy="600" r="260" fill="#000" fill-opacity=".10"/></svg>`);
    const layers = [{ input: bg, top: 0, left: 0 }];
    if (hero) {
      const meta = await sharp(hero).metadata();
      const tall = meta.height / meta.width > 1.1;
      const w = tall ? 300 : 900; const h = tall ? 560 : 500;
      const img = await sharp(hero).resize({ width: w, height: h, fit: 'cover', position: 'top' }).png().toBuffer();
      const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${tall ? 34 : 18}" fill="#fff"/></svg>`);
      const shadow = await sharp({ create: { width: w + 60, height: h + 60, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: Buffer.from(`<svg width="${w + 60}" height="${h + 60}"><rect x="30" y="38" width="${w}" height="${h}" rx="34" fill="#000" fill-opacity=".45"/></svg>`) }]).blur(14).png().toBuffer();
      layers.push({ input: shadow, top: Math.round((H - h) / 2) - 30 + (tall ? 20 : 30), left: Math.round((W - w) / 2) - 30 });
      layers.push({ input: await sharp(img).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer(), top: Math.round((H - h) / 2) + (tall ? 20 : 30), left: Math.round((W - w) / 2) });
    } else {
      const t = await sharp({ text: { text: `<span foreground="#ffffff">${product.replace(/&/g, '&amp;')}</span>`, fontfile: FONT, font: 'Inter Bold 88', width: 1000, align: 'center', rgba: true } }).png().toBuffer({ resolveWithObject: true });
      layers.push({ input: t.data, top: Math.round((H - t.info.height) / 2), left: Math.round((W - t.info.width) / 2) });
    }
    const jpg = await sharp({ create: { width: W, height: H, channels: 3, background: accent } }).composite(layers).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    mkdirSync(CACHE, { recursive: true });
    const file = path.join(CACHE, `card-${key}.jpg`);
    writeFileSync(file, jpg);
    return this.image(file, { maxWidth: 800 });
  }

  /** 1200x630 Open Graph card: product, title, site; the hero image (if any) on the right. */
  /** A hand-made share card (front matter ogImage): a 1200x630 JPEG used as og:image and twitter:image. */
  async ogImage({ key, file }) {
    if (!existsSync(file)) throw new Error(`ogImage not found: ${file}`);
    const buf = readFileSync(file);
    const meta = await sharp(buf).metadata();
    if (meta.width !== 1200 || meta.height !== 630 || meta.format !== 'jpeg') throw new Error(`${file}: ogImage must be a 1200x630 JPEG`);
    const name = `og-${key}-${hash(buf)}.jpg`;
    writeFileSync(path.join(this.dir, name), buf);
    return `${MEDIA_URL}/${name}`;
  }

  async ogCard({ key, title, product, accent = '#6a5ae0', accent2 = '#5b8def', hero }) {
    const W = 1200, H = 630;
    const heroW = hero ? 330 : 0;
    const textW = W - 128 - (hero ? heroW + 56 : 0);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = (t, size, color, width) => sharp({ text: { text: `<span foreground="${color}">${esc(t)}</span>`, fontfile: FONT, font: `Inter Bold ${size}`, width, rgba: true, spacing: Math.round(size * 0.18) } }).png().toBuffer({ resolveWithObject: true });
    let size = 64; let t = await text(title, size, '#e8edf4', textW);
    while (t.info.height > 330 && size > 40) { size -= 6; t = await text(title, size, '#e8edf4', textW); }
    const p = await text(product.toUpperCase(), 26, '#a99ffb', textW);
    const site = await text('grepawk.com/blog', 26, '#9aa7bb', textW);
    const layers = [
      { input: Buffer.from(`<svg width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#0b0e13"/><rect x="64" y="64" width="72" height="8" rx="4" fill="${accent}"/><rect x="0" y="${H - 6}" width="${W}" height="6" fill="${accent}"/></svg>`), top: 0, left: 0 },
      { input: p.data, top: 100, left: 64 },
      { input: t.data, top: 150, left: 64 },
      { input: site.data, top: H - 96, left: 64 },
    ];
    if (hero) {
      const h = H - 80;
      const img = await sharp(hero).resize({ width: heroW, height: h, fit: 'cover', position: 'top' }).png().toBuffer();
      const mask = Buffer.from(`<svg width="${heroW}" height="${h}"><rect width="${heroW}" height="${h}" rx="28" fill="#fff"/></svg>`);
      const rounded = await sharp(img).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
      layers.push({ input: rounded, top: 40, left: W - heroW - 64 });
    }
    const jpg = await sharp({ create: { width: W, height: H, channels: 3, background: '#0b0e13' } }).composite(layers).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    const name = `og-${key}-${hash(jpg)}.jpg`;
    writeFileSync(path.join(this.dir, name), jpg);
    return { og: `${MEDIA_URL}/${name}`, card: await this.cardArt({ key, product, accent, accent2, hero }) };
  }
}
