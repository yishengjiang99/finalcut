# FinalCut web: move all FFmpeg work into the browser (ffmpeg.wasm)

Status: **plan approved, spike in progress** on branch `web-ffmpeg-wasm-spike` (PR to `main`, not merged, not deployed). Research was done read-only on 2026-10-09 (PT) against `yishengjiang99/finalcut@main`, the earlier history in `yishengjiang99/pages` (`finalcut/` subfolder), and the live headers on https://grepawk.com. Decisions taken on 2026-10-09 are logged in [`docs/DECISIONS.md`](DECISIONS.md) and summarised in §0; where they differ from the original research text below, §0 wins and the affected sections have been updated.

---

## 0. Decisions and constraints (2026-10-09)

| # | Topic | Decision |
|---|---|---|
| D1 | **Hard constraint: don't break iOS** | The new editor lives on **new routes only**: the page at `/v2/`, new APIs under `/api/v2/...`. Every existing endpoint (`/api/*`, `/auth/*`) and the current web editor at `/` stay byte-for-byte unchanged in behaviour. COOP/COEP/CORP and the `application/wasm` MIME type are scoped to `/v2/` only (`nginx/finalcut-v2.locations.conf`). A contract test for the iOS-facing endpoints (`tests/contract/ios-endpoints.mjs`) runs in CI (base vs PR) and before and after every deploy. The main web entry (`/`) switches to the new editor only after the e2e suite passes on production; the old editor then stays reachable as a fallback route. |
| D2 | Captions | Default is **on-device Whisper** (transformers.js, `tiny`/`base`, WebGPU with WASM fallback, lazy-loaded on first use and cached). Cloud transcription is an explicit **opt-in, off by default**: "Use cloud transcription for better accuracy, uploads audio only". Bilingual translation may call Grok with **text only**. |
| D3 | Clip limits | Desktop: soft warning above 1 GB, hard block above ~1.8 GB. Mobile/Safari: soft warning above 300 MB, hard block above 500 MB. Warn above ~10 min of 1080p. Defaults ship in `src/wasm/clipLimits.js`; the server can override them through the capability catalog (`limits.clip`). |
| D4 | Licensing | The GPL core (x264/x265) is OK. `/legal/licenses.html` lists FFmpeg, ffmpeg.wasm and x264 (plus the other compiled-in libraries) with exact versions and source-tag links, and is linked from the new editor's footer. |
| D8 | GPL source (Chief of Staff, 2026-10-09; amends D4) | **No written offer.** The Corresponding Source is hosted on the same origin next to the wasm at `/v2/vendor/ffmpeg/source/`: the ffmpeg.wasm build recipe at the core 0.12.10 release commit (`71aa99d3`) and exact archives of FFmpeg 5.1.4 and every bundled library (x264, x265, libvpx, LAME, Ogg, Theora, Opus, Vorbis, zlib, libwebp, FreeType, FriBidi, HarfBuzz, libass, zimg, SDL2, Emscripten 3.1.40), plus `SHA256SUMS`, `versions.json` and the license texts. The archives are fetched and verified at build time by `scripts/fetch-ffmpeg-source.mjs` against the checksums pinned in `vendor/ffmpeg-source.lock.json`. A mismatch fails the build. |
| D5 | Missing tools | The 11 audio-effect tools with no web implementation (§3.1) are fixed during the port. |
| D6 | Capability catalog | The server keeps a full JSON catalog of the wasm FFmpeg build (filters + options, codecs, formats, recipes, wasm availability). The agent queries it when the typed tools don't fit and falls back to a validated generic `run_ffmpeg` tool that runs client-side (§7). Served under `/api/v2/...`. |
| D7 | nginx | The nginx config lives in the repo (`nginx/`) and is deployed by GitHub Actions: back up the current files, install the snippet, `nginx -t`, reload only if the test passes, restore the backup otherwise. Scoped to the grepawk.com server block via one `include`, so other sites on the host are unaffected. |

What this changes in the research text below:

- §3.3 / §4: `generate_captions` and `lyric_captions` are no longer "hard": by default no media leaves the device (on-device ASR); only text goes to Grok. Audio upload happens only with the opt-in toggle, to a new `/api/v2/transcribe-audio`.
- §4.2: the web client talks to **new** endpoints (`/api/v2/chat`, `/api/v2/capabilities/*`) that reuse the `handleClientExecution` code path internally. `/api/chat` and its iOS behaviour are not modified.
- §5.3: the server-wide nginx clean-up (header inheritance on `*.js`, `/legal/`, global wasm MIME) is **not** part of this work, because it would change existing routes. Only the `/v2/` locations are added. The existing server-level COOP/COEP lines stay as they are.
- §8: rollout gates on e2e + contract tests (§8.4); old editor kept as fallback.

---

---

## 1. Summary

**Goal.** Every web edit runs in the user's browser with `@ffmpeg/ffmpeg` 0.12.x. Use `@ffmpeg/core-mt` when the page is `crossOriginIsolated`, otherwise `@ffmpeg/core` (single-thread). Both cores are self-hosted. The video never leaves the device. Grok still runs on the server (`/api/chat`, xAI key stays server-side), but it only gets text and metadata (duration, width, height, fps, codecs, hasAudio).

**Where things stand today**

| Area | Today |
|---|---|
| Frontend | React 18 + Vite 6 SPA (`index.html`, `src/main.jsx`, `src/App.jsx`, `src/VideoPreview.jsx`, `src/tools.js`, `src/toolFunctions.js`, `src/useCallAPI.js`) |
| Backend | Node 20 + Express 4 (`server.js` → `src/server/*.js`, `server/ffmpeg/*`, `server/tools/ffmpeg-cli-tool.js`). Native FFmpeg is called through `fluent-ffmpeg` and `execFile`. Also MySQL (sessions, quota), Passport Google OAuth, Stripe, OpenAI speech-to-text, xAI. |
| Hosting | One VPS, `grepawk.com`, nginx 1.18 (Ubuntu). nginx serves `dist/` statically and proxies `/api` and `/auth` to `localhost:3001`. systemd unit `finalcut.service` runs `node server.js`. |
| Build / deploy | `.github/workflows/deploy-grepawk.yml` runs on every push to `main`. It rsyncs the checkout over SSH (`scripts/deploy-grepawk.sh`), runs `npm ci && npm run build` on the server, restarts systemd, and smoke-tests `/` and `/api/health` (commit match). **nginx.conf is not deployed by the workflow.** It is managed by hand (or by `deploy.sh`). |
| CI | `.github/workflows/ci.yml` runs `npm test` (Vitest + MariaDB service). No browser e2e in CI. `playwright.config.js` + `tests/playwright/live-captions.spec.js` exist but only target the live site. |
| Existing headers | `nginx.conf` sets `COOP: same-origin` + `COEP: require-corp` at server level. This is left over from the original wasm app. `vite.config.js` sets them for `vite dev`. `public/_headers` sets them for Netlify/CF-style hosts (unused). |
| Media flow | Each tool call POSTs the **whole current video** to `/api/process-video` (raw body + `x-operation`/`x-args` headers, or multipart). Other routes do the same: `/api/transition-videos`, `/api/generate-captions`, `/api/ffmpeg-cli/run`, `/api/lyric-captions/:id/burn`. The processed bytes stream back. Upload cap: 100 MB (nginx `client_max_body_size` and `UPLOAD_MAX_BYTES`). |

**Outcome of this plan**

- **48 model-visible tools.** That is 47 in `src/tools.js` plus `ffmpeg_cli`, which the server appends.
- **46 can run fully client-side.** 30 are "yes" (stream copy or audio-only re-encode). 16 are "yes with caveats" (they need an H.264 re-encode in wasm, fonts, or several inputs).
- **2 were "hard":** `generate_captions` and `lyric_captions`. Their FFmpeg part (audio extraction, burn-in) moves to the browser. **Per D2, transcription now runs on-device by default** (Whisper via transformers.js), so no media is uploaded by default; audio-only cloud transcription is an opt-in. **0 are "no".**
- The live site is **already cross-origin isolated** (COOP/COEP on the HTML) and loads no third-party resources. Three nginx problems exist on the current routes (left unchanged per D1; the `/v2/` locations avoid all three):
  1. `add_header` inheritance drops COOP/COEP on `*.js` and `/legal/`.
  2. `.wasm` is served as `application/octet-stream`.
  3. There is an absolute `https://grepawk.com/...` fetch that breaks on `www.`.

---

## 2. Prior attempts (git history, PRs, issues)

The web app **started out client-side on ffmpeg.wasm** in `yishengjiang99/pages/finalcut`, hosted on GitHub Pages. It moved to server-side native FFmpeg on 2026-01-23 and was then extracted into this repo. None of these attempts has a bug report or issue explaining "why". The reasons below come from PR descriptions, the owner's prompts to Copilot, and README text. Dates are PT.

