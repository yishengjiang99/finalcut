---
title: Blog formatting reference
description: Every block a grepawk.com/blog post can use, with the Markdown that produces it. Not indexed; for writers and agents.
---
Each example shows the Markdown, then the result. Full rules: `blog/AGENTS.md` in any of the four repos.

## Images

Put the file next to `index.md` and write normal Markdown. Alt text is required; the quoted title becomes the caption.

```
![What the image shows](screenshot.jpg "Optional caption")
```

The build makes AVIF, WebP and JPEG (or PNG) copies at several widths, sets width and height, and lazy loads them. Originals over 1.5 MB or 3000 px fail the build. Tall phone screenshots show at phone width.

## Galleries

One image per line: file, alt text, optional caption.

```
​```gallery
01-home.jpg | The home screen with the record button | Record a take
02-score.jpg | The engraved score | The page
​```
```

## Self-hosted video

Upload the file once to the `blog-media` release, then reference it by name. A poster image from the post folder and a title are required. Videos never autoplay and load nothing until play.

```
gh release upload blog-media my-clip.mp4 -R yishengjiang99/finalcut

​```video
src: my-clip.mp4
poster: my-clip-poster.jpg
title: What the video shows
caption: Optional caption
​```
```

## YouTube

Shows a local thumbnail. Nothing loads from YouTube until the reader presses play.

```
​```youtube
id: aqz-KE-bpKQ
title: Big Buck Bunny, the Blender Foundation open movie
​```
```

```youtube
id: aqz-KE-bpKQ
title: Big Buck Bunny, the Blender Foundation open movie
```

## Posts on X

Shows a card. The X script loads only after the reader presses Load post. `text` is optional preview text.

```
​```x
url: https://x.com/Blender/status/2108217271717867606
text: Blender 5.3 has entered Beta.
​```
```

```x
url: https://x.com/Blender/status/2108217271717867606
text: Today is the day! Blender 5.3 has entered Beta.
```
