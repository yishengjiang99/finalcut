# Handoff: ffmpeg.wasm fork for FinalCap

Written 2026-10-12. For whoever picks this up next (a person or a new Claude Code session) with
no memory of the work so far. The plan this follows is `docs/ffmpeg-wasm-fork-prompt.md`.

## Where things stand

The fork is built, tested locally and released. **The FinalCap web app still runs the old
`@ffmpeg/*` 0.12 packages.** The next job is switching the app over; nothing in `src/wasm/` or
`package.json` has been touched.

| Phase (from the plan) | Status |
|---|---|
| 0 Bench harness | Done. Runs locally, three browsers. |
| 1 Toolchain (emsdk 4.0.23, FFmpeg 8.0.1 mt / 5.1.10 st, pinned sources) | Done in the fork. FinalCut's source lockfile is **not** regenerated yet. |
| 2 Memory and threads | Done. |
| 3 SIMD | Done; gain is small (about 3% on HEVC decode). |
| 4 Reliability, cancel, timeout | Done. Progress via `-progress pipe:` was skipped (the existing progress callback was kept). |
| 5 OPFS output | Mount implemented and smoke-tested in Chromium only. Not wired into FinalCut; `clipLimits.js` not revisited. |
| 6 Smaller core | **Not done.** Needs a product decision (see Open decisions). |
| 7 WebCodecs | Not started. |
| Adoption in FinalCut | **Not started. This is the next step.** |

## Where everything is

| What | Where |
|---|---|
| Fork repo | `github.com/yishengjiang99/ffmpeg.wasm`, branch `main` at `38ba774` |
| Fork checkout on this Mac | `~/ffmpeg.wasm-phase1` (local branch `fork-main`, tracks the fork's `main`; remote is named `fork`) |
| Do not use | `~/ffmpeg.wasm`: upstream's `main` with the owner's own uncommitted edits. Leave it alone. |
| Release to install | `v0.13.0-finalcut.2`: three tarballs (`@ffmpeg/ffmpeg`, `@ffmpeg/core`, `@ffmpeg/core-mt`), installed by URL. Not on npm, by the owner's choice. |
| Decisions + adoption checklist | fork `docs/DECISIONS-finalcut.md`. **Read this first.** |
| Bench harness and results | FinalCut branch `phase0-wasm-bench` at `8bc7512`, checkout `~/finalcut-phase0`. Not merged into `main`. Results: `docs/wasm-bench-local.md` on that branch. |
| Explainer video | `docs/ffmpeg-wasm-explainer.html` + `.mp4` + `.vtt` on FinalCut `main`; sources and `build.sh` in `~/ffmpeg-wasm-explainer/`; a copy of the mp4 in the fork under `media/` |
| Blog post | `blog/finalcap-ffmpeg-wasm-threads/index.md` on `main`, live at grepawk.com/blog/finalcap-ffmpeg-wasm-threads |

## How to run things

Everything runs locally. The owner does not want builds or benches on GitHub Actions; the
fork's `core-build.yml` is manual-only for that reason.

```sh
# Fork (~/ffmpeg.wasm-phase1). Needs Docker and Node; `npm ci` at the root once.
scripts/ci-local.sh              # lock check, build mt + st in Docker, manifest, Chromium smoke test
SKIP_BUILD=1 scripts/ci-local.sh # manifest + smoke on the existing build
scripts/pack-local.sh            # tarballs for a release -> .ci-local/packs/
node tests/finalcut-smoke/debug.mjs packages/core-mt/dist/esm 30000 8 -- -f lavfi -i ...
#   one ffmpeg command in Chromium; "8" emulates 8 cores (0 = real); FILES=a.mp4,b.mp4 adds inputs

# FinalCut bench (~/finalcut-phase0). Needs a native ffmpeg for fixtures.
tests/bench/run-local.sh baseline                                        # 0.12.10 from node_modules
tests/bench/run-local.sh fork --core-root ~/ffmpeg.wasm-phase1/packages  # the fork build
```

First Docker build: about 4.5 min per core on the M4 Pro. A change to `bind.js` only rebuilds
the link step (about 30 s); a change to `build/ffmpeg.sh` or a library rebuilds FFmpeg (about
2 min). A full bench takes about 15 min when nothing hangs.

## What was found (the short version)

1. **mt hangs were pthread-pool exhaustion.** ffmpeg ran on the module's main thread and
   blocked it, so no thread beyond the 32 pooled ones could start. It only shows on 8+ core
   machines, which is why GitHub's 4-vCPU runners passed. Fix: each job runs on its own pthread.
   Side effect: the mt core's `exec` is async, so **the mt core only works with the fork's
   `@ffmpeg/ffmpeg`**.
2. **x264 beyond 4 threads crashed on a function-signature mismatch** that WebAssembly traps on.
   Patched in `build/x264.sh`, on upstream x264. The encoder now scales: 10 s of 1080p takes
   3.9 s at 4 threads and 1.6 s at 14.
3. **The "state leak after N runs" was FFmpeg's `vibrato` filter reading an uninitialised
   buffer.** Patched in `build/ffmpeg.sh`. The 60-run soak passes on both cores.
4. **WebKit hung intermittently** until the core stopped using `Atomics.waitAsync` outside
   Chromium.
5. `ffprobe` exits 0; `cancel()` works on mt; the mt heap grows from 256 MB instead of a fixed 1 GB.

Numbers and the full table are in `docs/wasm-bench-local.md` on `phase0-wasm-bench`. They are
single runs on one machine (Apple M4 Pro, 14 cores).

## Next step: adopt the fork in FinalCut

Work on a new branch off `main`. The checklist is in the fork's `docs/DECISIONS-finalcut.md`;
the FinalCut files involved are:

- `package.json` and `scripts/copy-ffmpeg-core.mjs` (`PINNED`): point the three packages at the
  release tarball URLs. The copy script checks exact versions and expects a
  `ffmpeg-core.worker.js` for mt; that file no longer exists.
- `src/wasm/ffmpegHost.js`: `CORE_VERSION`, `FFMPEG_JS_VERSION`, then the workarounds
  (`MAX_MT_THREADS`, `RECYCLE_AFTER_RUNS`, the ffprobe exit-code handling, terminate-on-cancel).
  The plan's rule stands: remove a workaround only together with a test that would have caught
  the original failure. Keep the watchdog and the mt → st fallback.
- `server/ffmpeg/wasm-capabilities.json` via `scripts/generate-wasm-capabilities.mjs`: the mt
  core is FFmpeg 8.0.1 and the st core is 5.1.10, so the catalog now differs per core. The
  script and its consumer (`src/server/v2.js`) assume one catalog.
- `src/wasm/ops/*.js`: check options renamed between FFmpeg 5.1 and 8 on the mt path (the plan
  names `-vsync` → `-fps_mode` and channel-layout options). Not audited yet.
- `vendor/ffmpeg-source.lock.json`, `scripts/fetch-ffmpeg-source.mjs`, `/legal/licenses.html`:
  regenerate from the fork's `build/sources.lock.json` (decision D8: exact corresponding source
  served next to the wasm). The fork patches sources in its build scripts, so the recipe is part
  of the corresponding source.
