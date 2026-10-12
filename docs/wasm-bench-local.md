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
All rows except `x264_auto_threads` run x264 with `-threads 4` on mt, as `ffmpegHost` does today.

| browser | core | op | 0.12.10 | fork as GitHub CI left it (2270326) | fork v0.13.0-finalcut.2 |
|---|---|---|---|---|---|
| chromium | mt | trim_copy | 358 ms | 1108 ms | 354 ms |
| chromium | mt | x264_veryfast | 5344 ms | 4187 ms | 4105 ms |
| chromium | mt | xfade_join3 | **hang** | **hang** | 2825 ms |
| chromium | mt | burn_ass | 2581 ms | 2168 ms | 2048 ms |
| chromium | mt | loudnorm | 1368 ms | 2673 ms | 1003 ms |
| chromium | mt | thumbnail | **hang** | 409 ms | 374 ms |
| chromium | mt | ffprobe | 292 ms, exit -1 | 287 ms, exit 0 | 282 ms, exit 0 |
| chromium | mt | soak60 | 4/60 (crash) | 9/60 (fail) | 60/60 |
| chromium | st | trim_copy | 344 ms | 340 ms | 339 ms |
| chromium | st | x264_veryfast | 13.7 s | 11.1 s | 11.3 s |
| chromium | st | xfade_join3 | 14.2 s | 12.0 s | 12.3 s |
| chromium | st | burn_ass | 6789 ms | 5438 ms | 5625 ms |
| chromium | st | loudnorm | 1372 ms | 1342 ms | 1366 ms |
| chromium | st | thumbnail | 313 ms | 308 ms | 311 ms |
| chromium | st | ffprobe | 277 ms, exit -1 | 278 ms, exit 0 | 280 ms, exit 0 |
| chromium | st | soak60 | 1/60 (crash) | 1/60 (crash) | 60/60 |
| firefox | mt | trim_copy | 115 ms | 1320 ms | 133 ms |
| firefox | mt | x264_veryfast | 5617 ms | 5023 ms | 4963 ms |
| firefox | mt | xfade_join3 | 4457 ms | 3347 ms | 3416 ms |
| firefox | mt | burn_ass | 2561 ms | 2508 ms | 2333 ms |
| firefox | mt | loudnorm | 1413 ms | 3501 ms | 1012 ms |
| firefox | mt | thumbnail | 199 ms | 155 ms | 179 ms |
| firefox | mt | ffprobe | 15 ms, exit -1 | 14 ms, exit 0 | 17 ms, exit 0 |
| firefox | mt | soak60 | 3/60 (crash) | 6/60 (fail) | 60/60 |
| firefox | st | trim_copy | 124 ms | 128 ms | 116 ms |
| firefox | st | x264_veryfast | 14.3 s | 12.9 s | 13.5 s |
| firefox | st | xfade_join3 | 15.2 s | 14.2 s | 14.9 s |
| firefox | st | burn_ass | 7096 ms | 6368 ms | 6619 ms |
| firefox | st | loudnorm | 1425 ms | 1414 ms | 1451 ms |
| firefox | st | thumbnail | 48 ms | 46 ms | 50 ms |
| firefox | st | ffprobe | 15 ms, exit -1 | 15 ms, exit 0 | 17 ms, exit 0 |
| firefox | st | soak60 | 1/60 (crash) | 1/60 (crash) | 60/60 |
| webkit | mt | trim_copy | 165 ms | 935 ms | 172 ms |
| webkit | mt | x264_veryfast | 5076 ms | 4551 ms | 4514 ms |
| webkit | mt | xfade_join3 | **hang** | **hang** | 2959 ms |
| webkit | mt | burn_ass | 2288 ms | 2200 ms | 2091 ms |
| webkit | mt | loudnorm | 1304 ms | 2677 ms | 781 ms |
| webkit | mt | thumbnail | 73 ms | 156 ms | 126 ms |
| webkit | mt | ffprobe | 24 ms, exit -1 | 26 ms, exit 0 | 25 ms, exit 0 |
| webkit | mt | soak60 | 2/60 (crash) | 21/60 (fail) | 60/60 |
| webkit | st | trim_copy | 153 ms | 151 ms | 146 ms |
| webkit | st | x264_veryfast | 13.0 s | 11.8 s | 12.4 s |
| webkit | st | xfade_join3 | 13.6 s | 12.8 s | 13.2 s |
| webkit | st | burn_ass | 6349 ms | 5785 ms | 6004 ms |
| webkit | st | loudnorm | 1307 ms | 1295 ms | 1315 ms |
| webkit | st | thumbnail | 55 ms | 55 ms | 55 ms |
| webkit | st | ffprobe | 23 ms, exit -1 | 22 ms, exit 0 | 22 ms, exit 0 |
| webkit | st | soak60 | 1/60 (crash) | 1/60 (crash) | 60/60 |
| chromium | mt | x264_auto_threads | not run (hangs without `-threads`) | not run | 1684 ms |
| firefox | mt | x264_auto_threads | not run (hangs without `-threads`) | not run | 2078 ms |
| webkit | mt | x264_auto_threads | not run (hangs without `-threads`) | not run | 1743 ms |

