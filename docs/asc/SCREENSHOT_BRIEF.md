# FinalCut — App Store screenshot brief

**Visual system:** darkroom-adjacent video editor (timeline + preview + chat). **Do not** reuse Grok Camera viewfinder chrome, shutter, or AO dials.

## Required sizes (ASC — confirm current matrix)

Prepare sets for at least:

| Device class | Typical pixel size | Priority |
|--------------|--------------------|----------|
| iPhone 6.7" (15 Pro Max / 16 Plus class) | 1290 × 2796 | P0 |
| iPhone 6.5" | 1284 × 2778 | P0 if ASC still lists |
| iPhone 6.1" / 5.8" as required by ASC year | per ASC | P1 |
| iPad 12.9" | only if iPad listed | N/A unless supporting iPad |

Export PNG, no alpha on store frames. Show **status bar** consistently (or use ASC templates).

## Shot list (6 frames — MVP story)

| # | Title (≤ few words on frame) | Shows | Avoid |
|---|------------------------------|-------|--------|
| 1 | Import your clip | Landing / empty editor + clear Import CTA | Camera shutter |
| 2 | Preview ready | Preview pane + timeline scrub with sample clip | Tiny illegible chat |
| 3 | Edit in chat | Chat bubble with user ask + assistant tool result | Walls of JSON |
| 4 | Captions | Soft captions chips / SRT preview under chat | Fake “99% accurate” claims |
| 5 | Burning subtitles… | Same processing chrome as Design: wait state on burn-in | Job-poll spinner if burn is sync |
| 6 | Export | Export sheet / saved success | Stripe web checkout UI |

## Copy tone

Craft-forward, short. No “Grok”, no “Final Cut Pro”, no beauty-filter language.

## File naming

`asc/iphone67-01-import.png` … `iphone67-06-export.png` (and `iphone65-…` mirrors).

Store under `assets/app-store/screenshots/` once Design exports (create folder on that PR). Persist creatives in git per house rule.

## Owner

FinalCut Design → frames; FinalCut iOS → optional real-device captures; CoS → ASC upload.
