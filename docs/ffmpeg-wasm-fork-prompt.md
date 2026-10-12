# Prompt: fork and modernize ffmpeg.wasm for FinalCut

Paste this into Claude Code with both repos available: `yishengjiang99/finalcut` and a new fork of `ffmpegwasm/ffmpeg.wasm` (suggested name `yishengjiang99/ffmpeg.wasm`, package scope `@finalcut/ffmpeg-core`).

---

## Context

FinalCut's /v2 editor runs every edit in the browser through `src/wasm/ffmpegHost.js` and `src/wasm/ffmpegEngine.js`, on the pinned, now-unmaintained ffmpeg.wasm release:

- `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/util@0.12.2`, `@ffmpeg/core@0.12.10` (st), `@ffmpeg/core-mt@0.12.10` (mt)
- Built at `ffmpegwasm/ffmpeg.wasm@71aa99d3` (Jan 2025) with `emscripten/emsdk:3.1.40`, **FFmpeg n5.1.4**
- The server side already runs FFmpeg 8, so the capability catalog differs between browser and server.

What that build actually uses (verified from its `Makefile`, `Dockerfile`, `build/*.sh`):

| Feature | Status today |
|---|---|
| Web Workers | Yes. `@ffmpeg/ffmpeg` runs the core in a class worker; core-mt adds Emscripten pthread workers (`-sPTHREAD_POOL_SIZE=32`, all spawned at load). |
| SharedArrayBuffer | Only in core-mt, needs COOP/COEP (FinalCut sets these on /v2). Fixed `-sINITIAL_MEMORY=1024MB`, no memory growth. |
| Wasm SIMD | Only compiler auto-vectorization (`-O3 -msimd128`). All hand-written SIMD is off: FFmpeg, x264, libass, opus, theora, wavpack use `--disable-asm`; zimg uses `--disable-simd`. Only libwebp enables SIMD. |
| x264 | ffmpegwasm's `4-cores` branch. |
| Exceptions / longjmp | Emscripten JS-based defaults (no `-fwasm-exceptions`, no `-sSUPPORT_LONGJMP=wasm`). |
| WebCodecs / OPFS | Not used. |

Workarounds FinalCut carries because of this build (each is a measurable target):

1. `MAX_MT_THREADS = 4`: libx264 with auto threads or `-threads 8` hangs; `-threads 6` aborts.
2. `RECYCLE_AFTER_RUNS = 12`: after a few dozen runs in one worker, jobs hang and filters read uninitialised memory (vibrato produced NaN on run 29; an OGG encode hung on run 44).
3. Wall-clock watchdog `DEFAULT_TIMEOUT_MS`: ffmpeg's own timeout doesn't fire when the mt core deadlocks; cancel works only by terminating the worker.
4. mt → st fallback: iOS Safari refuses the fixed 1 GB shared heap.
5. `ffprobe` returns -1 even after writing a complete report.
6. OOM on longer/higher-res clips (`isOutOfMemory`, `clipLimits.js`); output is fully buffered in the wasm heap, then copied out by `readFile`.
7. Core download is ~30 MB per mode and includes codecs/filters FinalCut never calls.

Read first: `src/wasm/ffmpegHost.js`, `src/wasm/ffmpegEngine.js`, `src/wasm/ops/*.js`, `src/wasm/clipLimits.js`, `scripts/copy-ffmpeg-core.mjs`, `scripts/fetch-ffmpeg-source.mjs`, `scripts/generate-wasm-capabilities.mjs`, `vendor/ffmpeg-source.lock.json`, `docs/web-ffmpeg-plan.md`, `docs/DECISIONS.md` (D6–D8: catalog, pinned versions, GPL Corresponding Source served next to the wasm).

## Goal

A maintained fork that removes those workarounds and makes in-browser edits faster and able to handle bigger clips, while `ffmpegHost.js` keeps roughly its current shape (keep the `@ffmpeg/ffmpeg` 0.12 message API compatible so the host change is small).

## Phase 0 — Benchmark harness first (FinalCut repo, no fork changes yet)

