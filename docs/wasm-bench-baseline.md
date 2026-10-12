# ffmpeg.wasm bench: baseline (core 0.12.10)

Phase 0 of the maintained-fork plan. Every later phase compares against these numbers; no
speedup is claimed without a row here.

- Cores: `@ffmpeg/core@0.12.10` (st) and `@ffmpeg/core-mt@0.12.10` (mt), FFmpeg n5.1.4, emsdk 3.1.40, through `@ffmpeg/ffmpeg@0.12.15`.
- Host: Linux, 8 cores, ~15 GB RAM, headless. Playwright 1.63: Chromium 153 (full build, not headless-shell; headless-shell refuses `measureUserAgentSpecificMemory`), WebKit 26.6. Firefox 155 installed; its rows are added in a follow-up commit if they are not in the table below.
- Page served by the harness with COOP/COEP, so both cores can load. mt jobs use `-threads 4` for x264, as `ffmpegHost` does (`MAX_MT_THREADS`).
- Run on 2026-10-12, one run per row (no averaging), with nothing else running on the machine.

## Reproduce

```sh
node tests/bench/make-fixtures.mjs        # lavfi fixtures -> tests/fixtures/bench/ (gitignored, ~55 MB)
node tests/bench/wasm-bench.mjs --browsers chromium --modes st --out test-results/bench/chromium-st.json
node tests/bench/report.mjs test-results/bench/*.json
```
`--core-root <dir>` benches another build (a dir with `core/dist/esm` and `core-mt/dist/esm`). Raw JSON for this baseline: `docs/wasm-bench/`.

## Ops

| op | input | command |
|---|---|---|
| trim_copy | 1080p30 60 s H.264+AAC (46 MB) | `-ss 10 -i in -t 20 -c copy` |
| x264_veryfast | same | first 10 s, `libx264 -preset veryfast` + aac |
| xfade_join3 | three 720p 5 s clips | `xfade` + `acrossfade` chain, libx264 veryfast |
| burn_ass | 720p 10 s | `subtitles=subs.ass:fontsdir=…` (DejaVu Sans), libx264 veryfast |
| loudnorm | 60 s audio of the 1080p clip | `loudnorm=I=-16:TP=-1.5:LRA=11` → aac |
| thumbnail | 1080p clip | `-ss 30 -frames:v 1 -vf scale=320:-2` jpg |
| ffprobe | 1080p clip | `-show_format -show_streams -of json -o probe.json` |
| soak60 | 240p 2 s | 60 runs in one fresh worker: `vibrato` + aac, libx264 ultrafast; stops at the first failure |

Inputs are mounted with WORKERFS as in `ffmpegHost`. Each op runs on a fresh page and a fresh
worker. Status: ok = exit 0 and output written (ffprobe: report written, since it exits -1);
hang = no result within the timeout (300 s for encodes, 60 s per soak run); crash = non-zero
exit with `Aborted()`, or a trap. Peak memory = the largest single context in
`performance.measureUserAgentSpecificMemory()`, sampled every 250 ms (Chromium only). The API's
total is not used: with mt every pthread worker reports the same shared 1 GB heap (total ≈ 33 GB).

## Results

