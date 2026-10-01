# TODO — FinalCap
_Last updated: 2026-09-30 5:10 PM PT by Chief of Staff_

On-device iOS work from `feat/ios-native-build10` is on `main` (tip `04f5d08`). Branch tip `dd71d71` is still one UI-test commit ahead of the merge base used for TestFlight. v1.0 build 12 is in App Review. ImgBot PR #84 still open. Recent CI on main is red on non-ASC jobs after ASC script pushes (listing/submit paths succeeded).

## Now (in progress)
- [ ] v1.0 build 12 in App Review (WAITING_FOR_REVIEW; BBB listing screenshots + age rating + content rights + free price; submission `079ac244` submitted 2026-09-30 ~2:03 PM PT / 21:03 UTC). Check with read-only **ASC status** only; do NOT re-run cancel/submit while waiting — Chief of Staff — submit run 36776867554
- [ ] Land the one open UI-test fix from `feat/ios-native-build10` (`dd71d71`: no-Upload pill find by id/label + on-screen-by-frame) onto `main` — iOS
- [ ] Keep `translate_captions` and `burn_subtitles` off the iOS allowlist — Backend
- [ ] Grouped effect tools (build-gated; `GROUPED_EFFECTS_MIN_BUILD` still placeholder) — Backend + iOS — `c166321`

## Next
- [ ] ImgBot PR #84 (image optimize, open; updated 2026-09-30) — triage or ignore — Chief of Staff
- [ ] Fix main CI failures from ASC-only script commits (or scope CI so listing-only pushes skip) — Backend / Chief of Staff

## Blocked / waiting on user
- [ ] App Review outcome for FinalCap 1.0 build 12 — User

## Done (recent)
- [x] v1.0 build 12 submitted WAITING_FOR_REVIEW — submit run 36776867554 `04f5d08` — 2026-09-30
- [x] ASC listing upload: BBB titled screenshots (iphone-69 / ipad-13), listing v2 copy, copyright/category/review contact — upload run on `04f5d08` / earlier `b7e900d` — 2026-09-30
- [x] Age rating declaration completed (unset → NONE/false) — `5f0b3e0` — 2026-09-30
- [x] contentRightsDeclaration (no third-party) + free price schedule via API — `b7e900d`…`04f5d08` — 2026-09-30
- [x] Bundle Big Buck Bunny sample for TestFlight archive / Copy Bundle Resources — `486b8fb`, `2e7de63`, `f73cf69` — 2026-09-30
- [x] Music Reader privacy/support/terms pages under `public/music-reader/` — `659303a` — 2026-09-27
- [x] TestFlight build 12 uploaded (on-device path) — run 36279221297 from `d907c14` — 2026-09-26
- [x] ASC caption compositor + framed screenshots (build 11 frames; later superseded by BBB set) — `43a6c3b` — 2026-09-26
- [x] Import menu + server-driven suggestion pills + no-Upload copy — `7faf594`, `3186953`, `d7dbbe3` — 2026-09-26
- [x] Client-mode chat charged once per edit turn via signed `turnToken` — `f3483e4` — 2026-09-26
