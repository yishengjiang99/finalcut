# ffmpeg.wasm bench: running it locally

The bench and the fork's core build both run on a dev machine; nothing here needs GitHub
Actions. The numbers in `docs/wasm-bench-baseline.md` came from an 8-core Linux CI host and are
not comparable with a laptop, so each machine records its own 0.12.10 baseline and compares the
fork against that.

## Commands

```sh
# FinalCut repo: bench (Chromium + WebKit on the host, Firefox in the Playwright Docker image)
tests/bench/run-local.sh baseline                                        # cores from node_modules (0.12.10)
tests/bench/run-local.sh fork --core-root ~/ffmpeg.wasm-phase1/packages    # locally built fork (cores + its @ffmpeg/ffmpeg)
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
155 in the Linux container (Docker VM: 14 CPUs, 7.6 GB). One run per row. Raw JSON:
`docs/wasm-bench/local-m-series-14core/`. The middle column is the fork exactly as it passed on
GitHub plus a `-cpucount 4` default (without that its mt core hung on the first encode here).

| browser | core | op | 0.12.10 | fork, as CI left it (2270326) | fork main (ebcd330) |
|---|---|---|---|---|---|
| chromium | mt | trim_copy | 358 ms | 1108 ms | 355 ms |
| chromium | mt | x264_veryfast | 5344 ms | 4187 ms | 4092 ms |
| chromium | mt | xfade_join3 | **hang** | **hang** | 2780 ms |
| chromium | mt | burn_ass | 2581 ms | 2168 ms | 2011 ms |
| chromium | mt | loudnorm | 1368 ms | 2673 ms | 977 ms |
| chromium | mt | thumbnail | **hang** | 409 ms | 315 ms |
| chromium | mt | ffprobe | 292 ms, exit -1 | 287 ms, exit 0 | 286 ms, exit 0 |
| chromium | mt | soak60 | 4/60 (crash) | 9/60 (fail) | 60/60 |
| chromium | st | trim_copy | 344 ms | 340 ms | 344 ms |
| chromium | st | x264_veryfast | 13.7 s | 11.1 s | 11.2 s |
| chromium | st | xfade_join3 | 14.2 s | 12.0 s | 12.2 s |
| chromium | st | burn_ass | 6789 ms | 5438 ms | 5533 ms |
| chromium | st | loudnorm | 1372 ms | 1342 ms | 1342 ms |
| chromium | st | thumbnail | 313 ms | 308 ms | 309 ms |
| chromium | st | ffprobe | 277 ms, exit -1 | 278 ms, exit 0 | 278 ms, exit 0 |
| chromium | st | soak60 | 1/60 (crash) | 1/60 (crash) | 60/60 |
| firefox | mt | trim_copy | 115 ms | 1320 ms | 133 ms |
| firefox | mt | x264_veryfast | 5617 ms | 5023 ms | 4867 ms |
| firefox | mt | xfade_join3 | 4457 ms | 3347 ms | 3279 ms |
| firefox | mt | burn_ass | 2561 ms | 2508 ms | 2241 ms |
| firefox | mt | loudnorm | 1413 ms | 3501 ms | 937 ms |
| firefox | mt | thumbnail | 199 ms | 155 ms | 54 ms |
| firefox | mt | ffprobe | 15 ms, exit -1 | 14 ms, exit 0 | 18 ms, exit 0 |
| firefox | mt | soak60 | 3/60 (crash) | 6/60 (fail) | 60/60 |
| firefox | st | trim_copy | 124 ms | 128 ms | 125 ms |
| firefox | st | x264_veryfast | 14.3 s | 12.9 s | 13.4 s |
| firefox | st | xfade_join3 | 15.2 s | 14.2 s | 14.8 s |
| firefox | st | burn_ass | 7096 ms | 6368 ms | 6623 ms |
| firefox | st | loudnorm | 1425 ms | 1414 ms | 1446 ms |
| firefox | st | thumbnail | 48 ms | 46 ms | 47 ms |
| firefox | st | ffprobe | 15 ms, exit -1 | 15 ms, exit 0 | 15 ms, exit 0 |
| firefox | st | soak60 | 1/60 (crash) | 1/60 (crash) | 60/60 |
| webkit | mt | trim_copy | 165 ms | 935 ms | 176 ms |
| webkit | mt | x264_veryfast | 5076 ms | 4551 ms | 4489 ms |
| webkit | mt | xfade_join3 | **hang** | **hang** | 2915 ms |
| webkit | mt | burn_ass | 2288 ms | 2200 ms | 2072 ms |
| webkit | mt | loudnorm | 1304 ms | 2677 ms | 751 ms |
| webkit | mt | thumbnail | 73 ms | 156 ms | 79 ms |
| webkit | mt | ffprobe | 24 ms, exit -1 | 26 ms, exit 0 | 28 ms, exit 0 |
| webkit | mt | soak60 | 2/60 (crash) | 21/60 (fail) | 60/60 |
| webkit | st | trim_copy | 153 ms | 151 ms | 152 ms |
| webkit | st | x264_veryfast | 13.0 s | 11.8 s | 12.3 s |
| webkit | st | xfade_join3 | 13.6 s | 12.8 s | 13.1 s |
| webkit | st | burn_ass | 6349 ms | 5785 ms | 5898 ms |
| webkit | st | loudnorm | 1307 ms | 1295 ms | 1311 ms |
| webkit | st | thumbnail | 55 ms | 55 ms | 55 ms |
| webkit | st | ffprobe | 23 ms, exit -1 | 22 ms, exit 0 | 22 ms, exit 0 |
| webkit | st | soak60 | 1/60 (crash) | 1/60 (crash) | 60/60 |

## What changed between the columns

All 48 rows pass on fork main; the mt soak also passed in 3 extra runs each on Chromium and WebKit.

- **mt deadlocks were pthread-pool exhaustion.** The tools ran on the module's main thread and
  blocked it, so a `pthread_create` beyond `PTHREAD_POOL_SIZE=32` never got its Worker. That
  hung the first x264 encode on any 8+ core machine (GitHub's 4-vCPU runners cannot see it),
  0.12.10's thumbnail in Chromium here, and the 3-clip `xfade` join at every CPU cap above 1.
  The fork now runs each tool on its own pthread, so the main thread can start threads on
  demand. `exec`/`ffprobe` are async inside the core, so FinalCut must take the fork's
  `@ffmpeg/ffmpeg` build too (its worker awaits them; the message API is unchanged).
- **The soak failure was not a per-run leak.** FFmpeg's `vibrato` reads its delay line before
  writing it (`av_malloc_array`, upstream bug). In a reused wasm heap that is stale data, hence
  NaN after a few jobs. The fork build zeroes it; 60/60 on both cores in every browser.
- **WebKit needed one more fix**: with the tool on a pthread, jobs hung intermittently (2 of 3
  soaks) until the core stopped using `Atomics.waitAsync` for mailbox wakeups outside Chromium.
  This is Playwright's WebKit; real Safari and iOS still need a manual check.
- **ffprobe exits 0** (was -1).
- **Speed vs 0.12.10**: the mt `xfade` join takes about 3 s (it hung on Chromium and WebKit; st takes 12–15 s), mt
  x264 is 10–25% faster, mt loudnorm 30–40% faster, st encodes 5–20% faster.

## Still open

- mt memory is still a fixed 1 GB heap. `-cpucount 4` stays as a default because frame threads
  hold frames in it: the 720p `xfade` join runs out of memory at 8 "CPUs" and passes at 6. A
  crash on any thread now fails the job at once instead of hanging.
- x264 with automatic threads (no `-threads`) still fails on mt, so `MAX_MT_THREADS` stays.
- `RECYCLE_AFTER_RUNS` and the watchdog: the rows that justified them are green here, but the
  FinalCut-side tests the plan requires before removing them are not written yet.
