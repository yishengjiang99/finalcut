# ffmpeg.wasm bench: running it locally

The bench and the fork's core build both run on a dev machine; nothing here needs GitHub
Actions. The numbers in `docs/wasm-bench-baseline.md` came from an 8-core Linux CI host and are
not comparable with a laptop, so each machine records its own 0.12.10 baseline and compares the
fork against that.

## Commands

```sh
# FinalCut repo: bench (Chromium + WebKit on the host, Firefox in the Playwright Docker image)
tests/bench/run-local.sh baseline                                        # cores from node_modules (0.12.10)
tests/bench/run-local.sh phase1 --core-root ~/ffmpeg.wasm-phase1/packages  # locally built fork cores
# results: test-results/bench/<label>/*.json + report.md
# options: BROWSERS="chromium" MODES="mt" FIREFOX=docker|host|skip, plus wasm-bench flags (--ops a,b --soak-runs 10)

# Fork repo: what core-build.yml did on GitHub (lock check, Docker build, manifest, smoke)
scripts/ci-local.sh            # mt then st -> packages/core-mt/dist, packages/core/dist
SKIP_BUILD=1 scripts/ci-local.sh mt
node tests/finalcut-smoke/debug.mjs packages/core-mt/dist/esm 30000 8 -- -i ...   # one command, emulating 8 cores
```

Needs Docker, Node, a native `ffmpeg` (fixtures) and `npx playwright install chromium webkit`.
The first Docker build takes about 4.5 min per core on an M4 Pro (native arm64 emsdk image);
rebuilds after a source change reuse BuildKit's cache (about 30 s for a `bind.js` change). A full
bench of one core set takes about 25 min, most of it the 300 s timeouts of ops that hang.

## Results on this machine (2026-10-12)

Apple M4 Pro, 14 cores, 24 GB, macOS 27.0.1. Chromium 153 and WebKit 26.6 on the host; Firefox
155 in the Linux container (Docker VM: 14 CPUs, 7.6 GB). One run per row. Fork = `phase1-toolchain`
at 2270326 plus the `-cpucount` cap described below. Raw JSON: `docs/wasm-bench/local-m-series-14core/`.

| browser | core | op | 0.12.10 | fork phase 1 |
|---|---|---|---|---|
| chromium | mt | trim_copy | 358 ms | 1108 ms |
| chromium | mt | x264_veryfast | 5344 ms | 4187 ms |
| chromium | mt | xfade_join3 | hang | hang |
| chromium | mt | burn_ass | 2581 ms | 2168 ms |
| chromium | mt | loudnorm | 1368 ms | 2673 ms |
| chromium | mt | thumbnail | hang | 409 ms |
| chromium | mt | ffprobe | 292 ms, exit -1 | 287 ms, exit 0 |
| chromium | mt | soak60 | 4/60 (crash) | 9/60 (fail) |
| chromium | st | trim_copy | 344 ms | 340 ms |
| chromium | st | x264_veryfast | 13.7 s | 11.1 s |
| chromium | st | xfade_join3 | 14.2 s | 12.0 s |
| chromium | st | burn_ass | 6789 ms | 5438 ms |
| chromium | st | loudnorm | 1372 ms | 1342 ms |
| chromium | st | thumbnail | 313 ms | 308 ms |
| chromium | st | ffprobe | 277 ms, exit -1 | 278 ms, exit 0 |
| chromium | st | soak60 | 1/60 (crash) | 1/60 (crash) |
| firefox | mt | trim_copy | 115 ms | 1320 ms |
| firefox | mt | x264_veryfast | 5617 ms | 5023 ms |
| firefox | mt | xfade_join3 | 4457 ms | 3347 ms |
| firefox | mt | burn_ass | 2561 ms | 2508 ms |
| firefox | mt | loudnorm | 1413 ms | 3501 ms |
| firefox | mt | thumbnail | 199 ms | 155 ms |
| firefox | mt | ffprobe | 15 ms, exit -1 | 14 ms, exit 0 |
| firefox | mt | soak60 | 3/60 (crash) | 6/60 (fail) |
| firefox | st | trim_copy | 124 ms | 128 ms |
| firefox | st | x264_veryfast | 14.3 s | 12.9 s |
| firefox | st | xfade_join3 | 15.2 s | 14.2 s |
| firefox | st | burn_ass | 7096 ms | 6368 ms |
| firefox | st | loudnorm | 1425 ms | 1414 ms |
| firefox | st | thumbnail | 48 ms | 46 ms |
| firefox | st | ffprobe | 15 ms, exit -1 | 15 ms, exit 0 |
| firefox | st | soak60 | 1/60 (crash) | 1/60 (crash) |
| webkit | mt | trim_copy | 165 ms | 935 ms |
| webkit | mt | x264_veryfast | 5076 ms | 4551 ms |
| webkit | mt | xfade_join3 | hang | hang |
| webkit | mt | burn_ass | 2288 ms | 2200 ms |
| webkit | mt | loudnorm | 1304 ms | 2677 ms |
| webkit | mt | thumbnail | 73 ms | 156 ms |
| webkit | mt | ffprobe | 24 ms, exit -1 | 26 ms, exit 0 |
| webkit | mt | soak60 | 2/60 (crash) | 21/60 (fail) |
| webkit | st | trim_copy | 153 ms | 151 ms |
| webkit | st | x264_veryfast | 13.0 s | 11.8 s |
| webkit | st | xfade_join3 | 13.6 s | 12.8 s |
| webkit | st | burn_ass | 6349 ms | 5785 ms |
| webkit | st | loudnorm | 1307 ms | 1295 ms |
| webkit | st | thumbnail | 55 ms | 55 ms |
| webkit | st | ffprobe | 23 ms, exit -1 | 22 ms, exit 0 |
| webkit | st | soak60 | 1/60 (crash) | 1/60 (crash) |

## What the local run shows

- **A many-core host finds hangs that 4-vCPU runners cannot.** The fork's mt core (FFmpeg 8.0.1)
  hung on its first x264 encode here although the same commit passed on GitHub. FFmpeg sizes its
  automatic thread pools from the CPU count; the tools run on the module's main thread, which
  blocks during a job, so a `pthread_create` beyond `PTHREAD_POOL_SIZE=32` never gets a Worker.
  Emulating core counts: 4 passes, 8 and 12 hang. The fork now passes `-cpucount 4` by default
  on mt. This is a stopgap; the Phase 2 pool work should replace it.
- The same cause explains core-mt 0.12.10's **thumbnail hang on Chromium** here (14 decoder
  threads); the fork's cap fixes that row.
- **ffprobe exits 0** on both fork cores (was -1).
- **mt `xfade_join3` still hangs** on Chromium and WebKit with the fork (it completes on Firefox),
  so the watchdog stays.
- **Soak still fails**, on st too: run 2 gets NaN from `vibrato` on every browser here (CI's st
  passed 60/60, with fixtures from a different native ffmpeg). `RECYCLE_AFTER_RUNS` stays; this
  is Phase 4's target.
- Fork vs 0.12.10: st encodes are 10–20% faster (x264 13.7 → 11.1 s in Chromium), mt x264 about
  10–20% faster. **mt got slower on short jobs**: stream-copy trim 0.36 → 1.1 s and loudnorm
  1.4 → 2.7 s in Chromium. Not investigated yet; FFmpeg 8's threaded CLI is the likely cause.
