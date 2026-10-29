# Blog (grepawk.com/blog)

Static blog built from opted-in Markdown in four repos. Nothing in any `docs/` folder is ever read.

| Repo | Folder | Product id |
| --- | --- | --- |
| yishengjiang99/finalcut | `blog/<slug>/index.md` | `finalcap` |
| yishengjiang99/photo-recipes | `blog/<slug>/index.md` | `protune` |
| yishengjiang99/earsheet | `blog/<slug>/index.md` | `ai-music-radar` |
| yishengjiang99/omr-sheet-cam | `blog/<slug>/index.md` | `music-reader` |

photo-recipes `articles/` stay canonical on photo.grepawk.com/articles; /blog lists them as link-out cards only (no copy, no duplicate content).

## Add a post

1. In any of the four repos: `blog/<slug>/index.md` (lowercase-with-dashes; the slug is the URL `/blog/<slug>` and must be unique across all repos).
2. Front matter, then Markdown (no `# ` heading in the body; raw HTML is escaped; no images yet):

```
---
title: How X works                # h1, sentence case
description: 70-160 chars          # meta description, OG, RSS, cards
date: 2026-10-12                   # YYYY-MM-DD
publish: true                      # required opt-in; anything else is skipped
product: finalcap                  # finalcap | protune | ai-music-radar | music-reader | gbk (sets the app link + JSON-LD)
updated: 2026-10-20                # optional, dateModified + sitemap lastmod
tags: [a, b]                       # optional, JSON-LD keywords
seoTitle: ...                      # optional <title>
canonical: https://...             # optional, for a cross-post whose original lives elsewhere (left out of the sitemap)
properNouns: [Core, Runtime]       # optional, capitalised words allowed in headings
draft: true                        # optional, skips the post
---
```

3. Push. In finalcut the push deploys. In the other repos `.github/workflows/blog-sync.yml` (hourly, in finalcut) sees the newer `blog/` commit and runs the guarded deploy; or run **Blog sync** by hand.

Keep sibling-repo pushes to `blog/**/*.md`: earsheet and omr-sheet-cam `ios-sim.yml` ignore `**/*.md` and `docs/**`, so a Markdown-only push builds nothing there; photo-recipes deploys only on its path allowlist (no `blog/`).

## Build

`npm run build` ends with `scripts/build-blog.mjs`:

- `scripts/fetch-blog-sources.mjs`: sparse, shallow, anonymous clones of `blog/` (and photo-recipes `articles/`) into `.cache/blog-sources/` (all repos are public, no token). `BLOG_SOURCES_DIR=<dir>` reads local checkouts instead.
- Every post goes through `scripts/blog/lint.mjs` and the build fails on any finding: IPs, ssh targets, secret references and token-like strings, secret variable names, `/api/` paths, App Store Connect details (ASC, TestFlight, bundle ids, app ids outside App Store URLs), server paths, deploy variables, em dashes, "Final Cut", common AI vocabulary, Title Case headings.
- Output: `dist/blog/index.html` (Blog JSON-LD), `dist/blog/<slug>/index.html` (BlogPosting + BreadcrumbList JSON-LD, canonical, OG), `dist/blog/rss.xml`, `dist/blog/sources.json` (build time for blog-sync), and the /blog URLs merged into `dist/sitemap.xml`, which the deploy's IndexNow step submits.
- nginx: `nginx/finalcut-site.conf` (`/blog`, `/blog/<slug>`; slash, `.html` and `index.html` variants 301 to the clean URL).
- Tests: `src/test/blog.test.js` (lint, opt-in, JSON-LD, RSS, sitemap), `tests/nginx/finalcut-site-nginx.test.sh`, `tests/e2e/check-site-seo.sh` (post-deploy).

## Instant rebuilds (optional, needs a token)

