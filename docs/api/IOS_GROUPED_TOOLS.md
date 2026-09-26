# iOS grouped effect tools (build-gated, currently off)

Nine iOS-only tools run by the FinalCap iOS on-device executor: `channel_mixer`, `color_adjust`,
`apply_filter`, `stylize`, `blur_sharpen`, `lut`, `vignette_grain`, `segment`, `audio_effect`.
They come from FinalCut iOS's `docs/ios/data/proposed-tools-build11.json`; see
`docs/ios/ON_DEVICE_TOOLS.md` §8–9 for their behaviour. Every tool takes `intensity` 0–1:
0.25 means "a bit", 0.5 means no qualifier (the default), and 0.8 means "a lot"/"very".
Explicit values override `intensity`.

## Where things live

- Definitions and media types: `src/server/iosGroupedTools.js`. They are not in `src/tools.js`.
  So the web tool list (46 tools) and `docs/api/tools-schema.v1.json` never contain them.
  `audio_effect` is video-only. The other eight take `["video", "image"]`.
- Gate: `GROUPED_EFFECTS_MIN_BUILD` in `src/server/iosToolAllowlist.js`. It is currently a
  placeholder (`1_000_000_000`) that no real build reaches.
- Test guard: `src/test/ios-grouped-tools.test.js` checks that iOS/10 (21 tools), web (46) and
  `FinalCap/11 CFNetwork/1.0` (46) are byte-identical to snapshots taken before this change
  (`src/test/fixtures/tools-snapshots/`).

## What changes at the cutoff build

For `FinalCap-iOS/<build>` with `build >= GROUPED_EFFECTS_MIN_BUILD`:

- The 9 grouped tools are offered. Photos get 8 of them (no `audio_effect`).
- `adjust_brightness`, `adjust_contrast`, `adjust_saturation` and `adjust_hue` are retired.
  They are allowlisted as `{ minBuild: 10, maxBuild: GROUPED_EFFECTS_MIN_BUILD - 1 }`, and
  `color_adjust` replaces them. The iOS executor still accepts the old names.
- `apply_color_filter` stays, with a sharper iOS description that points film looks to `lut`,
  styles to `stylize` and amounts to `color_adjust`.
- Result: 21 − 4 + 9 = **26 tools**, both in `POST /api/chat` and in `GET /api/tools/schema`.

Builds below the cutoff, including 10, keep exactly their current 21 tools.

## Enabling (one line)

When FinalCut iOS posts the first valid TestFlight build with the grouped-tool executor, set
`export const GROUPED_EFFECTS_MIN_BUILD = <that build>;` in `src/server/iosToolAllowlist.js`,
then run `npm test`, push, and deploy. No test needs editing.

## Server runs

The server has no FFmpeg implementation for these tools. The job and sync process routes answer
**400** with `{ "error": "...", "code": "not_available_on_server", "operation": "<name>" }`.
The one exception is `audio_effect` on a photo, which gets the usual
`code: "unsupported_for_photo"`.
