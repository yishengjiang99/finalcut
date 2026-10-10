# Decisions

Append-only log. Newest at the bottom. Each entry: date (PT), decision, why, where it is implemented.

## 2026-10-09: web editor moves FFmpeg into the browser (ffmpeg.wasm)

Context: [`docs/web-ffmpeg-plan.md`](web-ffmpeg-plan.md). Decided by Yisheng (repo owner).

### D1. Hard constraint: don't break the iOS app's server side
- The new editor lives on **new routes only**: the page at `/v2/`, new APIs under `/api/v2/...`.
- Every existing endpoint (`/api/*`, `/auth/*`) and the current web editor at `/` stay **byte-for-byte unchanged in behaviour**.
- COOP/COEP (+ CORP) and the `application/wasm` MIME type are scoped to the new route only.
- A contract test hits the existing iOS-facing endpoints (`tests/contract/ios-endpoints.mjs`). It runs in CI on every PR (base vs PR server, must not drift) and before and after every deploy.
- The main web entry (`/`) switches to the new editor only after the e2e suite passes; the old editor stays as a fallback route.

### D2. Captions: on-device by default
- Default: **on-device Whisper** (transformers.js, `tiny`/`base`, WebGPU with WASM fallback, lazy-loaded, cached).
- Cloud transcription is an explicit **opt-in, off by default**, labelled "Use cloud transcription for better accuracy, uploads audio only". Audio only, never video.
- Bilingual translation may call Grok with **text only**.

### D3. Clip limits (in-browser editing)
- Desktop: soft warning above **1 GB**, hard block above **~1.8 GB**.
- Mobile / Safari: soft warning above **300 MB**, hard block above **500 MB**.
- Warn above **~10 min of 1080p**.
- Limits are **server-configurable** through the capability catalog. Defaults: `src/wasm/clipLimits.js`.

### D4. Licensing
- The GPL ffmpeg.wasm core (libx264/libx265) is OK to ship.
- `/legal/licenses.html` lists FFmpeg, ffmpeg.wasm and x264 (and the other compiled-in libraries) with exact versions and source-tag links, linked from the new editor's footer.

### D5. Missing web tools
- Fix the 11 audio-effect tools that have no web implementation today (`audio_chorus`, `audio_flanger`, `audio_phaser`, `audio_vibrato`, `audio_tremolo`, `audio_gate`, `audio_stereo_widen`, `audio_reverse`, `audio_limiter`, `audio_silence_remove`, `audio_pan`) during the port.

### D6. FFmpeg capability catalog + generic tool
- The server keeps a full JSON catalog of the wasm FFmpeg build: filters and their options, codecs, formats, recipes, wasm availability.
- The agent queries it when the default typed tools don't fit, and falls back to a validated generic `run_ffmpeg` tool that runs client-side.

### D7. nginx config in the repo, deployed by GitHub Actions
- The nginx config goes into the repo (`nginx/`) and is deployed by GitHub Actions: back up, install, `nginx -t`, reload only on success (restore the backup on failure).
- Scoped to the grepawk.com server block with a single `include`, so other sites on the host are unaffected.

### Spike notes (same day)
- Pinned exact versions: `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/util@0.12.2`, `@ffmpeg/core@0.12.10` (single-thread), `@ffmpeg/core-mt@0.12.10`. `@ffmpeg/core-st` is not used (it stops at 0.11.1; the 2025-12 attempt pointed at a nonexistent `core-st@0.12.6`).
- In the mt core, libx264 must get an explicit output `-threads` ≤ 4: auto or 8 hangs forever, 6 aborts (measured). The host caps it at 4 and has a wall-clock watchdog.
