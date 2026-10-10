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

## 2026-10-09: GPL compliance via same-origin source hosting (supersedes the written offer)

Decided by the Chief of Staff, 2026-10-09. Amends D4.

### D8. Corresponding Source is hosted next to the wasm, with no written offer
- `/legal/licenses.html` contains **no written offer**. Instead the site provides equivalent access to the Corresponding Source **from the same origin, next to the wasm**: `/v2/vendor/ffmpeg/source/` (GPL-2.0 §3(a)-style "accompany" by equivalent access from the same place).
- What is hosted there:
  - the ffmpeg.wasm build recipe at the release commit of `@ffmpeg/core`/`@ffmpeg/core-mt` 0.12.10 (`ffmpegwasm/ffmpeg.wasm@71aa99d3`, tag `v12.15`), which includes the Dockerfile, Makefile, `build/*.sh`, the bindings and the patched fftools;
  - the exact source archives of FFmpeg 5.1.4 (the official release tarball plus its PGP signature), x264, and every other library compiled or linked into the cores;
  - `SHA256SUMS`, `versions.json`, `BUILD.txt`, and the license texts extracted from each archive.
- **Implementation:**
  - The archives are fetched and verified at build/deploy time by `scripts/fetch-ffmpeg-source.mjs` (part of `npm run build:v2`). The tarballs are not committed to git.
  - Checksums are pinned in `vendor/ffmpeg-source.lock.json`. **The build fails** on any SHA-256 or size mismatch, on an embedded git commit id that differs from the pin, and on an SDL2 SHA-512 that differs from Emscripten's pin.
- Library list and versions are taken from the ffmpeg.wasm `Dockerfile` and `build/ffmpeg-wasm.sh` at the release commit:
  - FFmpeg n5.1.4, x264 (ffmpegwasm `4-cores` @33cac6b7), x265 3.4, libvpx 1.13.1, LAME (master @2badea19), libogg 1.3.4, libtheora 1.1.1, Opus 1.3.1, libvorbis 1.3.3, zlib 1.2.11, libwebp 1.3.2, FreeType 2.10.4, FriBidi 1.0.9, HarfBuzz 5.2.0, libass 0.15.0, zimg 3.0.5;
  - SDL2 2.24.2 (Emscripten port, `-sUSE_SDL=2`);
  - Emscripten 3.1.40 (toolchain and the system libraries linked into the wasm).
- Correction to the first spike commit: `@ffmpeg/core` 0.12.10 was released from commit `71aa99d3` (tag `v12.15`, 2025-01-07). The git tag `v0.12.10` is an older release of `@ffmpeg/ffmpeg` that shipped core 0.12.6. The licenses page now links the right commit.

## 2026-10-09: guarded production deploy of /v2 (approved by Yisheng)

PR #99 merged; from now on changes go straight to `main` (no PRs). Implements D6 and the iOS hard constraint.

### D9. Deploy = gate → build on runner → read-only preflight → ship → scoped nginx → gate → rollback
- `.github/workflows/deploy-grepawk.yml` (push to main), using the existing SSH key, host, user and dir variables. No new hosts or credentials.
- **Gate before**: the iOS contract test (`tests/contract/ios-endpoints.mjs`) runs against production and is recorded as the baseline, together with a header snapshot of the existing routes. A failing gate stops the job before anything changes.
- **Build on the runner**: `npm run build` then `npm run build:v2`. The server no longer builds. `dist/` is uploaded to `dist.new` and swapped in, and the old one is kept as `dist.prev`.
- **Preflight (read-only, over SSH)**: `nginx -t` passes on the current config, sudo/root works, and exactly one nginx file contains `root $DEPLOY_DIR/dist;` exactly once. Otherwise the job stops with nothing changed.
- **nginx**: `scripts/nginx/finalcut-v2-nginx.sh install`:
  - backs up to `/var/backups/finalcut-nginx/<ts>`;
  - installs the two snippets in `/etc/nginx/snippets/`;
  - adds a single marked `include` right after that `root` line (this site's server block only);
  - runs `nginx -t`, then reloads;
  - restores the backup and reloads on any failure.

  It is idempotent. It is tested in CI with stubs and inside real `nginx:1.18.0`, including a forced failure.
- **Gate after**:
  - health and commit;
  - the iOS contract with **no drift** vs the baseline (only a manual `allow_contract_drift` dispatch can relax this);
  - `/v2` COOP/COEP/CORP and `application/wasm`;
  - existing routes' headers identical to the snapshot;
  - licenses and Corresponding Source reachable, with SHA256SUMS identical to the build.
- **Rollback** on any failure after shipping:
  - nginx is restored from this run's backup only (keyed by run id);
  - `dist` is swapped back only if this run swapped it;
  - then the contract and header checks are re-run.

  Server code and node_modules are not rolled back automatically.