## What changed between the columns

All 48 rows pass on the fork release, plus the x264 automatic-threads row in three browsers.

- **mt deadlocks were pthread-pool exhaustion.** The tools ran on the module's main thread and
  blocked it, so a `pthread_create` beyond `PTHREAD_POOL_SIZE=32` never got its Worker. That
  hung the first x264 encode on any 8+ core machine (GitHub's 4-vCPU runners cannot see it),
  0.12.10's thumbnail in Chromium here, and the 3-clip `xfade` join at every CPU cap above 1.
  The fork runs each tool on its own pthread, so the main thread can start threads on demand.
  `exec`/`ffprobe` are async inside the core, so FinalCut must take the fork's `@ffmpeg/ffmpeg`
  build too (its worker awaits them; the message API is unchanged).
- **x264 beyond 4 threads was a signature bug.** `slicetype_slice_cost` is declared `void` but
  called through the thread pool's `void *(*)(void *)`; WebAssembly traps on that once x264 has
  more than one lookahead thread (about 6+ encoder threads). With the fix and upstream x264,
  10 s of 1080p veryfast takes 9.8 s on 1 thread, 3.9 s on 4, 2.3 s on 8, 1.6 s on 14
  (Chromium), and x264's own thread choice works: 1.7 s in the table, against 4.1 s at
  `-threads 4` and 5.3 s on core-mt 0.12.10.
- **The soak failure was not a per-run leak.** FFmpeg's `vibrato` reads its delay line before
  writing it (`av_malloc_array`, upstream bug). In a reused wasm heap that is stale data, hence
  NaN after a few jobs. The fork build zeroes it; 60/60 on both cores in every browser.
- **WebKit needed one more fix**: with the tool on a pthread, jobs hung intermittently (2 of 3
  soaks) until the core stopped using `Atomics.waitAsync` for mailbox wakeups outside Chromium.
  This is Playwright's WebKit; real Safari and iOS still need a manual check.
- **mt memory**: growable heap, 256 MB initial and 4 GB max, instead of a fixed 1 GB; 4
  pre-spawned Workers instead of 32. No measurable cost. The "peak MB" column over-reports a
  grown shared heap (the 3-clip join showed 1.0–2.9 GB in different runs; the heap itself was
  921 MB when read from inside the core), so compare it only between st rows.
- **ffprobe exits 0** (was -1).
- **SIMD**: FFmpeg 8's own WebAssembly SIMD (HEVC idct and SAO only) is now compiled in: 1080p
  HEVC decode 1.75 → 1.70 s. `-mrelaxed-simd` and wasm exceptions/longjmp measured no gain and
  were not adopted. The gains in this table come from threads.
- **New in the fork's API**: `cancel()` on mt (stops a job in under a second without a reload),
  an OPFS output mount (outputs on disk, not in memory), and `exec`'s timeout working on mt.
  All three are covered by the fork's smoke test, not by this bench.

## Still open

- Real Safari and iPhone: not tested. Whether iOS loads the mt core now is unverified.
- `clipLimits.js` was not revisited; that needs bigger clips and the OPFS mount wired into
  `ffmpegHost`.
- No slimmed core. Download size is on par with 0.12.10 (mt 31.9 MB raw, 8.9 MB brotli against
  32.7 / 8.4). See the fork's `docs/DECISIONS-finalcut.md` for why, and for the adoption checklist.
- The FinalCut-side tests required before removing `MAX_MT_THREADS`, `RECYCLE_AFTER_RUNS` and
  terminate-on-cancel are not written yet.
