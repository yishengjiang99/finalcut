# FinalCap — App Store screenshot brief

**Visual system:** darkroom-adjacent video editor (preview + timeline stub + chat). **Do not** reuse Grok Camera / Photo Recipes viewfinder chrome, shutter, or AO dials.

## Required sizes (ASC — confirm current matrix)

Prepare sets for at least:

| Device class | Typical pixel size | Priority |
|--------------|--------------------|----------|
| iPhone 6.7" (15 Pro Max / 16 Plus class) | 1290 × 2796 | P0 |
| iPhone 6.5" | 1284 × 2778 | P0 if ASC still lists |
| iPhone 6.1" / 5.8" as required by ASC year | per ASC | P1 |
| iPad 12.9" | only if iPad listed | N/A unless supporting iPad |

Export PNG, no alpha on store frames. Show **status bar** consistently (or use ASC templates).

## Shot list (7 frames — MVP story)

Story arc: **import → chat edit → captions → burn → export**. Skip SignIn / Paywall stubs in v1 screenshots.

| # | On-frame title | Shows | Avoid |
|---|----------------|-------|--------|
| 1 | AI video editing | `Landing` — dark value prop + Get Started | Camera shutter, Photo Recipes chrome |
| 2 | Import your clip | `Editor` empty or Photos import CTA | Mic / camera permission banners |
| 3 | Preview ready | Preview (~40%) + `TimelineStub` scrub + chat welcome + sample chips | Tiny illegible chat |
| 4 | Edit in chat | User bubble (“Trim to 5–15s”) + processing dimmer (“Editing…”) | Walls of JSON / raw tool dumps |
| 5 | Your edit, done | Assistant bubble + result thumb + updated preview | Fake “pro timelines” / multi-track |
| 6 | Captions & burn | Soft VTT/SRT chips under bubble; optional “Burning subtitles…” sync wait then burned preview | Job-poll spinner for burn-in; “99% accurate” claims |
| 7 | Export | `ExportSheet` — Share / Save to Photos | Stripe web checkout, SignIn/Paywall |

Frames 4–6 may be combined to 6 total if ASC slot count is tight: keep **Import, Preview ready, Edit in chat, Captions/burn, Export** as the P0 five, plus Landing if space.

## Processing chrome (consistent)

- Long FFmpeg edits: dimmer through job `queued|running` (“Editing…”)
- Captions generate/translate: “Generating captions…” / “Translating…”
- Burn-in: sync wait “Burning subtitles…” (not jobs poll)

## Copy tone

Craft-forward, short. No “Grok”, no “Final Cut Pro”, no beauty-filter language.

## File naming

`asc/iphone67-01-landing.png` … `iphone67-07-export.png` (and `iphone65-…` mirrors).

Store under `assets/app-store/screenshots/` once Design exports (create folder on that PR). Persist creatives in git per house rule.

## Owner

FinalCut Design → frames; FinalCut iOS → optional real-device captures; CoS → ASC upload.
