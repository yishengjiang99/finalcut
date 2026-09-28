# TODO — FinalCap
_Last updated: 2026-09-28 9:21 AM PT by Chief of Staff_

On-device iOS work from `feat/ios-native-build10` is on `main` (tip `659303a`). Branch tip `dd71d71` is one UI-test commit ahead. TestFlight build 12 uploaded from `d907c14` (workflow overrides `CURRENT_PROJECT_VERSION` to the run number; repo file still says 10).

## Now (in progress)
- [ ] TestFlight build 12 (on-device edits, no "Upload" wording, Import menu, server-driven pills): install + dogfood — User + iOS — run 36279221297
- [ ] Land the one open UI-test fix from `feat/ios-native-build10` (`dd71d71`: no-Upload pill find by id/label + on-screen-by-frame) onto `main` — iOS
- [ ] Privacy update for client mode (`docs/asc/PRIVACY_NUTRITION.md`, `public/legal/privacy.html`): review draft before any App Store submit — Chief of Staff
- [ ] Keep `translate_captions` and `burn_subtitles` off the iOS allowlist — Backend
- [ ] Grouped effect tools (build-gated; `GROUPED_EFFECTS_MIN_BUILD` still placeholder) — Backend + iOS — `c166321`

## Next
- [ ] ASC listing upload from composed screenshots (`docs/asc/screenshots/`, captions in `docs/asc/screenshot-captions.json`) — Design + Chief of Staff — `43a6c3b`
- [ ] Cut next TestFlight once privacy + listing are ready — iOS
- [ ] ImgBot PR #84 (image optimize, open) — triage or ignore — Chief of Staff

## Blocked / waiting on user
- [ ] TestFlight testing of build 12 — User
- [ ] Decision on App Store submit timing for FinalCap 1.0 — User

## Done (recent)
- [x] Music Reader privacy/support/terms pages under `public/music-reader/` (served with FinalCap host) — `659303a` — 2026-09-27
- [x] TestFlight build 12 uploaded (on-device path; skipped waiting on flaky Speed-up UI test) — run 36279221297 from `d907c14` — 2026-09-26
- [x] ASC caption compositor + framed iphone69/ipad13 screenshots (build 11 frames) — `43a6c3b` — 2026-09-26
- [x] Import menu (camera/Photos/Files) + server-driven suggestion pills (`GET /api/ios/suggestions`) + no-Upload copy — `7faf594`, `3186953`, `d7dbbe3` — 2026-09-26
- [x] iOS Unit Tests green on `main` at `d907c14` — run 36279719348 — 2026-09-26
- [x] Stop tracking `.env.production`; vite/vitest audit clear; NODE_ENV set in build script — `8eedc81`, `df767ae`, `d15ed94` — 2026-09-26
- [x] Client-mode chat charged once per edit turn via signed `turnToken`; prod grepawk.com — `f3483e4` — 2026-09-26
- [x] Daily limit enforced atomically — `dee7838` — 2026-09-26
- [x] `generate_captions` allowlisted for build 10+ (21 tools) — `2bdd104` — 2026-09-26
- [x] Server tool allowlist by UA (`FinalCap-iOS/<build>`) — `54b4e43` — 2026-09-26