| browser | core | op | status | load | exec | peak MB (one context) | notes |
|---|---|---|---|---|---|---|---|
| chromium 153.0.8010.12 | st | trim_copy | ok | 175 ms | 671 ms | 48 |  |
| chromium 153.0.8010.12 | st | x264_veryfast | ok | 113 ms | 28.2 s | 214 |  |
| chromium 153.0.8010.12 | st | xfade_join3 | ok | 165 ms | 29.2 s | 500 |  |
| chromium 153.0.8010.12 | st | burn_ass | ok | 149 ms | 13.6 s | 121 |  |
| chromium 153.0.8010.12 | st | loudnorm | ok | 122 ms | 3000 ms | 118 |  |
| chromium 153.0.8010.12 | st | thumbnail | ok | 135 ms | 391 ms | 34 |  |
| chromium 153.0.8010.12 | st | ffprobe | ok | 115 ms | 309 ms | 34 | exit code -1 |
| chromium 153.0.8010.12 | st | soak60 | ok | 110 ms | 24.7 s | 34 | 60/60 runs ok, median 406 ms/run |
| chromium 153.0.8010.12 | mt | trim_copy | ok | 296 ms | 660 ms | 1040 |  |
| chromium 153.0.8010.12 | mt | x264_veryfast | ok | 283 ms | 10.6 s | 1031 |  |
| chromium 153.0.8010.12 | mt | xfade_join3 | hang | 315 ms | 300.0 s | – | timeout 300000 ms |
| chromium 153.0.8010.12 | mt | burn_ass | ok | 323 ms | 4813 ms | 1030 |  |
| chromium 153.0.8010.12 | mt | loudnorm | ok | 285 ms | 2757 ms | 1027 |  |
| chromium 153.0.8010.12 | mt | thumbnail | ok | 290 ms | 402 ms | 1026 |  |
| chromium 153.0.8010.12 | mt | ffprobe | ok | 280 ms | 318 ms | 1026 | exit code -1 |
| chromium 153.0.8010.12 | mt | soak60 | crash | 325 ms | 1865 ms | 1026 | 4/60 runs ok, median 355 ms/run; run 5 crash: [aac @ 0xebd480] Input contains (near) NaN/+-Inf |
| webkit 26.6 | st | trim_copy | ok | 264 ms | 358 ms | – |  |
| webkit 26.6 | st | x264_veryfast | ok | 317 ms | 31.5 s | – |  |
| webkit 26.6 | st | xfade_join3 | ok | 372 ms | 32.5 s | – |  |
| webkit 26.6 | st | burn_ass | ok | 332 ms | 14.7 s | – |  |
| webkit 26.6 | st | loudnorm | ok | 339 ms | 2927 ms | – |  |
| webkit 26.6 | st | thumbnail | ok | 311 ms | 111 ms | – |  |
| webkit 26.6 | st | ffprobe | ok | 323 ms | 39 ms | – | exit code -1 |
| webkit 26.6 | st | soak60 | ok | 269 ms | 9309 ms | – | 60/60 runs ok, median 151 ms/run |
| webkit 26.6 | mt | trim_copy | ok | 360 ms | 387 ms | – |  |
| webkit 26.6 | mt | x264_veryfast | ok | 349 ms | 10.9 s | – |  |
| webkit 26.6 | mt | xfade_join3 | crash | – | – | – | page: page.evaluate: Target page, context or browser has been closed |

## What the baseline shows

- **xfade join of 3 clips hangs on mt** (Chromium: no output after 300 s; st: 29 s). Every bench run so far reproduced it, including an earlier run with a 900 s timeout. This is the mt deadlock that `DEFAULT_TIMEOUT_MS` covers.
- **mt soak fails on run 5**: aac gets NaN input from `vibrato` (`Input contains (near) NaN/+-Inf`), in a worker that has only run this job. st completed 60/60. This is the per-run state leak behind `RECYCLE_AFTER_RUNS = 12`; on mt the leak shows well before 12 runs with this filter.
- **ffprobe exits -1** on both cores, even with a complete report.
- **mt is faster where it works**: x264 re-encode 10.6 s vs 28.2 s (2.7×), subtitle burn 4.8 s vs 13.6 s (2.8×). Stream copy, loudnorm, thumbnail and ffprobe are about the same.
- **mt memory floor is ~1 GB** (fixed heap) for every op; st ranges from 34 MB (probe/thumbnail) to 500 MB (xfade of three 720p clips).
- Load is ~0.1–0.3 s (cores served locally, so this is compile/instantiate, not download).

Each item above is a check for a later phase. A workaround is removed only when its row turns green here.