| # | Repo / SHA / PR | Date | What was tried | Outcome and why |
|---|---|---|---|---|
| 1 | pages `b6b4700d7` (PR #4) | 2025-12-23 | Vite project with `@ffmpeg/ffmpeg ^0.12.10` + `@ffmpeg/util`. Core loaded from a CDN. All tools ran `ffmpeg.exec` in the browser. Hosted on GitHub Pages (`base: '/finalcut/'`). | Worked on desktop. Failed on iOS Safari (see #2). |
| 2 | pages PR #10, merge `4b2ac83b7` | 2025-12-25 | Owner: *"only works on desktop but not on safari… make it mobile runnable"*. Diagnosis: the mt core needs SharedArrayBuffer, and **GitHub Pages cannot send COOP/COEP**. The fix switched the CDN URL to `@ffmpeg/core-st@0.12.6`. It also added `public/_headers` and COOP/COEP on the vite dev server, excluded ffmpeg from `optimizeDeps`, and added iOS meta tags. | **The fix was broken.** `@ffmpeg/core-st` only exists up to 0.11.1. `https://cdn.jsdelivr.net/npm/@ffmpeg/core-st@0.12.6/dist/{esm,umd}/ffmpeg-core.js` returns **404** (verified 2026-10-09). The single-thread core for 0.12 is `@ffmpeg/core`. `_headers` had no effect on GitHub Pages. |
| 3 | pages `4e373cd26` | 2026-01-18 | "ffmpeg load from jsdeliver". `@ffmpeg/core-mt@0.12.9/dist/umd` through `toBlobURL` (core, wasm, worker). | mt again. Same SharedArrayBuffer problem on a host without headers. |
| 4 | pages PR #40 (`232d4837e`, `623117be0`) | 2026-01-22 | Owner: *"Need more reliable way to load ffmpeg worker."* Switched to single-thread `@ffmpeg/core@0.12.6` with a jsDelivr → unpkg fallback. Review comment: turning output into an object URL *"does not always work"*; fixed with `new Blob([data.buffer])` in 24 places. | Merged. Loading and output handling were flaky. The root cause (third-party CDN, `toBlobURL`, mt/st mismatch) was not addressed systematically. |
| 5 | pages PR #41 (`cdc4c69ed`) | 2026-01-22 | "Align with official playground". Core 0.12.10, download progress, optional `multiThread`, `terminate()` before reload. | Merged. |
| 6 | pages PR #42 (`d64746891`) | 2026-01-23 | Owner pasted the playground snippet: `useRef(new FFmpeg())`, **unconditional `@ffmpeg/core-mt@0.12.10/dist/esm`** with `workerURL`, lazy load on first tool call. | Merged. This brought back the mt core with no `crossOriginIsolated` check and no st fallback. It cannot work on GitHub Pages (no COOP/COEP) or on iOS. |
| 7 | pages PR #44 (`ae46cbc6e`, `a9868f475`, `96fea692a`); PR #43 was a duplicate, closed unmerged | 2026-01-23, about 2 h after #6 | Owner: *"Switch to server side ffmpeg facilitated by node js in finalcut."* Moved everything to `/api/process-video` with `fluent-ffmpeg` and removed `@ffmpeg/*`. The client code was kept as `toolFunctions-client-backup.js` and `ffmpeg-client-backup.js`. | **This is the revert.** Reasons given in the PR and README: "No browser memory limits (100MB+ videos)", "No CORS/SharedArrayBuffer restrictions", "Works everywhere without special headers", native speed, easier debugging. In practice: wasm loading kept failing (CDN, worker, mt without isolation, a nonexistent core-st package) and Safari/iOS was broken. |
| 8 | finalcut `7b5ed4234` → removed in PR #11 `07885bcd9` | 2026-01-28 → 2026-02-02 | The import into this repo carried `src/ffmpeg-client-backup.js` (loader from #5) and `src/toolFunctions-client-backup.js` (789 lines of wasm tool implementations). | Deleted as "obsolete backup files". **Worth reading for the port**: `gh api repos/yishengjiang99/finalcut/contents/src/toolFunctions-client-backup.js?ref=7b5ed4234`. |
| 9 | finalcut `af91f6aba`, `54cb1c6e5`, `26b1c22ff`, `0332f3dcf` ("ffmpegwasm exp") | 2026-02-06 | Custom emscripten build (Docker, emsdk 3.1.64, FFmpeg n6.1.1, `--disable-everything`, `ffmpegwasm/wrapper.c`). The readme promises a CLI. The artifact actually exports only `wav_to_pcm16le_fs` (a libav WAV→PCM smoke test). Output: `public/ffmpeg.js` (94 KB) and `public/ffmpeg.wasm` (903 KB). | Never wired into the app (nothing imports it). `ffmpegwasm/` was deleted in `76657406d` (2026-02-18, "rm irrelevant files for now"). **`public/ffmpeg.js` and `public/ffmpeg.wasm` are still committed and live** at grepawk.com/ffmpeg.{js,wasm}. Dead weight. Delete them, or avoid a name clash with the new core path. |
| 10 | finalcut `95875b1a3` / `63715557b` | 2026-03-08 / 03-10 | Revert of the MIDI-explorer PR #42 (finalcut) wiped the tree and a later commit restored it. These commits only show up because they touch the wasm files. | Not related to wasm. |

Nothing else turned up: no other commits, issues or PRs in finalcut mention `wasm`, `SharedArrayBuffer`, `COOP` or `COEP` (search via the GitHub API over all 337 commit messages, and issue/PR search in both repos). The COOP/COEP lines in `nginx.conf` ("CORS headers for FFmpeg WebAssembly") are left over from attempt #1.

**Lessons for this attempt**

1. Self-host versioned core files. No CDN and no `toBlobURL`.
2. Pick mt or st at runtime from `crossOriginIsolated`, and fall back to st if mt fails to load.
3. Test iOS Safari memory early.
4. Add a browser e2e test that runs in CI so regressions are caught.
5. Keep the server routes for iOS and older clients while the web moves.

---

## 3. Tool inventory

### 3.1 Where the tools live

- Schemas: `src/tools.js` has **47** function tools (`docs/api/CLIENT_TOOL_EXECUTION.md` says 46, which is stale). `src/ffmpegFallback.js` defines `ffmpeg_cli`. The server adds it in `addFfmpegFallbackTool` (`src/server/chat.js`).
- Web executors: `src/toolFunctions.js`. Each tool maps to a server *operation* name (for example `adjust_speed` → `speed_video`, `audio_highpass` → `highpass_filter`), which is POSTed to the server.
- FFmpeg command builders: `src/server/video.js` (sync `/api/process-video` streaming switch, `burn_subtitles`, `add_audio_track`, `/api/transition-videos`), `src/server/ffmpegOps.js` (shared builders, photo pipeline, async jobs), `src/server/lyricCaptions.js` (ASS burn), and `server/ffmpeg/ffmpeg-commander.js` (`ffmpeg_cli`).
- **Existing bug:** 11 tools in `tools.js` have **no web implementation**: `audio_chorus`, `audio_flanger`, `audio_phaser`, `audio_vibrato`, `audio_tremolo`, `audio_gate`, `audio_stereo_widen`, `audio_reverse`, `audio_limiter`, `audio_silence_remove`, `audio_pan`. The server supports them, but `useCallAPI` throws `Unsupported tool call` when Grok picks one on the web. The port fixes this for free.

### 3.2 What the default `@ffmpeg/core` 0.12.10 build contains

Source: ffmpegwasm/ffmpeg.wasm `Dockerfile` and `build/*.sh`.

- FFmpeg **n5.1.4**. The server runs FFmpeg 8 (see `445ebe618`) and the photo pipeline expects ≥ 7, so some filter options and help output differ.
- `--enable-gpl` with libx264, libx265, libvpx (VP8/VP9), libmp3lame, libtheora, libvorbis, libopus, zlib, libwebp, libfreetype, libfribidi, libass (**`--disable-fontconfig`**), libzimg (zscale).
- Native FFmpeg encoders are also present: aac, flac, pcm_*, mjpeg, png, wmav2, gif, mpeg4, and others.
- **Not present:** fontconfig (no system fonts, so a font file must be passed in), librubberband, libsoxr, vidstab, frei0r, libsvtav1/libaom/dav1d, HEIF demuxer (HEIC needs FFmpeg ≥ 7), hardware acceleration, network protocols.
- Memory:
  - **mt** is linked with `INITIAL_MEMORY=1024MB` and **no growth**, so the whole job (input + output + codec buffers) must fit in about 1 GB.
  - **st** starts at 32 MB with `ALLOW_MEMORY_GROWTH`, which allows up to about 2 GB in wasm32. In practice iOS Safari tabs are killed well below that.
  - Files written with `writeFile` live in MEMFS on the wasm heap. The worker exposes **WORKERFS** (`ffmpeg.mount('WORKERFS', {files:[File]}, '/in')`), which reads a `File` lazily without copying it into the heap. **Use WORKERFS for inputs.** Outputs still land in MEMFS.
- Speed (rough estimates; the spike must measure them):
  - Stream-copy and audio-only jobs: near-native, I/O bound, seconds.
  - libx264 in wasm with no SIMD/asm: about 10–25× slower than native for st. mt with `-threads` is typically 2–4× faster than st on 4–8 cores.
  - Example: 60 s of 1080p re-encoded with `-preset ultrafast`, roughly 1–3 min on st and 30–90 s on mt on a recent laptop; much slower on phones.
  - libvpx-vp9 and libx265 are 5–10× slower than x264. Treat them as "allowed but warn".
- API: `exec(args, timeout)`, `ffprobe(args, timeout)`, `mount`/`unmount`, `terminate()`, and `progress`/`log` events are all available in `@ffmpeg/ffmpeg` 0.12.15.

### 3.3 Inventory

Legend:
- **yes**: stream copy or audio-only re-encode, cheap.
- **yes\***: works, but needs a libx264 video re-encode (slow, memory), fonts, or several inputs.
- **hard**: depends on server-side network services.
- **no**: cannot run in wasm.

Audio re-encode on the client should use `-c:a aac -b:a 192k`. Video re-encode should use `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -movflags +faststart` (the server leaves the libx264 default, `medium`).

| # | Tool (server op) | What it does | FFmpeg today (server) | In → Out | Client |
|---|---|---|---|---|---|
| 1 | trim_video (trim_video) | Keep start..end | `-ss S -t (E-S) -c copy` (`applyTrim`) | video → mp4 | **yes**. Keyframe-aligned cut, same as today. Offer an optional "precise" mode (re-encode). |
| 2 | resize_video | Scale | `-vf scale=W:H -c:a copy` | video/photo → mp4/img | **yes\*** (x264 re-encode) |
| 3 | resize_video_preset | 9:16, 16:9, 1:1, 2:3, 3:2 | client maps to `resize_video` (`scale`) | same | **yes\*** |
| 4 | crop_video | Crop | `crop=W:H:X:Y` | same | **yes\*** |
| 5 | rotate_video | Rotate by angle | video: `rotate=A*PI/180`. Photo: `transpose`/`hflip,vflip`/`rotate…ow=rotw` | same | **yes\***. For 90/180/270 on video, consider `-display_rotation`, which needs FFmpeg 6+, so not in 5.1. Use `transpose`. |
| 6 | flip_video_horizontal | Mirror | `hflip` | same | **yes\*** |
| 7 | flip_video_vertical | Upside-down | `vflip` | same | **yes\*** |
| 8 | adjust_brightness | | `eq=brightness=` | same | **yes\*** |
| 9 | adjust_contrast | | `eq=contrast=` | same | **yes\*** |
| 10 | adjust_hue | | `hue=h=` | same | **yes\*** |
| 11 | adjust_saturation | | `eq=saturation=` | same | **yes\*** |
| 12 | apply_color_filter | 13 looks | `colorchannelmixer=…` / `negate` / `curves=preset=vintage` / `colorbalance=…` (`buildColorFilter`) | same | **yes\***. All filters exist in 5.1. |
| 13 | add_text | Overlay text | `drawtext=text='…':x:y:fontsize:fontcolor` (photo path adds `expansion=none`) | same | **yes\***. No fontconfig: write a bundled OFL font to MEMFS and add `fontfile=/fonts/Inter-Bold.ttf`. `scripts/asc/fonts/Inter-Bold.ttf` + `OFL.txt` are already in the repo. Reuse `escapeDrawtext`. |
| 14 | adjust_speed (speed_video) | Speed up/down | `-vf setpts=PTS/s -af atempo chain` | video → mp4 | **yes\*** (video re-encode) |
| 15 | adjust_audio_volume (adjust_volume) | | `-af volume=v -c:v copy` | video → mp4 | **yes** |
| 16 | audio_fade | Fade in/out | `afade=t:st:d`. Fade-out without `start` needs the duration from ffprobe. | same | **yes** (`ffmpeg.ffprobe` or `<video>.duration`) |
| 17 | audio_highpass (highpass_filter) | | `highpass=f=` | same | **yes** |
| 18 | audio_lowpass (lowpass_filter) | | `lowpass=f=` | same | **yes** |
| 19 | audio_echo (echo_effect) | | `aecho=1.0:0.7:d:decay` | same | **yes** |
| 20 | adjust_bass (bass_adjustment) | | `bass=g=` | same | **yes** |
| 21 | adjust_treble (treble_adjustment) | | `treble=g=` | same | **yes** |
| 22 | audio_equalizer (equalizer) | | `equalizer=f:width_type=h:width:g` | same | **yes** |
| 23 | normalize_audio | Loudness | `loudnorm=I=T:TP=-1.5:LRA=11` (single pass) | same | **yes**. loudnorm resamples to 192 kHz internally, so add `-ar 48000`. |
| 24 | audio_delay (delay_audio) | | `adelay=d|d` | same | **yes** |
| 25 | audio_chorus | | `chorus=…` | same | **yes** (missing on web today) |
| 26 | audio_flanger | | `flanger=…` | same | **yes** (missing on web today) |
| 27 | audio_phaser | | `aphaser=…` | same | **yes** (missing on web today) |
| 28 | audio_vibrato | | `vibrato=f:d` | same | **yes** (missing on web today) |
| 29 | audio_tremolo | | `tremolo=f:d` | same | **yes** (missing on web today) |
| 30 | audio_compressor | | `acompressor=…` | same | **yes** |
| 31 | audio_dynamic_normalize | | `dynaudnorm=f:g` or `compand=…` | same | **yes** |
| 32 | audio_gate | | `agate=…` | same | **yes** (missing on web today) |
| 33 | audio_stereo_widen | | `stereowiden=…` | same | **yes** (missing on web today) |
| 34 | audio_reverse | | `areverse` (buffers the whole track) | same | **yes**. Memory is about 384 KB/s for stereo float, so cap at around 30 min. (Missing on web today.) |
| 35 | audio_limiter | | `alimiter=…` | same | **yes** (missing on web today) |
| 36 | audio_silence_remove | | `silenceremove=…` | same | **yes**. It shortens audio relative to video (existing behaviour). (Missing on web today.) |
| 37 | audio_pan | | `pan=stereo|c0=L*c0|c1=R*c1` | same | **yes** (missing on web today) |
| 38 | add_audio_track | Replace or mix music | 2 inputs: `[1:a]volume=v` (+ `amix=inputs=2:duration=first`) `-map 0:v:0 -c:v copy -c:a aac -shortest`, fragmented mp4 | video + audio → mp4 | **yes**. `audioFile` is a string (base64 or data URL) in the LLM args. In the client it should be a *handle* to an audio file the user imported locally (for example `"audio:1"`), never bytes produced by the model. |
| 39 | extract_audio | | `-vn -f fmt -b:a 192k` | video → mp3/wav/aac/ogg/flac/m4a | **yes** (libmp3lame, aac, libvorbis, flac all present) |
| 40 | convert_audio_format | | `-vn -f fmt -b:a` | audio → mp3/wav/aac/ogg/flac/m4a/wma | **yes** (wmav2 encoder is native) |
| 41 | convert_video_format | Container/codec change | `-c copy -f fmt`, or `-c:v libx264/libx265/libvpx-vp9 -c:a copy` | video → mp4/webm/mov/avi/mkv/flv/ogv | **yes\***. Copy to mp4/mov/mkv is cheap. webm needs VP9 + Opus (very slow; also, `-c:a copy` of AAC into webm fails on the server as well). ogv needs theora+vorbis. libx265 is very slow. |
| 42 | convert_image_format | Photo jpg/png/webp | `-frames:v 1 -c:v mjpeg|png|libwebp -f image2` | photo → image | **yes**, except **HEIC input**: FFmpeg 5.1 has no HEIF demuxer. Decode HEIC in the browser instead (Safari: `createImageBitmap`/`<img>`; others: `libheif-js` wasm) to PNG first. |
| 43 | get_video_dimensions (get_video_info) | Metadata | `ffprobe` (server writes a temp file) | video → JSON | **yes**: `ffmpeg.ffprobe(['-v','error','-show_format','-show_streams','-of','json','/in/x','-o','/out/p.json'])` |
| 44 | get_supported_formats | List formats | `GET /api/supported-formats` (static) | → JSON | **yes**. Static list derived from the wasm capability catalog (§7). |
| 45 | add_video_transition | Join N uploaded clips | `/api/transition-videos`: despite the transition names, it builds a `concat=n=N:v=1:a=1` graph (`buildCrossfadeFilter`/`buildWipeFilter`), x264 + aac | N videos → mp4 | **yes\***. Mount all inputs through WORKERFS. Re-encode, so normalise each clip with `scale`/`fps`/`format` before concat. Memory = output only. Real `xfade` works in 5.1 if we want true transitions (needs per-clip durations from ffprobe). |
| 46 | generate_captions | STT, optional translation, burn-in or soft subs | Server: whole video → OpenAI transcription; `/api/translate-captions` (Grok); burn: `subtitles=filename=…:force_style=…` (dual track) `-c:v libx264 -pix_fmt yuv420p -c:a aac` | video → SRT/VTT + mp4 | **yes\* (D2: on-device Whisper by default; audio-only cloud opt-in; translation text-only).** Original research note: Client: extract mono 16 kHz Opus/MP3 (~10–20× smaller than the video) and upload **only audio** to a new `/api/transcribe-audio`. Or run Whisper in the browser (transformers.js / whisper.cpp wasm), which needs a model download and is slow. Translation is text-only. Burn-in in wasm with libass: write the SRT and a font to MEMFS, `subtitles=/w/s.srt:fontsdir=/fonts:force_style=…` (FontName must match the bundled font). Soft subs already work client-side. |
| 47 | lyric_captions | Bilingual lyric captions | Client already extracts WAV with WebAudio (`extractAudioWav`) and uploads audio. Server: OpenAI → xAI → ASS. Burn: `/api/lyric-captions/:id/burn` (`ass=` filter, `libx264 -preset medium -crf 20`) | video → mp4 | **yes\* (D2: on-device Whisper transcript; Grok gets text only for song lookup/translation; audio upload only with the opt-in).** Original research note: Keep audio upload (or encode Opus in wasm to shrink it). Fetch the ASS text from the job result and burn it in wasm with `ass=/w/l.ass:fontsdir=/fonts`. The video is no longer uploaded. |
| 48 | ffmpeg_cli (`/api/ffmpeg-cli`, `/run`) | Fallback: discover/plan/run | `ffmpeg-commander.js` builds a validated argv (`-ss -i -t -vn -an -vf -af -c:v -c:a -crf -b:v -b:a -r -f`), forbids movie/amovie/subtitles/drawtext/sendcmd/zmq…, file/protocol values, 13 output formats | video → many | **yes\***. Becomes `search_ffmpeg_capabilities` (server, catalog) plus `run_ffmpeg` (browser). See §7. |

**Totals (after D2):** 30 yes, 18 yes\*, 0 hard, 0 no. All 48 run client-side by default with **no media upload**; captions upload audio only if the user opts in to cloud transcription. (Research-time totals were 30 / 16 / 2 hard.)

Photos: the 12 `PHOTO_SUPPORTED_OPS` move to the same wasm path (`-frames:v 1 -update 1 -f image2`). Simple photo ops could also use Canvas/OffscreenCanvas, which is faster and smaller, but staying on FFmpeg keeps one code path.

---

## 4. Agent loop: today and proposed

### 4.1 Today (web)

1. `useCallAPI` POSTs `/api/chat` with `{ model, messages: [latest user message only], tools: tools.js, tool_choice: 'auto' }`.
2. The server adds the system prompt, appends the `ffmpeg_cli` tool, calls `https://api.x.ai/v1/chat/completions` with `grok-3, stream:true`, and forwards SSE. The server's lesson filter strips a trailing "Lesson" section.
3. The client collects `tool_calls` from the stream and runs them **sequentially in the browser**. Each `toolFunctions[name]` uploads the current bytes (`workingVideoFileData`) to a server media route and swaps in the result.
4. **There is no second LLM round.** Tool results are pushed into `currentMessages` but never sent back. The model **never sees media metadata** (duration, size) on the web.
5. Quota: `requireInferenceAccess` charges `/api/chat` *and* every media route.

There is already a better protocol for iOS: `POST /api/chat` with `execution:"client"` (`src/server/chat.js` → `handleClientExecution`, `docs/api/CLIENT_TOOL_EXECUTION.md`). It is non-streaming JSON. It takes `media` metadata and up to 4 optional thumbnails, returns `status:"tool_calls"` with `toolCalls[]`, has a turnToken so one turn costs one charge, allows up to 6 rounds, and supports the `skipped_by_user` and `unsupported_on_device` results. The device runs the tools and posts back tool messages.

### 4.2 Proposed (web, no media upload)

```
Browser                                             Server (/api/chat, execution:"client")       xAI
──────────────────────────────────────────────      ─────────────────────────────────────        ───
import File → keep as File (no upload)
ffprobe in wasm (WORKERFS) → media{type,duration,
  width,height,fps,hasAudio,vcodec,acodec,size}
POST /api/v2/chat {execution:"client", client:"web-wasm/1",
      messages, media, thumbnails: []} ───────────▶ build system prompt + offered tools
                                                    (web-wasm toolset, §4.3)            ────────▶ grok
                                                    ◀── tool_calls ─────────────────────────────
                                                    server-resolved tools (search_ffmpeg_
                                                    capabilities, lookup) answered inline,
                                                    loop continues server-side
◀── {status:"tool_calls", toolCalls, turnToken} ───
for each call: validate args → build argv →
  ffmpeg.exec in worker (progress, cancel) →
  new File/Blob → ffprobe → metadata
POST {messages+tool results {ok, executedOn:
  "browser", output:{duration,width,height,...}},
  turnToken, media} ───────────────────────────────▶ continue ────────────────────────▶ grok
◀── {status:"final", message} ─────────────────────
```

Details:

- **Keep the LLM server-side** (xAI key, quota, lessons, system prompt stay on the server). **Per D1 the web-wasm client uses a new route, `POST /api/v2/chat`**, which calls the same `handleClientExecution` code with the **web-wasm toolset** (instead of the iOS allowlist). `/api/chat` is not modified: iOS and the current web editor keep exactly today's behaviour.
- **What goes to the server**: the user text, `media` metadata, tool results (`ok`, error code, output metadata), and no thumbnails by default. Thumbnails are media. Make them an explicit opt-in toggle ("let Grok see 4 small frames") because they only help with a vision model (`XAI_CLIENT_MODEL`). The current default `grok-3` ignores them.
- **Streaming UX**: the client protocol is not SSE. Either accept non-streamed final text (simplest), or add `stream:true` support to client mode later.
- **Multi-round**: the web gets the real loop (up to 6 rounds) for free. The model can call `get_video_dimensions`, see the result, then trim.
- **Executor**: new `src/wasm/` module:
  - `ffmpegHost.js`: singleton `FFmpeg` in a worker; picks mt or st; `exec` with timeout, progress, cancel through `terminate()` + reload.
  - `ops/*.js`: pure `buildArgs(toolName, args, media) → {inputs, argv, output}`. Port the builders from `ffmpegOps.js`/`video.js` as **isomorphic pure functions** shared with the server (and with the iOS fallback), so the server and browser cannot drift.
  - `runTool(call)`: validate, mount, exec, read output, unmount/cleanup, update preview.
- **Media handles**: tools refer to `current` (latest output), `original`, `clip:N` (for transitions), `audio:N` (for `add_audio_track`). Never base64.
- **Errors**: return `{ok:false, code:'wasm_oom'|'wasm_timeout'|'unsupported_in_browser'|'invalid_arguments', executedOn:'browser'}`. Treat `unsupported_in_browser` like `unsupported_on_device` (already handled on the server: the tool is withheld and the model is told).
- **Undo/redo**: keep a stack of Blobs (bounded, LRU to IndexedDB/OPFS for big ones) instead of server state. `captionLineage.js` keeps working on bytes.

### 4.3 Web-wasm toolset offered by the server

All 47 tools in `tools.js`, with these changes:

- Narrow `convert_video_format.codec`: drop `libx265` and warn on `libvpx-vp9`.
- Narrow `adjust_speed.speed` to 0.25–4.
- `generate_captions` and `lyric_captions` descriptions say "audio only is uploaded for transcription".
- Replace `ffmpeg_cli` with `search_ffmpeg_capabilities` (server-resolved) and `run_ffmpeg` (browser), as described in §7.

---

## 5. COOP/COEP plan

### 5.1 What the site loads cross-origin (complete list from source and the live HTML)

| Resource | Origin | Under COOP same-origin + COEP require-corp |
|---|---|---|
| App JS/CSS (`/assets/index-*.js`) | same | OK |
| `/BigBuckBunny.mp4` sample, `/sampaudio.mp3` | same | OK |
| Imported media, results, VTT/SRT | `blob:` (same-origin) | OK. `<video crossOrigin="anonymous">` with a blob: URL is fine. |
| `/api/*`, `/auth/*` | same | OK |
| `fetch('https://grepawk.com/api/sample-access-token')` in `index.html` and `App.jsx:102` | same on apex, **cross-origin on `www.grepawk.com`** | A CORS-mode fetch needs `Access-Control-Allow-Origin`. `server.js` imports `cors` but never uses it, so **this already fails on www**. COEP does not change that. Fix: make the URL relative and 301 `www` → apex. |
| Google sign-in | top-level navigation `/auth/google` → accounts.google.com → `/auth/google/callback` | OK (no popup, no iframe) |
| Stripe Checkout | server `res.redirect(session.url)` (top-level) | OK. No Stripe.js or Elements iframes today. |
| Fonts, analytics, CDNs, iframes, third-party images | **none** | none |
| `/legal/*.html` | same, standalone pages | Not isolated today (header dropped). Harmless. |

**Things that would break if added later:**
- Google Identity Services popup or One Tap: COOP same-origin cuts `window.opener`.
- Stripe.js / Elements iframes, YouTube embeds, cross-origin images/fonts/analytics without CORP/CORS: blocked by require-corp.

If you need them later, switch to `COEP: credentialless` (Chrome 96+, Firefox 119+, **not Safari**) and/or `COOP: same-origin-allow-popups`. Note that allow-popups is **not** cross-origin isolated, so the mt core would not be available on those pages. The better option is to keep payments and auth flows on separate non-isolated routes or top-level redirects.

### 5.2 Live findings (curl -I, 2026-10-09)

- `/`, `/api/health`, `/BigBuckBunny.mp4`, `/ffmpeg.wasm`: COOP + COEP present. **The page is already crossOriginIsolated.**
- `/ffmpeg.js` and all `*.js` (therefore `/assets/*.js` and the future `ffmpeg-core.js`/`worker.js`): **COOP/COEP missing**. Cause: `location ~* \.(js|css|…)$ { add_header Cache-Control …; }`. nginx does **not inherit** server-level `add_header` into a location that has its own `add_header`. The same happens for `/legal/`, which also loses `X-Frame-Options`/`nosniff`. Workers need COEP on their own script response, and CORP/same-origin for subresources.
- `.wasm` is served as `application/octet-stream`. nginx 1.18 `mime.types` lacks wasm, so `instantiateStreaming` fails and falls back to slower ArrayBuffer compilation.
- `Cache-Control` is duplicated on js (`expires 1y` + `add_header`).

### 5.3 Config in this repo (scoped to `/v2/`, per D1)

Implemented in the spike PR: [`nginx/finalcut-v2.locations.conf`](../nginx/finalcut-v2.locations.conf) and [`nginx/finalcut-v2-headers.conf`](../nginx/finalcut-v2-headers.conf), included once in the grepawk.com `:443` server block (`include snippets/finalcut-v2.locations.conf;`).

- `location ^~ /v2/` (and nested `/v2/assets/`, `/v2/ffmpeg-core/`) repeats the security headers and adds COOP `same-origin`, COEP `require-corp`, CORP `same-origin`. `^~` also stops the server's `\.(js|css…)$` regex location from catching `/v2/*.js`, which is what drops COEP on JS today.
- `/v2/ffmpeg-core/` has a local `types {}` with `application/wasm`, immutable caching, and gzip for wasm/js.
- Nothing else in the server block changes. CI (`.github/workflows/v2-editor.yml`, job `nginx-v2`) runs `nginx -t` on nginx 1.18 with and without the include, checks the `/v2` headers, and diffs the headers of existing paths between the two (must be identical).

The original research recommendation (server-wide snippet) is kept below for reference. It would change existing routes, so it is **deferred** until after the switch-over and needs its own PR with the contract test.

`/etc/nginx/snippets/finalcut-headers.conf` (new):

```nginx
add_header Cross-Origin-Opener-Policy   "same-origin"  always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Resource-Policy "same-origin"  always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
```

Server block:

```nginx
types { application/wasm wasm; }            # or add to mime.types
server_name grepawk.com;                       # www → 301 to apex in its own server block
include snippets/finalcut-headers.conf;

location / { include snippets/finalcut-headers.conf; try_files $uri $uri/ /index.html; }
location ^~ /legal/ { include snippets/finalcut-headers.conf; add_header Cache-Control "public, max-age=3600" always; try_files $uri =404; }
location ^~ /ffmpeg-core/ {                    # self-hosted @ffmpeg/core{,-mt} — versioned path, immutable
  include snippets/finalcut-headers.conf;
  add_header Cache-Control "public, max-age=31536000, immutable" always;
  gzip_static on; brotli_static on;             # if ngx_brotli; else gzip on; gzip_types application/wasm application/javascript;
}
location ~* \.(js|mjs|css|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|wasm)$ {
  include snippets/finalcut-headers.conf;
  add_header Cache-Control "public, max-age=31536000, immutable" always;   # drop `expires 1y`
}
location /api  { proxy_pass http://localhost:3001; … }   # inherits server-level headers (no add_header inside)
location /auth { proxy_pass http://localhost:3001; … }
```

Other places headers need setting:
- `vite.config.js`: keep `server.headers`, **add `preview.headers`** (same two), and `optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] }`.
- Express: optional `helmet`-style middleware setting the same headers on `/api` responses, so a missing nginx config is caught in dev and tests.
- `public/_headers`: keep for any static preview host (Netlify/CF Pages). Add `/ffmpeg-core/*` cache rules there too.
- Deploy smoke (§8.4) asserts the headers on `/`, an `/assets/*.js`, `/ffmpeg-core/…/ffmpeg-core.worker.js` and `.wasm` (plus `Content-Type: application/wasm`), so the add_header trap cannot come back unnoticed.
- The nginx config is not deployed by the GitHub workflow today. **Per D7** it will be: a separate, guarded workflow step copies `nginx/finalcut-v2*.conf` to `/etc/nginx/snippets/`, backs up the previous copies, runs `nginx -t`, reloads only on success, and restores the backup on failure. Scoped to the grepawk.com server block; other sites on the host are not touched. Not part of the spike PR.

### 5.4 Runtime selection and st fallback

```js
const canMT = self.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'
  && (navigator.hardwareConcurrency ?? 1) > 1 && !isLowMemoryIOS();
const base = `/v2/ffmpeg-core/${canMT ? 'mt' : 'st'}/0.12.10`;
try {
  await ffmpeg.load({ coreURL: `${base}/ffmpeg-core.js`, wasmURL: `${base}/ffmpeg-core.wasm`,
                      ...(canMT && { workerURL: `${base}/ffmpeg-core.worker.js` }) });
} catch (e) { if (canMT) await loadST(); else throw e; }   // e.g. iOS refusing the 1 GB mt heap
```

- st works on any modern browser with no special headers (GitHub Pages, `www`, embedded contexts).
- Add a `?wasm=st` override for debugging, and report `{mode, crossOriginIsolated, cores, ua}` to the console only. **No telemetry upload** unless the privacy page says so.
- Pass `-threads` explicitly in mt **as an output option, capped at 4** (`min(cores, 4)`). Measured in the spike: with core-mt 0.12.10, libx264 with no `-threads` (auto) or `-threads 8` **hangs forever**, `-threads 6` aborts, `-threads ≤ 4` works. ffmpeg's own exec timeout does not fire during that hang, so the host also has a wall-clock watchdog that `terminate()`s the worker.

---

## 6. Spike plan (1–2 days)

**Goal:** prove mt + st self-hosted load, trim end-to-end, and **zero media bytes uploaded**, in headless Chrome.

1. Dependencies (pin exact): `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/util@0.12.2`, `@ffmpeg/core@0.12.10`, `@ffmpeg/core-mt@0.12.10`.
2. `scripts/copy-ffmpeg-core.mjs` (run as `postinstall`/`prebuild`): copy `node_modules/@ffmpeg/core/dist/esm/*` → `public/ffmpeg-core/st/0.12.10/` and `core-mt/dist/esm/*` (incl. `ffmpeg-core.worker.js`) → `public/ffmpeg-core/mt/0.12.10/`. Gitignore those, and record sha256 in a manifest. Remove or rename the dead `public/ffmpeg.{js,wasm}`.
3. `src/wasm/ffmpegHost.js` (loader from §5.4) and `src/wasm/ops/trim.js` (port of `applyTrim`, `-ss S -i /in/x -t D -c copy -movflags +faststart /out/o.mp4`), using WORKERFS for input.
4. Behind a flag (`?engine=wasm` or `VITE_ENGINE=wasm`): route `toolFunctions.trim_video` to wasm, with no fetch to `/api/process-video`.
5. A tiny static server for tests (`tests/e2e/server.mjs`) that serves `dist/` with the nginx headers. Toggle `COEP=off` to force st. Stub `/api/chat` and `/api/auth/status` through Playwright `page.route` with a canned `tool_calls: trim_video {start:1,end:3}`, so no xAI key is needed.
6. Playwright test `tests/e2e/wasm-trim.spec.js`, run for `{mt: headers on, st: headers off}`:
   - Upload `src/test/fixtures/speech-hello.mp4` (or `public/BigBuckBunny.mp4`) through `setInputFiles`.
   - Assert `await page.evaluate(() => crossOriginIsolated)` matches the mode, and the host reports mode `mt`/`st`.
   - Send "trim 1 to 3"; wait for the result `<video>`; read its blob, then ffprobe (wasm in page, or native `ffprobe` in CI) gives a duration of about 2.0 s ± 0.1.
   - **Network assertion** through `page.on('request')` and CDP `Network.requestWillBeSent`, which also catches worker requests (`context.on('request')` covers workers in Chromium):
     - no request to `/api/process-video|/api/jobs/process-video|/api/transition-videos|/api/ffmpeg-cli/run|/api/generate-captions|/api/lyric-captions/*/burn`;
     - every non-GET request has a `postDataBuffer()` length < 64 KB and a content-type that is not `video/*`, `audio/*`, `image/*` or `multipart/form-data`;
     - total request-body bytes across the test are below 0.05 × fixture size;
     - optional: the fixture's first 4 KB do not appear in any request body.
   - Record wall time for load (cold and warm cache) and exec for both modes.
7. Exit criteria:
   - mt and st both pass in headless Chromium.
   - A manual run on iOS Safari 17+ (st and mt) and Firefox works.
   - Load ≤ 3 s warm.
   - Trim ≤ 2 s for a 50 MB file.
   - Fill in the speed numbers in §3.2 for a resize (x264) of 30 s 1080p.

---

### 6.1 Spike implementation and results (2026-10-09, branch `web-ffmpeg-wasm-spike`)

What was built (new files only; existing routes untouched):

- `v2/index.html`, `v2/main.js`: the `/v2/` page. Local file input → trim (start/end, optional "precise" re-encode) → `<video>` preview + download link. Footer links `/legal/licenses.html`.
- `src/wasm/ffmpegHost.js`: loader (mt when `crossOriginIsolated`, st otherwise, st fallback if mt fails), WORKERFS input mount, encoder thread cap, watchdog. `src/wasm/ops/trim.js`: pure argv builder with parity to `applyTrim`. `src/wasm/clipLimits.js`: D3 limits.
- `scripts/copy-ffmpeg-core.mjs`: verifies the exact pinned versions are installed, copies `dist/esm` of `@ffmpeg/core-mt` and `@ffmpeg/core` to `v2/public/ffmpeg-core/{mt,st}/0.12.10/`, writes a sha256 manifest. `vite.v2.config.js` builds to `dist/v2/` (the existing `npm run build` is unchanged).
- Pinned: `@ffmpeg/ffmpeg@0.12.15`, `@ffmpeg/util@0.12.2`, `@ffmpeg/core@0.12.10`, `@ffmpeg/core-mt@0.12.10` (all verified to exist on npm; `@ffmpeg/core-st` stops at 0.11.1 and is not used). FFmpeg inside the core: 5.1.4 (checked in the wasm binary).
- GPL source (D8): `scripts/fetch-ffmpeg-source.mjs` + `vendor/ffmpeg-source.lock.json` publish `/v2/vendor/ffmpeg/source/` at build time; `tests/e2e/v2-licenses.pw.mjs` checks that every licenses-page link resolves and that the checksums match.
- Tests: `tests/e2e/v2-trim.pw.mjs` (Playwright, mt + st projects, no-upload guard), `tests/e2e/v2-bench.pw.mjs` (optional benchmark), `src/test/wasm-v2.test.js` (unit), `tests/contract/ios-endpoints.mjs` (iOS contract), `tests/e2e/check-v2-headers.sh` + `compare-route-headers.sh` (nginx), workflow `.github/workflows/v2-editor.yml`.

Results (headless Chromium 153 on the 8-core dev box, served from loopback, so network time is ~0):

| Mode | Core load | Trim 1–3 s, stream copy (6 s 320×240 clip) | Precise trim 2 s (x264) | 30 s 1080p clip: copy-trim 10 s | 30 s 1080p clip: x264 re-encode 5 s |
|---|---|---|---|---|---|
| mt (COOP/COEP) | ~300 ms | ~45 ms | ~260 ms | ~260 ms | **4.6 s** |
| st (no isolation) | ~125 ms | ~45 ms | ~400 ms | ~255 ms | **12.5 s** |
| native FFmpeg 7.1 (same box) | – | – | – | – | ~0.8 s |

- Output duration 2.08 s for a 1–3 s copy trim, identical to the server's `-ss 1 -t 2 -c copy` on the same clip (keyframe-aligned).
- No-upload assertion: 0 non-GET requests, 0 request-body bytes, no third-party requests (all core files self-hosted), in both modes. A self-test proves the guard catches a media POST.
- Exit criteria still open: manual iOS Safari 17+ and Firefox runs; load time over a real network (32 MB wasm; brotli/gzip); 50 MB-file trim timing on a phone.

## 7. FFmpeg capability catalog + generic run tool (new requirement)

### 7.1 Purpose and fit

- **Default toolset**: the 47 typed tools, executed in the browser.
- **Discovery**: when no default tool fits, the model calls `search_ffmpeg_capabilities` (and `get_ffmpeg_capability` for detail). These read a server-held JSON catalog describing **exactly what the wasm build can do**.
- **Execution**: the model calls `run_ffmpeg` with a structured intent. The server validates it against the catalog in the same request (plan step). The browser validates it again, sandboxes it and runs it in ffmpeg.wasm.
- This replaces today's `ffmpeg_cli` (`discover|plan|run`). That tool discovers capabilities from the **server's native FFmpeg 8**, which differs from wasm 5.1.4 (different filters/options, `drawtext`/`subtitles` forbidden, GPL codecs set). Keep `ffmpeg_cli` for iOS/server fallback, reusing the same catalog with `availability.server`.

### 7.2 Catalog schema (`ffmpeg-catalog.v1.json`)

```jsonc
{
  "schemaVersion": "1",
  "builds": {
    "wasm-st": { "package": "@ffmpeg/core@0.12.10", "ffmpeg": "n5.1.4", "configure": "--enable-gpl --enable-libx264 …", "sha256": "…" },
    "wasm-mt": { "package": "@ffmpeg/core-mt@0.12.10", "ffmpeg": "n5.1.4", "threads": true, "initialMemoryMB": 1024 },
    "server":  { "ffmpeg": "8.0", "host": "grepawk.com" }
  },
  "filters": [{
    "name": "vignette", "kind": "filter", "media": "video", "io": "V->V",
    "flags": { "timeline": true, "slice": true, "command": false },
    "summary": "Make or reverse a natural vignetting effect.",
    "options": [{ "name": "angle", "alias": "a", "type": "string", "default": "PI/5", "desc": "set lens angle" },
                { "name": "mode", "type": "int", "enum": ["forward","backward"], "default": "forward" }],
    "tags": ["look","color","lens"],
    "availability": { "wasm-st": true, "wasm-mt": true, "server": true },
    "risk": { "reencode": "video", "cost": "low", "needsFiles": false, "forbidden": false }
  }],
  "encoders": [{ "name": "libx264", "media": "video", "summary": "…", "pixFmts": ["yuv420p", "…"],
                 "options": [{ "name": "preset", "enum": ["ultrafast", "…"] }, { "name": "crf", "type": "float", "range": [-1, 51] }],
                 "availability": { "wasm-st": true, "wasm-mt": true, "server": true }, "cost": "high-in-wasm" }],
  "decoders": [ … ], "codecs": [ … ],
  "muxers":   [{ "name": "mp4", "extensions": ["mp4"], "mime": "video/mp4", "defaultCodecs": { "v": "libx264", "a": "aac" } }],
  "demuxers": [ … ], "pixFmts": [ … ], "sampleFmts": [ … ], "channelLayouts": [ … ],
  "recipes": [{
    "id": "picture_in_picture", "title": "Picture-in-picture", "tags": ["overlay","pip"],
    "intent": { "inputs": ["current", "clip:2"],
                "filterComplex": "[1:v]scale=iw/4:-2[p];[0:v][p]overlay=W-w-16:H-h-16",
                "map": ["[v]?", "0:a?"], "videoCodec": "libx264", "audioCodec": "copy" },
    "requires": ["overlay","scale","libx264"], "notes": "…"
  }]
}
```

Recipe ideas: gif export (palettegen/paletteuse), vignette, film grain (`noise`), denoise (`hqdn3d`/`atadenoise`), sharpen (`unsharp`), blur (`boxblur`/`gblur`), speed ramp, reverse video (memory warning), picture-in-picture, split-screen (`hstack`), letterbox (`pad`), stabilize (**vidstab unavailable**: mark `availability:false` and suggest `deshake`), LUT (`lut3d` with a user-supplied .cube as a handle), chroma key (`chromakey`), zoom/Ken Burns (`zoompan`), audio ducking (`sidechaincompress`), pitch (`asetrate,aresample,atempo` because rubberband is unavailable).

### 7.3 Generation (CI, from the same build that runs in the browser)

`scripts/catalog/generate.mjs` runs in a GitHub Action job and locally:

1. Start headless Chromium (Playwright), serve the copied `/ffmpeg-core/st/0.12.10`, `load()` the core.
2. For each listing, run `ffmpeg.exec([...args])` and capture the `log` events: `-hide_banner -filters`, `-codecs`, `-encoders`, `-decoders`, `-muxers`, `-demuxers`, `-pix_fmts`, `-sample_fmts`, `-layouts`, `-buildconf`, `-version`.
3. For each filter, encoder and muxer: `-h filter=NAME`, `-h encoder=NAME`, `-h muxer=NAME`. That is about 450 filters + about 150 encoders. Expect a few minutes in a single page; batch through one `exec` per item. Parse the AVOption tables (`name <type> ..FV....... desc (from A to B) (default X)` plus enum value lines) into `options[]`.
   - Reuse and extend `parseFilters`/`parseFlagged` from `server/ffmpeg/ffmpeg-discovery.js`. They already handle both the 5.x three-char and 8.x two-char flag formats.
4. Repeat steps 2–3 for mt, which should be identical apart from threads, and **diff** the two.
5. Optionally run the same against native server FFmpeg (`ffmpeg-discovery.js`) and fill `availability.server`.
6. Merge with hand-written `catalog/overrides.yaml`: tags, `risk`/`cost`, `forbidden`, better summaries, and the `recipes`.
   - **Validate each recipe** by executing it on a 1 s `testsrc`/`sine` fixture in wasm. A recipe that fails is dropped and the job errors.
7. Output `public/ffmpeg-catalog/v1/<coreVersion>.json`: full, about 2–4 MB raw, about 300–500 KB brotli, immutable. Also `catalog/ffmpeg-catalog.v1.json`, committed and loaded by the server. A CI drift check fails if the core version changes without regenerating.

### 7.4 Where it is served and how the agent queries it (token-frugal)

- **Server** loads the committed JSON into memory at boot. It builds a small inverted index (name, aliases, tags, summary tokens; BM25-ish, like the existing `matching()`). Per D1/D6 it is exposed only on new routes, e.g. `GET /api/v2/capabilities/search?q=…`, `GET /api/v2/capabilities/:name`, and the catalog also carries `limits.clip` (D3) so clip limits can be tuned without a client release.
- **Browser** lazily fetches the same versioned static file, used only for client-side validation (option names and enums), never in the prompt.
- **Tools**, resolved **on the server inside the `/api/chat` client-execution loop**: no browser round-trip, no extra quota, not counted as client rounds.
  - `search_ffmpeg_capabilities({ query, kind?: 'filter'|'encoder'|'muxer'|'recipe'|'any', media?: 'video'|'audio', limit?: ≤8 })` returns compact rows only:
    `[{"n":"vignette","k":"filter","m":"video","s":"Natural vignetting effect","opts":["angle","x0","y0","mode"]}, {"n":"recipe:film_grain","k":"recipe","s":"…"}]`.
    Unavailable-in-wasm entries are excluded by default, or flagged `"avail":false`. Budget about 600 tokens per call.
  - `get_ffmpeg_capability({ name })` returns one entry with options trimmed (name/type/default/range/enum ≤ 12 values, max 40 options, desc ≤ 80 chars, about 1.5 KB). For a recipe it returns the ready intent.
- **Prompt**: the system prompt gets one line: *"Prefer the typed tools. If none fits, search the FFmpeg catalog, then run_ffmpeg with the smallest filter graph. Video re-encodes are slow in the browser; prefer stream copy."* The catalog itself is **never** in the prompt.
- **Caching**: memoise search results per turn. The server rejects more than 4 catalog calls per turn to stop browsing loops (counts toward `maxRounds`).

### 7.5 `run_ffmpeg` (generic, executes in the browser)

Use a **structured intent, not a raw argv string**. It extends today's `ffmpeg_cli` params:

```jsonc
{ "inputs": ["current"],             // handles only: current | original | clip:N | audio:N | image:N | lavfi:<source-expr>
  "start_time": 1.5, "duration": 4, // input/output trims
  "video_filters": "vignette=PI/4,eq=saturation=1.2",
  "audio_filters": "aecho=0.8:0.9:500:0.3",
  "filter_complex": null,           // allowed only if every filter in it is allowlisted; labels [a-z0-9_]
  "map": ["0:v", "0:a?"],
  "video_codec": "libx264", "audio_codec": "aac", "crf": 23, "preset": "veryfast",
  "video_bitrate": null, "audio_bitrate": "192k", "frame_rate": null, "pix_fmt": "yuv420p",
  "no_audio": false, "no_video": false, "output_format": "mp4", "explain": "why this approach" }
```

**Validation** happens in the server plan step and again in the browser, using the same isomorphic module `shared/ffmpegIntent.js`.

- **Argument allowlist.** The builder emits only these options, in a fixed order: `-hide_banner -nostdin -y -threads N`, `[-ss] -i /in/<k>`, `[-t]`, `-vn -an -sn -dn`, `-vf`, `-af`, `-filter_complex`, `-map`, `-c:v -c:a`, `-crf -preset -b:v -b:a -r -pix_fmt -ac -ar`, `-shortest`, `-frames:v`, `-movflags +faststart`, `-f`, `/out/out.<ext>`. Free-form argv is never accepted from the model.
- **Names.** Filter, encoder and muxer names must exist in the catalog with `availability.wasm-* = true` and not be `forbidden`. Option keys must exist for that filter or encoder. Enum values are checked. Numbers are finite and in range. Option values ≤ 64 chars. Graph ≤ 2000 chars. ≤ 16 filters.
- **Forbidden filters:** `movie`, `amovie`, `sendcmd`, `asendcmd`, `zmq`, `azmq`, `metadata`/`ametadata` with file output, `subtitles`/`ass` (use the typed caption tools, which supply sandboxed files), `drawtext` with `textfile` (allow `drawtext` with `fontfile` forced to the bundled font), `lut3d`/`haldclut` unless the file is a handle, `-filter_script`, `-attach`, `-dump_attachment`.
- **Forbidden values:** any `/`-absolute path or protocol prefix (`file:`, `http(s):`, `pipe:`, `concat:`, `subfile:`, `data:`, `tcp:`…). The same regexes as `ffmpeg-commander.js` (`FORBIDDEN_PARAM_KEYS`, `FORBIDDEN_VALUE`).
- **`lavfi:` inputs** are allowed only for source filters on an allowlist: `color`, `anullsrc`, `sine`, `testsrc2`, with bounded `d=` (≤ 60 s) and size (≤ 4096²).

**Sandbox in the worker:**

- Inputs are mounted read-only through WORKERFS at `/in/<k>`.
- Outputs go to a fresh MEMFS dir `/out/<jobId>/`.
- Fonts live in a read-only `/fonts`.
- Nothing else is reachable. Network protocols are not compiled into the core.
- After each run: `readFile` the single expected output, `deleteFile`, `unmount`, `deleteDir`.
- The worker is recycled (`terminate()` + `load()`) after a timeout, an OOM, or every N jobs, to defragment the heap.

**Resource guards:**

- Pre-flight estimate: `outputBytes ≈ bitrate × duration`, `heapNeeded ≈ outBytes + decode buffers` (frame size × 3 × about 8 frames, + filter look-ahead such as `reverse`/`areverse` = whole stream). Reject with `wasm_too_large` if the estimate exceeds the budget (mt about 800 MB, st about 1.2 GB desktop / about 300 MB iOS), or ask for a lower resolution or shorter range.
- `exec(argv, timeoutMs)` with `timeoutMs = clamp(30 s + duration × factor(reencode, mode), …, 15 min)`.
- A user-visible Cancel calls `terminate()`.
- Output size cap of 2 GB, checked through progress/`-fs` limit `-fs <bytes>`.
- Progress comes from the `progress` events.

**Result to the model:** `{ok, executedOn:"browser", output:{duration,width,height,hasAudio,format,bytes}, command:"<rendered argv for transparency>"}`. On error: `{ok:false, code, stderrTail: <last 500 chars, paths scrubbed>}`.

### 7.6 Where the catalog sits relative to the existing tools

| Layer | Tools |
|---|---|
| Typed (default) | the 47 tools. Builders are ported to `shared/ops/*` and run in the browser. |
| Discovery (server-resolved, no media) | `search_ffmpeg_capabilities`, `get_ffmpeg_capability` (replace `ffmpeg_cli` discover/plan on web) |
| Generic execution (browser) | `run_ffmpeg` (replaces `ffmpeg_cli` run on web; `ffmpeg_cli` stays for iOS/server) |
| Hybrid (network for ASR only) | `generate_captions`, `lyric_captions` (burn-in through wasm) |
| Info | `get_video_dimensions` (wasm ffprobe), `get_supported_formats` (from the catalog: muxers/encoders with wasm availability) |

---

## 8. Full port plan

### 8.1 Phases

1. **Infrastructure (after the spike)**
   - Fix nginx (§5.3).
   - Relative `sample-access-token` URL and www → apex.
   - Delete `public/ffmpeg.{js,wasm}`.
   - `src/wasm/ffmpegHost.js`, copy script, Vite `optimizeDeps.exclude`, `preview.headers`.
   - Lazy-load the core on first edit, with a progress bar (core about 31 MB wasm, about 8–10 MB brotli; cache immutable).
   - Optional service worker pre-cache after first use.
2. **Shared builders**
   - Extract pure `buildArgs` for every op from `src/server/video.js` and `src/server/ffmpegOps.js` into `shared/ops/` (no fluent-ffmpeg). The server keeps using them through a small fluent adapter or `execFile` argv, so the server and browser cannot drift.
   - Unit-test argv snapshots in Vitest (node) for every tool.
3. **Browser tool executors**
   - New `/v2` executors around `runTool(name, args, handles)` (the current `toolFunctions.js` stays as is for the old editor).
   - Implement all 47, **including the 11 missing audio effects (D5)**: `audio_chorus`, `audio_flanger`, `audio_phaser`, `audio_vibrato`, `audio_tremolo`, `audio_gate`, `audio_stereo_widen`, `audio_reverse`, `audio_limiter`, `audio_silence_remove`, `audio_pan`.
   - Fonts: Inter (OFL) in `/fonts`.
   - Photos: same path. HEIC is converted in the browser first.
   - Transitions: WORKERFS multi-mount + normalise + concat (optionally true `xfade`).
4. **Agent wiring**
   - `/v2` uses `POST /api/v2/chat` (`execution:"client"`) with `media` metadata from wasm ffprobe and no thumbnails.
   - Server: new route → web-wasm toolset (§4.3), server-resolved catalog tools (§7.4), and `unsupported_in_browser` handling (reuse the `unsupported_on_device` path). `/api/chat` unchanged.
   - The old editor keeps its SSE path as long as it is the fallback route.
5. **Captions (D2)**
   - **Default: on-device Whisper** with transformers.js (`whisper-tiny`/`whisper-base`, WebGPU when available, WASM fallback), lazy-loaded on first caption request with a progress bar and cached (Cache Storage/OPFS). Input: wasm audio extraction to 16 kHz mono PCM.
   - **Opt-in, off by default:** "Use cloud transcription for better accuracy, uploads audio only" → `POST /api/v2/transcribe-audio` (Opus 24 kbps, ≤ 25 MB, deleted after use).
   - Bilingual translation: Grok with text only (new `/api/v2/translate-captions` or reuse the text-only path).
   - Burn-in with `subtitles=` / `ass=` in wasm with `fontsdir=/fonts`.
   - Lyric captions: on-device transcript → Grok (text) for song lookup and translation → ASS burned in wasm.
6. **Catalog + generic tool** (§7).
7. **Switch-over (D1)**
   - Deploy `/v2` (build:v2 + nginx snippet via the guarded workflow), run the contract test before and after.
   - Run the e2e suite against production `/v2` (headers + core load + trim). Only when it passes does `/` switch to the new editor; the old editor stays reachable at a fallback route (e.g. `/classic`).
   - The server media routes stay as they are for iOS. Monitor web traffic to them; do **not** gate or change them in this project.
8. **Cleanup (later, separate PRs, each with the contract test)**
   - Only after the old editor is retired: consider lowering body limits for web-only routes. iOS-used routes keep their limits.

### 8.2 Tests

- Vitest:
  - argv snapshots for all ops;
  - intent validator (allowlist/forbidden/paths/ranges, fuzz with weird strings);
  - catalog parser on captured `-h` output;
  - search ranking and response-size budgets (assert serialized ≤ N bytes);
  - mode selection logic.
- Playwright (`tests/e2e/`, Chromium; Firefox and WebKit optional/nightly), each in mt and st modes, with stubbed `/api/chat`:
  - trim, resize (x264), audio fade, add_text (font), add_audio_track (2 inputs), transitions (2 clips), convert to mp3, photo color filter, `run_ffmpeg` recipe (vignette), cancel/timeout, oversize rejection.
  - Every test has the **no-upload network assertion** from §6.
- One live smoke (existing `playwright.config.js` baseURL) that only checks headers, `crossOriginIsolated`, and core load on grepawk.com. No account needed.

### 8.3 CI (`.github/workflows/ci.yml`)

- Existing `test` job unchanged.
- Implemented as a separate workflow `.github/workflows/v2-editor.yml` (ci.yml untouched): `e2e` (unit + Playwright mt/st with no-upload guard, timings in the job summary), `ios-contract` (contract test against the base commit's server, recorded, then against the PR's server with `--compare`: any drift fails), `nginx-v2` (`nginx -t` on nginx 1.18, `/v2` header checks, existing-route header diff).
- New `catalog` job (on changes to `package-lock.json`, `catalog/**`, `scripts/catalog/**`): regenerate and `git diff --exit-code catalog/ public/ffmpeg-catalog/`.
- Run CI on `pull_request` too. Today it only runs on push to `main`.

### 8.4 Deploy (`.github/workflows/deploy-grepawk.yml`)

- Make deploy depend on CI (`workflow_run` or `needs`), so a red e2e blocks the deploy.
- **Contract test around every deploy (D1):** `node tests/contract/ios-endpoints.mjs --base https://grepawk.com --record before.json` before rsync, `--compare before.json` after restart; drift fails the job (and should trigger a rollback).
- The build on the server runs the copy-core script. Alternative: build in Actions and rsync `dist/` (faster, reproducible, no `npm ci` on prod).
- Post-deploy smoke, add:
  - `curl -sI $BASE/ | grep -i 'cross-origin-embedder-policy: require-corp'`;
  - the same for one `/assets/*.js`, `/ffmpeg-core/mt/0.12.10/ffmpeg-core.worker.js`, `/ffmpeg-core/st/0.12.10/ffmpeg-core.wasm` (+ `content-type: application/wasm`);
  - `/ffmpeg-catalog/v1/0.12.10.json` returns 200.
- nginx: add an opt-in step (`DEPLOY_NGINX=true` variable) that copies `nginx.conf` + the snippet, runs `nginx -t` and reloads. Otherwise it stays a documented manual step.

---

## 9. Privacy page update (`public/legal/privacy.html`)

Replace *"On the web, clips you import are uploaded and processed on our servers."* with:

> **Photos and videos (web)** — on grepawk.com your photos and videos are edited **inside your browser** (FFmpeg compiled to WebAssembly). The files are not uploaded to our servers. To understand your request we send your typed text and basic media details (type, duration, resolution, frame rate, codecs, whether there is audio, file size). We send still frames only if you turn that on.

Update the caption bullets:

- **Captions (web):** speech is transcribed **in your browser** (an on-device speech model is downloaded once and cached). Only if you turn on "Use cloud transcription" is an audio-only copy of your clip (compressed, mono) uploaded and sent to OpenAI for speech-to-text, then deleted. Translations send caption text (not audio) to xAI. The video stays in your browser, and burn-in happens in your browser.
- **Lyric captions:** keep the existing audio/OpenAI/xAI text. Change *"On the web, the captions are burned into your video on our server"* to *"…burned in your browser"*.

Also:

- Retention: "Uploaded media" now applies only to iOS Cloud processing and audio for transcription.
- Add a short "Open-source components" line linking `/legal/licenses.html` (added in the spike PR, D4).
- The privacy page itself is **not** changed in the spike PR (the current editor still uploads); update it in the switch-over PR.
- Bump "Last updated".
- Keep App Store privacy-nutrition docs (`docs/asc/PRIVACY_NUTRITION.md`) consistent if the web text is reused there.

---

## 10. Risks and open questions

1. **Memory and iOS Safari.**
   - The mt core asks for a fixed 1 GB heap. Older iPhones may refuse it (fall back to st).
   - st growth beyond about 300–500 MB risks a tab kill on iOS.
   - Today's 100 MB upload cap hides this. Locally, users will try 1–4 GB files.
   - Mitigations: WORKERFS inputs, pre-flight size estimate, prefer stream copy, offer "export at 720p", and refuse with a clear message above a per-device budget.
   - **Decided (D3):** desktop warn 1 GB / block ~1.8 GB; mobile/Safari warn 300 MB / block 500 MB; warn above ~10 min of 1080p; server-configurable.
2. **Speed.** Any video-filter tool re-encodes with x264 in wasm, roughly 10× slower than the server. UX needs progress, cancel, and possibly a "preview at low resolution, then export" pattern. Open question: is a "server render" opt-in still wanted for long clips? That would reintroduce upload, which is a product and privacy decision.
3. **Download size.** About 31 MB wasm per mode (about 8–10 MB compressed) on first edit. Lazy-load it and cache it immutably. Consider a slimmer custom core later (drop x265/theora, add SIMD). That needs our own emscripten build. Attempt #9 shows the Docker setup, but it built no CLI.
4. **FFmpeg version skew.** wasm n5.1.4 vs server 8.x: filter options and help formats differ, there is no HEIF demuxer, and there is no `-display_rotation`. The catalog must come from the wasm build. Typed builders must avoid ≥ 6.0-only options. Watch for ffmpeg.wasm releasing a newer core (last core release 2025-04).
5. **Headers fragility.** The nginx `add_header` inheritance trap already drops COEP on JS. The nginx config is outside the deploy pipeline. Adding Google One Tap, Stripe Elements, analytics or embeds later would break isolation (st fallback still works, only slower). The deploy smoke assertions protect against regressions.
6. **Licensing.** **Decided (D4, D8):** the GPL core is OK. Notices are at `/legal/licenses.html`. The Corresponding Source is served from the same origin at `/v2/vendor/ffmpeg/source/` (about 104 MB across 20 files, checksum-pinned), not via a written offer. Remaining work: the deploy must run `build:v2`, so the source ships with every core version, and bumping the core means regenerating `vendor/ffmpeg-source.lock.json`.
7. **Transcription.** **Decided (D2):** on-device Whisper by default; audio-only cloud transcription is opt-in. Remaining risk: model download size (tiny ≈ 40 MB, base ≈ 75 MB quantised) and speed on phones without WebGPU.
8. **Quota and abuse model change.** Media routes stop being metered for web. Only `/api/chat` turns are charged (turnToken). That should be acceptable. Confirm with pricing.
9. **iOS parity.** iOS already runs most tools natively and uses the server fallback. Should iOS `ffmpeg_cli` move to the same catalog and `run_ffmpeg` intent (executed server-side for iOS)? That would give one validator for both.
10. **WebCodecs alternative.** For pure trims, resizes and color ops, WebCodecs + mp4box could be 5–20× faster (hardware encode). This could be an optimisation path later for hot tools, keeping ffmpeg.wasm as the general engine.
11. **Unknowns to verify in the spike:**
    - ~~x264 thread count vs `PTHREAD_POOL_SIZE` (32)~~ **answered by the spike:** encoder `-threads` must be ≤ 4 on core-mt 0.12.10 (auto/8 hang, 6 aborts);
    - ~~whether `@ffmpeg/ffmpeg` 0.12.15's module worker plus Vite production build needs `worker.format: 'es'`~~ **answered:** `worker: { format: 'es' }` + `optimizeDeps.exclude` works in both `vite build` and `vite` dev;
    - WORKERFS performance on very large `File`s in Safari;
    - `ffprobe` availability and output with core 0.12.10;
    - `loudnorm`/`areverse` memory on 30-min clips.
12. **Housekeeping found during research:**
    - 11 tools are missing on web.
    - Docs count 46 tools vs 47.
    - Dead `public/ffmpeg.{js,wasm}` is still served.
    - Absolute `https://grepawk.com/api/sample-access-token` fetch fails on `www`.
    - `cors` is imported but unused.
    - Duplicate Cache-Control headers on static JS.