Build `tests/bench/wasm-bench.mjs` (Playwright, headless Chromium + WebKit + Firefox) that loads a given core and records, per op: load time, exec time, peak `performance.measureUserAgentSpecificMemory()` where available, success/hang/crash. Ops: 1080p 60 s H.264 trim (stream copy), 1080p re-encode libx264 `veryfast`, `xfade` join of 3 clips, burn ASS subtitles, audio `loudnorm`, thumbnail, ffprobe, and a 60-run soak in one worker. Fixtures in `tests/fixtures/bench/` (generate them with ffmpeg lavfi, don't commit large binaries). Record a baseline for core 0.12.10 st and mt in `docs/wasm-bench-baseline.md`. Every later phase must report against it; don't claim speedups without numbers.

## Phase 1 — Reproducible modern toolchain (fork)

- Bump emsdk to current 4.x; FFmpeg to the latest 7.1.x or 8.0.x release (match the server's major version if practical so the catalog converges). Note: FFmpeg ≥ 6.1's CLI is itself multithreaded, which is why upstream stayed on 5.1. For the mt core this is fine. For the st core, decide with measurements between (a) keeping a 5.1 st build, (b) patching fftools for single-thread operation, or (c) dropping st and using a small-pool mt build everywhere isolation exists, with st 5.1 only as the non-isolated fallback. Write the decision into `docs/DECISIONS.md`.
- Port the fork's patched `src/fftools` to the new FFmpeg; keep the exit/re-entry patches, and fix ffprobe's exit code.
- Pin every library by commit + sha256 in the fork, and regenerate FinalCut's `vendor/ffmpeg-source.lock.json` + `/v2/vendor/ffmpeg/source/` so GPL Corresponding Source stays exact (D8).
- CI in the fork: Docker build of st and mt, publish to npm under the new scope, attach build manifest.

## Phase 2 — Memory and threads

- mt: replace fixed 1 GB with `-sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=<~128–256MB> -sMAXIMUM_MEMORY=4GB`; measure the growth-with-pthreads cost. Goal: iOS loads mt instead of falling back.
- `PTHREAD_POOL_SIZE` small (e.g. cores+2) with `PTHREAD_POOL_SIZE_STRICT=0` so load doesn't spawn 32 workers.
- Replace the `4-cores` x264 with upstream x264 (sliced/frame threads working); goal: remove `MAX_MT_THREADS` or raise it to `hardwareConcurrency`.
- Use `-fwasm-exceptions` / `-sSUPPORT_LONGJMP=wasm` if all target browsers pass the bench (check Safari versions FinalCut supports).

## Phase 3 — SIMD

- Keep `-msimd128`; add `-mrelaxed-simd` only behind a separate core variant if it measurably helps.
- Re-enable SIMD where a library has wasm or portable SIMD paths (zimg, libwebp; check what FFmpeg's own wasm SIMD code covers in the chosen release, e.g. HEVC decode). Check x264's status honestly: it has no wasm asm, so expect gains mainly from auto-vectorization, not from flipping `--disable-asm`.
- Report per-op deltas vs Phase 0. If SIMD gains are small, say so.

## Phase 4 — Reliability so FinalCut can drop workarounds

- Find and fix the per-run state leaks (globals in fftools not reset between `exec` calls, filter graphs not freed, uninitialised buffers). Goal: the 60-run soak passes in one worker so `RECYCLE_AFTER_RUNS` can go.
- Cooperative cancel: an `Atomics` flag in shared memory checked by FFmpeg's interrupt callback / main loop, so cancel doesn't need `terminate()` and a reload. Keep terminate as the last resort.
- Structured progress via `-progress pipe:` parsed in the worker, instead of log scraping.
- Wire `exec` timeout so it also works in mt.

## Phase 5 — I/O for bigger clips

- Keep WORKERFS for inputs. For outputs, add an OPFS-backed path (WASMFS OPFS backend, or a custom FS that writes through `createSyncAccessHandle` in the worker) so output streams to disk instead of the heap, then hand FinalCut a `File` from OPFS. Transfer, don't copy, any buffers that must cross to the main thread.
- Then revisit `clipLimits.js` defaults with bench numbers.

## Phase 6 — Smaller, purpose-built cores

- Generate a `--disable-everything` + explicit `--enable-*` configure from FinalCut's catalog (`scripts/generate-wasm-capabilities.mjs`, `src/wasm/ops/*`, `run_ffmpeg` allowlist) so the core contains exactly what FinalCut exposes. Keep a "full" variant for `run_ffmpeg` if needed, loaded lazily.
- Consider adding dav1d (AV1 decode). Serve `.wasm` brotli-compressed; report download size before/after.
- Regenerate the capability catalog from the new build so browser and server tool schemas match.

## Phase 7 — Optional, separate track: WebCodecs hybrid (FinalCut repo, not the fork)

For simple ops (trim, re-encode, resize, thumbnail) the largest speedup available is hardware decode/encode via WebCodecs plus a JS muxer, with ffmpeg.wasm kept for filter graphs, subtitles and anything WebCodecs can't do. Prototype one op (`trim` with re-encode) behind `?engine=webcodecs`, compare in the bench, and write up whether to expand. Do not start this until Phases 1–2 land.

## FinalCut changes when adopting the fork

- `package.json` + `scripts/copy-ffmpeg-core.mjs` `PINNED`: swap to the forked packages/versions.
- `src/wasm/ffmpegHost.js`: update `CORE_VERSION`/`FFMPEG_JS_VERSION`; remove or relax `MAX_MT_THREADS`, `RECYCLE_AFTER_RUNS`, the ffprobe exit-code workaround, and terminate-on-cancel — each only once the bench proves it safe; keep the mt→st fallback.
- `vendor/ffmpeg-source.lock.json`, `scripts/fetch-ffmpeg-source.mjs`, `/legal/licenses.html`: new components and versions.
- Capability catalog regenerated; `src/wasm/ops/*` checked for options renamed between FFmpeg 5.1 and 7/8 (e.g. `-vsync` → `-fps_mode`, channel-layout options).
- Tests: `npm test`, `npm run test:e2e:v2`, `npm run source:verify`, plus the new bench and soak.

## Working rules

- One phase per PR, each with bench numbers vs baseline in the description.
- Don't remove a FinalCut workaround without a test that would have caught the original failure.
- Keep the GPL source tarballs and lockfile exact for every shipped core.
- Stop and ask before: dropping the st core, changing COOP/COEP scope, or changing the license posture.
