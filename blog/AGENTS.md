# Agent instructions: adding a blog post

Posts in this folder are published at https://grepawk.com/blog/<slug> by the finalcut build
(`scripts/build-blog.mjs`, full docs in yishengjiang99/finalcut `docs/blog.md`). The same
convention applies in finalcut, photo-recipes, earsheet and omr-sheet-cam. Nothing outside `blog/`
is ever published; never copy internal docs here wholesale.

## Folder and slug

- One post per folder: `blog/<slug>/index.md`. The slug is the URL and must be lowercase-with-dashes
  and unique across all four repos (the build fails on a duplicate).
- Folders starting with `_` and this file are ignored.

## Front matter

Required:

| key | notes |
| --- | --- |
| `title` | the h1, sentence case |
| `description` | 70 to 160 characters; meta description, link previews, RSS, /blog card |
| `date` | `YYYY-MM-DD` |
| `product` | `finalcap`, `protune`, `ai-music-radar` or `music-reader` (this repo: `finalcap`); sets the app link at the end of the post and the JSON-LD |
| `publish: true` | the opt-in. Without it (or with `draft: true`) the post is skipped |

Optional: `updated` (YYYY-MM-DD), `tags` (`[a, b]`), `seoTitle`, `author` (defaults to Yisheng
Jiang), `canonical` (absolute URL, only for a cross-post whose original lives elsewhere), `draft: true`,
`properNouns` (capitalised words allowed in headings, e.g. `[Core, Runtime]`).

## Writing rules (the leak lint enforces most of these; any finding fails the build)

- Plain, concise words. No em dashes. No AI vocabulary (delve, seamless, leverage, robust, unlock,
  harness, elevate, realm, tapestry, cutting-edge and similar).
- Sentence case headings (`## Why the app draws its own staff`). No `# ` heading in the body; the title is the h1.
- Only accurate facts from the code, docs or live site. Invent no numbers or features.
- No internal details: IPs, hosts, ssh, secrets or secret names, tokens, `/api/` paths, server paths,
  deploy variables, App Store Connect details (ASC, TestFlight, bundle ids, app ids, SKUs).
- Say FinalCap, never "Final Cut".
- Raw HTML is escaped. Markdown tables, lists, code and links work.

## Images

Not supported yet: an image in a post fails the build. Describe it in text or link to a page that has it.

## Links

- Link the app at the end via `product` (added automatically). In the text, link the App Store page
  only for apps that are live there (today only ProTune:
  https://apps.apple.com/us/app/protune-ai-camera/id6813991381). Apps in review link to their site:
  FinalCap https://grepawk.com/, AI Music Radar https://music.grepawk.com/, Music Reader
  https://grepawk.com/music-reader/support.html.
- ProTune articles stay canonical on https://photo.grepawk.com/articles (photo-recipes `articles/`).
  /blog lists them as link-out cards; link to them, never copy them into a post.

## Preview and build locally

In a finalcut checkout, with this repo checked out next to it:

```
mkdir -p /tmp/bs && for r in photo-recipes earsheet omr-sheet-cam; do ln -sfn "$PWD/../$r" /tmp/bs/$r; done
BLOG_SOURCES_DIR=/tmp/bs node scripts/build-blog.mjs /tmp/blog-out   # lint + render
npx vitest --run src/test/blog.test.js
```

Open `/tmp/blog-out/blog/<slug>/index.html` in a browser. Without `BLOG_SOURCES_DIR` the script fetches
the four repos' `main` branches instead.

## Publishing

Push to `main` with only `blog/**/*.md` changed (iOS workflows ignore Markdown, the site deploys
ignore `blog/`). In finalcut the push deploys. For the other repos, the hourly **Blog sync** workflow in
finalcut sees the newer `blog/` commit and runs the guarded "Deploy grepawk.com". Fallback:
finalcut, Actions, Blog sync, Run workflow (`force` deploys even if nothing changed). Then check
https://grepawk.com/blog/<slug>.

## Template

```
---
title: How the app does one thing
description: One or two plain sentences, 70 to 160 characters, saying what the post explains and for whom.
date: YYYY-MM-DD
publish: true
product: finalcap
tags: [topic, topic]
---
One short paragraph: what the app does and what this post covers.

## The first idea

Plain sentences with real facts.

## Try it

Where to get the app (see the link rules above).
```

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
