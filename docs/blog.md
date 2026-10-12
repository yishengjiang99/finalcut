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
product: finalcap                  # finalcap | protune | ai-music-radar | music-reader (sets the app link + JSON-LD)
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
