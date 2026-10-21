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
| `product` | `finalcap`, `protune`, `ai-music-radar` or `music-reader` (this repo: `finalcap`); sets the app link at the end of the post and the JSON-LD. `grepawk` is neutral: no app link and no app JSON-LD |
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

Put image files in the post folder and reference them as `![what the image shows](file.jpg)`; an image
without alt text fails the build. `hero` + `heroAlt` set the share image. Videos use a ```` ```video ````
block (src, poster, title, optional captions, duration as ISO 8601 e.g. `PT1M30S`); they render with
`preload="none"` and the poster. See finalcut `docs/blog.md`.

## SEO checklist

The build already emits title, meta description, canonical, Open Graph/Twitter tags, JSON-LD
BlogPosting (plus VideoObject for videos), sitemap lastmod, RSS and an IndexNow ping on deploy. It
warns (does not fail) when the fields below are missing. Before publishing:

- Front matter: `title`, `description` (70 to 155 characters; if missing the first paragraph is used
  with a warning), `keyword` (the one search phrase the post targets), `hero` (share image) and
  `heroAlt` or `image_alt` (what the share image shows).
- Put the `keyword` in the title, in the first paragraph and in at least one `##` heading.
- Every image has alt text describing what it shows.
- Every video has a caption track (`captions:` WebVTT) or a short transcript in the post, a poster
  and a title.
- Link the app page (added at the end via `product`, plus once in the text) and one or two related
  posts on https://grepawk.com/blog.
- Set `updated` when you change a published post so sitemap lastmod and dateModified move.

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

Captions: add `captions: explainer.vtt` to a `video` block (WebVTT file in the post folder; convert an .srt by adding a `WEBVTT` first line and changing the commas in times to dots). It becomes a default-on `<track kind="captions">`. Optional `lang:` (default en) and `label:` (default English).

## ElevenLabs voiceover

Use this to (re)narrate an explainer or promo video.

- Key: `ELEVENLABS_API_KEY` in the finalcut app `.env` on the grepawk.com server. Read it over ssh on that
  server only (best: run the TTS calls there, so the key never leaves it). Never print, log or commit it,
  and never put it in a script.
- Voice: Matilda (`XrExE9yKIg1WjnnlVkGX`, warm female). Model: `eleven_multilingual_v2`. Pass
  `previous_text` / `next_text` so the lines flow.
- Script: one TTS clip per caption cue (or per slide), so each line lands on its visual.
- Fit with no dead air: trim edge silence, squeeze pauses inside a clip to about 0.3 s, then time-stretch
  each cue's video segment to its line plus a short gap (about 0.3 s). No gap over about 0.5 s, no overlaps.
  For a fixed-length cut (promo), place each line at its beat and speed it up slightly (atempo up to 1.15).
- Loudness: about -14 LUFS integrated, peaks under -1 dBTP. Drop the old voice; keep a music bed only if it
  was a separate stem.
- Regenerate the captions from the new timing (SRT and the post's `.vtt`).
- Mux H.264 + AAC with `-movflags +faststart`, then upload under a new file name and point the `video`
  block at it: `gh release upload blog-media new-name.mp4 -R yishengjiang99/finalcut`.
- finalcut has a script that does all of this from an MP4 + SRT:
  `python3 scripts/blog/elevenlabs-voiceover.py in.mp4 in.srt outdir/` (it runs TTS on the server over ssh).