The sibling repos cannot trigger finalcut with their own `GITHUB_TOKEN`. For instant rebuilds instead of the hourly poll, add a fine-grained token scoped to **yishengjiang99/finalcut only, Contents: read and write** (needed for `repository_dispatch`) as a secret in each sibling repo, plus a workflow there `on: push: paths: ['blog/**']` that sends `repository_dispatch` type `blog-updated`. `deploy-grepawk.yml` already listens for it. Note: in earsheet and omr-sheet-cam a new `.github/workflows/*.yml` file triggers `ios-sim.yml` once (not TestFlight).

## Images and video

Full examples: https://grepawk.com/blog/reference (not indexed).

- Put image files next to the post: `blog/<slug>/shot.jpg`. Use plain Markdown: `![What the image shows](shot.jpg)`. Alt text is required; the build fails without it.
- Originals must be 1.5 MB or less and 3000 px or less on the long side. Prefer JPEG around 900 to 1600 px wide. The build makes AVIF, WebP and a fallback with srcset, sizes and lazy loading.
- Card and social image: add `hero: shot.jpg` and `heroAlt: ...` to the front matter.
- No remote images. No raw iframes or script tags.
- Gallery, one image per line as `file | alt | caption`:

  ```gallery
  a.jpg | Home screen | Start here
  b.jpg | Settings drawer | Tweak it
  ```

- YouTube (click to load, no tracking until click):

  ```youtube
  id: aqz-KE-bpKQ
  title: Big Buck Bunny
  ```

- Post on X (click to load): a `x` block with `url:` and `text:` (the quoted words shown before load).
- Self hosted video: upload once, then reference by file name. Keep it under 60 MB, H.264 MP4 with faststart.

  ```sh
  gh release upload blog-media clip.mp4 -R yishengjiang99/finalcut
  ```

  ```video
  src: clip.mp4
  poster: clip-poster.jpg
  title: Short title
  caption: What it shows
  ```

  The poster is a normal image file in the post folder. Video is served from grepawk.com/media/ with range requests and preload none.

## Inline video (required: never link out)

Videos always play on the page. Never add a bare link to a video file, YouTube or X in place of a player.

- `video` block: renders a `<video controls playsinline preload="none">` player with the poster, inside the post. Nothing downloads until the reader presses play.
- `youtube` block: shows the thumbnail; clicking swaps in the youtube-nocookie player in the same spot and starts playing.
- `x` block: clicking loads the X embed in the same spot, and its video plays there.

### Adding an explainer video

1. Export H.264 MP4 (AAC audio), faststart, under 60 MB. 1080p or smaller.
   `ffmpeg -i in.mov -c:v libx264 -crf 23 -preset slow -c:a aac -b:a 128k -movflags +faststart explainer.mp4`
2. Make a poster from a frame that explains the topic:
   `ffmpeg -ss 3 -i explainer.mp4 -frames:v 1 -vf scale=1280:-2 explainer-poster.jpg`
   Put the poster in `blog/<slug>/`. Do not commit the MP4.
3. Upload the MP4 (file names must be unique in the release):
   `gh release upload blog-media explainer.mp4 -R yishengjiang99/finalcut`
4. Place the block where the reader needs it, usually right after the intro:

   ```video
   src: explainer.mp4
   poster: explainer-poster.jpg
   title: How X works (2 minutes)
   caption: One line on what the video shows.
   ```

   `title` is required (it feeds the player label and the VideoObject data). Add a sentence in the text that says what the video covers, so the post still reads well without playing it.
5. If the explainer is on YouTube instead, use a `youtube` block with `id:` and `title:`.
5. If the explainer is on YouTube instead, use a `youtube` block with `id:` and `title:`.

Captions: add `captions: explainer.vtt` to a `video` block (WebVTT file in the post folder; convert an .srt by adding a `WEBVTT` first line and changing the commas in times to dots). It becomes a default-on `<track kind="captions">`. Optional `lang:` (default en) and `label:` (default English).