- Tests to run: `npm test`, `npm run test:e2e:v2`, `npm run source:verify`, then the bench.
- Merge `phase0-wasm-bench` into `main` at some point; it only adds `tests/bench/`, docs and a
  `.gitignore` line.

## Open decisions (the owner's call)

- **Slim core (Phase 6).** Download size is on par with 0.12.10 (mt: 8.9 MB brotli against
  8.4 MB). Dropping x265 alone saves about 0.5 MB compressed. A real cut means choosing which
  filters and codecs the free-form `run_ffmpeg` tool loses.
- **`-cpucount 4` default on mt.** Kept because more decoder and filter threads used more memory
  without making the bench faster. It does not limit x264.
- The plan says to stop and ask before dropping the st core, changing COOP/COEP scope, or
  changing the license posture. None of those was done.

## Not verified

- **Real Safari and iPhone.** All WebKit results are from Playwright's desktop WebKit. Whether
  iOS loads the mt core with the growable heap is unknown, and it was the reason for the
  mt → st fallback.
- The OPFS mount in WebKit and Firefox.
- The explainer's synthesized voice-over has not been listened to by anyone.
- Linux and Windows hosts, and any machine other than this one.

## Things that will trip you up

- **Pushing FinalCut `main` deploys production** (workflow "Deploy grepawk.com"). Blog-only
  pushes follow `blog/AGENTS.md`.
- **The blog lint rejects the string "finalcut" anywhere in a post, URLs included.** Say
  FinalCap; link the fork repo, not this one.
- **Playwright's Firefox does not launch from Claude Code's sandboxed shell on macOS.**
  `run-local.sh` runs Firefox in the Playwright Docker image by default (`FIREFOX=host` to try
  the host).
- The bench's "peak MB" column over-reports the mt core's grown shared heap. Compare it only
  between st rows.
- The bench fixtures need DejaVu Sans; `make-fixtures.mjs` downloads a checksum-pinned copy
  when the Debian path is missing.
- Run the fork's smoke test on a many-core machine. A 4-core run proves little about threads.
- The fork's tarball URLs for x264 (videolan GitLab archive) and the `codeload.github.com`
  ones are generated on request; if their bytes ever change, the checksum fails loudly and the
  tarball has to be re-verified against the commit.
