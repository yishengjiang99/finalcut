# FinalCap iOS: native tool mapping (on-device execution)

**Status:** v1 of the mapping. Phase 2 (`NativeToolExecutor`) implements the rows marked **Native** below.
**Owner:** FinalCut iOS
**Related:**
- Design handoff: [`docs/ios/NATIVE_EDIT_UX.md`](NATIVE_EDIT_UX.md) (PR #83). It defines edit cards, the On device / Cloud badge, the export-only blocking dimmer, the opt-in cloud fallback, and flattening.
- Backend `execution: "client"` chat mode. The draft contract is summarized in [section 5](#5-client-side-json-contract-executionclient). The final schema will be served from `GET /api/tools/schema` (Backend PR pending, no open PR at the time of writing).
- Tool sources of truth: `src/tools.js` (the schema the model sees), `src/toolFunctions.js` (web runners and arg validation), and `src/server/ffmpegOps.js` (server FFmpeg implementation, the **server fallback**).

## 0. Product rule (replaces v1)

The old v1 rule said heavy edits go to the Node/FFmpeg server. It is replaced. The chat model's tool calls now go to the iOS app, and the app applies them **on device** to a non-destructive edit stack. The user does not upload the video or download results. The model receives media metadata and up to 4 thumbnails only.

The server path remains only as an **explicit, per-step, user-approved fallback** for tools with no native version (the **GAP** rows). Every result reports `executedOn: "device" | "server"`.

We do **not** bundle FFmpeg (see [section 4](#4-is-a-small-lgpl-ffmpeg-build-ever-justified)).

## 1. Native building blocks

| Block | Used for |
|---|---|
| `AVMutableComposition` (`insertTimeRange`, `removeTimeRange`, `scaleTimeRange`, `insertEmptyTimeRange`) | Timeline edits: trim, speed, audio delay (and later multi-clip transitions) |
| `AVMutableVideoComposition.videoComposition(with:applyingCIFiltersWithHandler:)` + custom `renderSize` | The whole frame pipeline, run as an ordered chain of Core Image ops over the source frame. One pipeline serves preview, thumbnails (`AVAssetImageGenerator.videoComposition`) and export |
| Core Image: `CIColorControls`, `CIHueAdjust`, `CIColorMatrix`, `CIColorInvert`, `CITemperatureAndTint`, `CIPhotoEffect*`, affine transforms, `cropped(to:)`, source-over compositing | Color, filters, crop, rotate, flip, resize, pad, text overlay, video fades |
| Text: a `CGImage` rendered once per edit with Core Text / UIKit (`NSAttributedString`), then composited as a `CIImage` inside the same CI handler | `add_text`. We chose this over `AVVideoCompositionCoreAnimationTool` because the Core Animation tool is **export-only**: it does not render in `AVPlayer`, so preview would need a separate `AVSynchronizedLayer` path. CI text keeps preview and export identical |
| `AVMutableAudioMix` + `AVMutableAudioMixInputParameters` (`setVolumeRamp`) | Fades (volume ramps) |
| `MTAudioProcessingTap` on the audio-mix input parameters (runs in `AVPlayerItem` and `AVAssetExportSession`) | Gain > 1.0 (audio-mix volume clamps at 1.0), biquad EQ (high-pass, low-pass, bass and treble shelf, peaking), pan |
| `AVPlayerItem(asset: composition)` + `.videoComposition` + `.audioMix` + `audioTimePitchAlgorithm = .spectral` | Live preview. Nothing is rendered until export |
| `AVAssetExportSession` (preset HighestQuality, `outputFileType` .mp4 / .mov / .m4a) | Export, plus the flatten step before a cloud fallback. `AVAssetWriter` is the upgrade path if we need bitrate control or WAV |

## 2. Tool-by-tool mapping

Tool names are the names the model calls (`src/tools.js`). Args are exactly the server/web args, and `*` marks a required arg. "Server op" is the `ffmpegOps` operation the fallback uses when it differs from the tool name.

### 2.1 Priority tools

| Tool | Args | Native mapping | Status |
|---|---|---|---|
| `trim_video` | `start*`: string (seconds or `[[HH:]MM:]SS[.ms]`), `end*`: string | Parse like `parseTimeToSeconds`, then `composition.removeTimeRange` outside `[start, end)` on the current timeline. Validates `end > start` and `start < duration`, and clamps `end` to the duration | **Native** |
| `adjust_speed` (server op `speed_video`) | `speed*`: number > 0 | `composition.scaleTimeRange(full, toDuration: d / speed)` on all tracks. Pitch is preserved with `audioTimePitchAlgorithm = .spectral` on the player item and export session (the equivalent of `atempo`). Range 0.25 to 4 | **Native** |
| `crop_video` | `x*`, `y*`, `width*`, `height*`: integer (top-left origin, pixels of the **current** frame) | CI `cropped(to:)` (y flipped for CI's bottom-left origin) and translate to origin. `renderSize` becomes `width × height`, rounded to even for H.264. Validated against the current canvas, so crops chain | **Native** |
| `rotate_video` | `angle*`: number, degrees, clockwise positive | Multiples of 90: affine rotate, with the canvas swapped for 90 and 270. Other angles: rotate about the center on the same canvas with black fill (matches the server's video `rotate=` behavior) | **Native** (divergence: the server keeps the canvas even for 90°. Native swaps it, like the server's photo path) |
| `flip_video_horizontal` | none | CI affine `scaleX: -1` + translate | **Native** |
| `flip_video_vertical` | none | CI affine `scaleY: -1` + translate | **Native** |
| `adjust_brightness` | `brightness*`: -1…1 | `CIColorControls.inputBrightness` (same -1…1 additive scale as `eq=brightness`) | **Native** |
| `adjust_contrast` | `contrast*`: 0…3 | `CIColorControls.inputContrast` | **Native** |
| `adjust_saturation` | `saturation*`: 0…3 (0 = grayscale) | `CIColorControls.inputSaturation` | **Native** |
| `adjust_hue` | `degrees*`: -360…360 | `CIHueAdjust.inputAngle` in radians | **Native** |
| `apply_color_filter` | `filter*`: red, green, blue, yellow, cyan, magenta, sepia, grayscale, black_and_white, invert, warm, cool, vintage; `intensity`: 0…1 = 1 | `CIColorMatrix` using the **same 3×3 matrices as `buildColorFilter`**, mixed with identity by `intensity` (tints, sepia, grayscale, b&w). `CIColorInvert` for invert. `CITemperatureAndTint` for warm and cool, scaled by intensity. `CIPhotoEffectTransfer` for vintage (closest built-in to `curves=preset=vintage`, which is an approximation) | **Native** |
| `add_text` | `text*`: string; `x` = 10; `y` = 10; `fontsize` = 24; `color` = "white" (name or `#hex`) | Text rendered once to a `CGImage` (system font, size in output pixels, color parsed from the same names and hex as `safeColor`), composited at top-left `(x, y)` on the current canvas | **Native** |
| `adjust_audio_volume` (server op `adjust_volume`) | `volume*`: ≥ 0 (1 = unchanged, 2 = double) | `MTAudioProcessingTap` gain (0…4). The audio-mix volume alone cannot exceed 1.0 | **Native** |
| `audio_fade` | `type*`: in or out; `duration*`: seconds > 0 | `setVolumeRamp` 0→1 over `[0, d]` (in) or 1→0 over `[D−d, D]` (out). Anchored to the **final** timeline, so the fade stays at the start or end after later trims | **Native** (the server reads an undocumented `start` arg, so `afade st=undefined`: a server bug, reported to Backend) |
| `add_video_transition` | `transition*`: crossfade, fade, dissolve, wipe_left, wipe_right, wipe_up, wipe_down, slide_left, slide_right, slide_up, slide_down; `duration` = 1 | **Single clip (today's iOS):** `fade` means fade from and to black in the CI handler (the equivalent of the server's `fade_transition`). **Multi-clip (not yet in the iOS UI):** two alternating composition tracks overlapping by `duration`. crossfade and dissolve use `AVMutableVideoCompositionLayerInstruction.setOpacityRamp`, wipes use `setCropRectangleRamp`, slides use `setTransformRamp`, and audio uses paired volume ramps | **Native** for single-clip `fade`. Other types on a single clip return a validation error ("needs ≥ 2 clips"). Multi-clip is **Planned** (blocked on multi-clip import, not on the server) |

### 2.2 Other frame and format tools

| Tool | Args | Native mapping | Status |
|---|---|---|---|
| `resize_video` | `width*`, `height*`: integer, one side may be -1 (keep aspect) | CI scale (Lanczos) + `renderSize`, rounded to even | **Native** |
| `resize_video_preset` (server op `resize_video` with preset dims) | `preset*`: 9:16, 16:9, 1:1, 2:3, 3:2 | Aspect-fit into the preset size (1080×1920, 1920×1080, 1080×1080, 1080×1620, 1620×1080) on a black canvas (pad). The server stretches with `scale=`; the tool description promises padding, so native follows the description | **Native** |
| `get_video_dimensions` | none | Query only (no stack entry): `load(.duration)`, video track `naturalSize` + `preferredTransform`, `nominalFrameRate`, `formatDescriptions` codec, `hasAudio`. Reports the **edited** dimensions and duration too | **Native** |
| `get_supported_formats` | none | Query only: returns what the device export supports (video: mp4, mov; audio: m4a). Other formats are listed as cloud-only | **Native** |
| `convert_video_format` | `format*`: mp4, mov, webm, avi, mkv, flv, ogv; `codec` = auto | mp4 and mov are an export setting (`outputFileType`), with no re-render until export. webm, avi, mkv, flv and ogv have no AVFoundation writer | **Native** (mp4, mov) / **GAP** (others): server `convert_video_format` |
| `extract_audio` | `format` = mp3 (mp3, wav, aac, ogg, flac, m4a); `bitrate` = 192k | m4a uses `AVAssetExportPresetAppleM4A` on the edited composition | **Native** (m4a) / **GAP** (mp3, wav, aac, ogg, flac): server `extract_audio`. WAV can move native via `AVAssetWriter` LPCM later |
| `convert_audio_format` | `format*`: mp3, wav, aac, ogg, flac, m4a, wma; `bitrate` = 192k | Same as `extract_audio` | **Native** (m4a) / **GAP** (others) |
| `convert_image_format` | `format*`: jpg, png, webp | Photo-only tool. The iOS app imports videos only today. When photos land: `CGImageDestination` for jpg, png and heic (ImageIO cannot write webp, so webp stays GAP) | **GAP / N/A** (server photo pipeline) |

### 2.3 Audio tools

| Tool | Args | Native mapping | Status |
|---|---|---|---|
| `audio_highpass` (server op `highpass_filter`) | `frequency*` = 200 Hz | Tap: RBJ biquad high-pass, Q 0.707 (same as ffmpeg `highpass` default) | **Native** |
| `audio_lowpass` (server op `lowpass_filter`) | `frequency*` = 3000 Hz | Tap: RBJ biquad low-pass, Q 0.707 | **Native** |
| `adjust_bass` (server op `bass_adjustment`) | `gain*`: -20…20 dB | Tap: low-shelf at 100 Hz (ffmpeg `bass` default f = 100) | **Native** |
| `adjust_treble` (server op `treble_adjustment`) | `gain*`: -20…20 dB | Tap: high-shelf at 3000 Hz (ffmpeg `treble` default f = 3000) | **Native** |
| `audio_equalizer` (server op `equalizer`) | `frequency*`; `width` = 200 Hz; `gain*`: -20…20 dB | Tap: RBJ peaking EQ, Q = f / width (width_type = h) | **Native** |
| `audio_pan` | `pan*`: -1…1 | Tap: same linear law as the server (`pan<0` attenuates R by `1+pan`; `pan>0` attenuates L). A mono source is unchanged, as on the server | **Native** |
| `audio_delay` (server op `delay_audio`) | `delay*`: ms ≥ 0 | Composition: `insertEmptyTimeRange` at 0 on the audio track, then truncate at the video end | **Native** |
| `normalize_audio` | `target*`: LUFS ≤ 0 = -16 | Would need a loudness analysis pass (`AVAssetReader`, BS.1770 K-weighting), then tap gain. Feasible, but not true `loudnorm` (two-pass dynamic) | **GAP**: server `normalize_audio`. Planned native (static-gain approximation) |
| `audio_echo` (server op `echo_effect`) | `delay*`: ms; `decay*`: 0…1 | Tap with a delay line (feasible) | **GAP**: server `echo_effect`. Planned native (tap delay line) |
| `audio_tremolo` | `frequency` = 5; `depth` = 0.5 | Tap with an LFO gain (feasible) | **GAP**: server `audio_tremolo`. Planned native |
| `audio_reverse` | none | Needs the whole track reversed: offline `AVAssetReader` → reversed PCM file → re-insert | **GAP**: server `audio_reverse` |
| `audio_chorus` | `in_gain`, `out_gain`, `delays`, `decays`, `speeds`, `depths` | No AVFoundation equivalent in the composition path (the AVAudioUnit effects are AVAudioEngine-only) | **GAP**: server `audio_chorus` |
| `audio_flanger` | `delay`, `depth`, `regen`, `width`, `speed` | Same as chorus | **GAP**: server `audio_flanger` |
| `audio_phaser` | `in_gain`, `out_gain`, `delay`, `decay`, `speed` | Same as chorus | **GAP**: server `audio_phaser` |
| `audio_vibrato` | `frequency` = 5; `depth` = 0.5 | Same as chorus (pitch modulation) | **GAP**: server `audio_vibrato` |
| `audio_compressor` | `threshold` = 0 dB (-60…0); `ratio` = 4 (1…20); `attack` = 20 ms; `release` = 250 ms | `AUDynamicsProcessor` exists but only via AVAudioEngine offline render, not in the live composition | **GAP**: server `audio_compressor` |
| `audio_dynamic_normalize` | `mode` = dynaudnorm (dynaudnorm or compand); dynaudnorm: `frame_length` = 150, `gaussian_size` = 31; compand: `attacks` = 0.3, `decays` = 0.8, `points`, `gain` = 3 | None | **GAP**: server `audio_dynamic_normalize` |
| `audio_gate` | `threshold` = -50 dB; `ratio` = 2; `attack` = 20; `release` = 250 | None (would need a custom tap gate) | **GAP**: server `audio_gate` |
| `audio_limiter` | `level` = 1 (0.5…1); `attack` = 5; `release` = 50 | `AUPeakLimiter` is AVAudioEngine-only | **GAP**: server `audio_limiter` |
| `audio_stereo_widen` | `delay` = 20; `feedback` = 0.3; `crossfeed` = 0.3 | None | **GAP**: server `audio_stereo_widen` |
| `audio_silence_remove` | `start_threshold` = -50; `start_duration` = 0.5; `stop_threshold` = -50; `stop_duration` = 0.5 | Feasible later: an `AVAssetReader` level scan, then `trim` edits | **GAP**: server `audio_silence_remove`. Planned native (scan + trim) |
| `add_audio_track` | `audioFile*`: string (base64 or file ref); `mode` = replace (replace or mix); `volume` = 1 (0…2) | Mechanically trivial natively (second `AVURLAsset` inserted into a new composition audio track, plus a volume param). Blocked on the contract: the model cannot supply audio bytes, so we need a media-reference scheme for user-picked audio | **GAP** (sync multipart server `add_audio_track`; not available via jobs) |
| `generate_captions` | `language` = auto; `translate_language`; `style` = default (default, white_on_black, yellow); `position` = bottom (bottom or top); `burn_in` = true | Speech-to-text and translation are server features (OpenAI STT, Grok translate). Burn-in itself could be native (CI text per SRT cue). Planned optimization: upload **audio only** (m4a from the device) instead of the video | **GAP**: server `/api/generate-captions` (+ `/api/translate-captions`, + sync `burn_subtitles`) |

### 2.4 Legacy names (web `toolFunctions` only, not in the schema)

`toolFunctions.js` also exposes these names. The model does not see them (they are not in `tools.js`), but the executor accepts them as **aliases** so a replayed or legacy call still resolves:

| Legacy name | Canonical tool |
|---|---|
| `adjust_volume` | `adjust_audio_volume` |
| `highpass_filter` / `lowpass_filter` | `audio_highpass` / `audio_lowpass` |
| `echo_effect` | `audio_echo` |
| `bass_adjustment` / `treble_adjustment` | `adjust_bass` / `adjust_treble` |
| `equalizer` | `audio_equalizer` |
| `delay_audio` | `audio_delay` |
| `get_video_info` | `get_video_dimensions` |
| `resize_to_aspect_ratio` (`ratio`, `fit`) | `resize_video_preset` (`preset`) |
| `convert_to_format` | stub on web ("not yet implemented"). **GAP**, no-op |

Found while auditing: `audio_chorus`, `audio_flanger`, `audio_phaser`, `audio_vibrato`, `audio_tremolo`, `audio_gate`, `audio_stereo_widen`, `audio_reverse`, `audio_limiter`, `audio_silence_remove` and `audio_pan` are in the model schema and in `ffmpegOps`, but have **no** `toolFunctions` runner. On web today, these calls throw `toolFunctions[funcName] is not a function`. That is a web issue for Backend/Web and does not affect iOS client mode.

### 2.5 Summary

The schema has 46 tools: 26 native, 3 partially native, and 17 GAP.


- **Native (26):** trim_video, adjust_speed, crop_video, rotate_video, flip_video_horizontal, flip_video_vertical, resize_video, resize_video_preset, adjust_brightness, adjust_contrast, adjust_saturation, adjust_hue, apply_color_filter, add_text, adjust_audio_volume, audio_fade, audio_highpass, audio_lowpass, adjust_bass, adjust_treble, audio_equalizer, audio_pan, audio_delay, add_video_transition (single-clip `fade`), get_video_dimensions, get_supported_formats
- **Partially native (3):** convert_video_format (mp4, mov), extract_audio (m4a), convert_audio_format (m4a). The other formats are GAP and go to the server.
- **GAP, server fallback (17):** normalize_audio, audio_echo, audio_tremolo, audio_reverse, audio_chorus, audio_flanger, audio_phaser, audio_vibrato, audio_compressor, audio_dynamic_normalize, audio_gate, audio_limiter, audio_stereo_widen, audio_silence_remove, add_audio_track, generate_captions, plus convert_image_format (photo-only, N/A in the video app).
- **Planned native next (no FFmpeg needed):** audio_echo and audio_tremolo (tap), normalize_audio (static gain), audio_silence_remove (scan + trim), multi-clip transitions, extract_audio/convert_audio_format to wav (`AVAssetWriter`), captions burn-in (CI text).

## 3. Edit stack semantics (what the executor does)

- **Value types.** `EditStack` is a struct holding `[EditEntry]`. Each entry holds `id`, `toolCallId`, `tool`, a typed `EditOperation` enum, `enabled`, and `executedOn`. The base clip is a URL. Nothing mutates the source file.
- **Order.** Timeline ops (trim, speed, audio delay) apply to the composition in stack order, so later trims use the current timeline. Frame ops form an ordered CI chain, so a crop after a rotate uses rotated coordinates. **Anchored** ops (audio fade, the single-clip video fade) apply to the final timeline.
- **Validation.** Args are validated with the same rules as `toolFunctions.js` and `ffmpegOps.js`, plus against the current canvas and duration from a dry-run fold of the stack. Failures return `ok: false` with an error. The stack is not changed.
- **Undo, toggle and delete** follow NATIVE_EDIT_UX §3. Removing an entry re-validates the entries after it. Entries that become invalid (for example a crop that no longer fits) are removed with it, and the card reports "Also removes N later edits".
- **Preview.** `AVPlayerItem(asset: composition)` with `videoComposition`, `audioMix` and a spectral pitch algorithm, rebuilt when the stack changes. Nothing renders until export.
- **Export.** `AVAssetExportSession` with determinate progress and Cancel. On cancel, the stack is untouched.
- **Cloud step (flattening).** Only after the user taps "Process in cloud":
  1. Export (flatten) the current stack to a file.
  2. Upload it to the server op (`/api/jobs/process-video`, or the sync route for captions).
  3. The downloaded result becomes the **new base**, with an empty stack.
  4. The pre-cloud `(base, stack)` pair is pushed onto `history`. Undoing the cloud step pops it and restores the previous base and edits. Later device edits stack on the new base.

## 4. Is a small LGPL FFmpeg build ever justified?

**Default: no, and nothing in this audit changes that.**

- **What it would buy:** the GAP list is almost entirely audio effects (chorus, flanger, phaser, vibrato, compressor, gate, limiter, dynaudnorm/compand, stereowiden, loudnorm, silence removal, reverse) and exotic containers (webm, mkv, avi, flv, ogv, mp3, ogg, flac, wma).
- **Why that does not justify it:**
  1. The priority tools are 100% native. The GAPs are low-frequency requests, and the server fallback already covers them with an explicit opt-in.
  2. Most audio GAPs can move native without FFmpeg. We can use more tap DSP (echo, tremolo, gate) or an AVAudioEngine offline render with Apple's `AUDynamicsProcessor`, `AUPeakLimiter`, `AUDelay` and `AUDistortion` at export time (compressor, limiter, chorus-like effects), or an analysis pass (normalize, silence removal).
  3. The containers matter little on iOS. Photos and share targets want mp4/mov/m4a, and the outliers are a cloud step.
  4. Cost and risk. ffmpeg-kit is retired upstream, so we would own the build. LGPL on iOS in practice means dynamic frameworks, shipping relinkable objects or source-offer obligations, and no GPL components (so no x264/x265 and several filters). It adds 10 to 30 MB to the binary and complicates App Store review.
- **When we would revisit:** only if a real product requirement needs something that is (a) not doable with AVFoundation, Core Image, Core Audio or AVAudioEngine, (b) frequent enough that the cloud-step upload is an unacceptable UX or privacy cost, and (c) coverable by an LGPL-only filter set (for example on-device webm/VP9 export for a named partner integration). None of these apply today.

## 5. Client-side JSON contract (`execution: "client"`)

This is the Backend **draft**, which iOS implements now. Final field names come from Backend's PR and `GET /api/tools/schema` (`schemaVersion: "1"`). All encoding and decoding lives in `ClientToolContract.swift`, so a rename is a one-file change. Decoding is lenient (for example, `arguments` is accepted as an object or a JSON string).

### 5.1 Request (iOS → `POST /api/chat`)

```json
{
  "execution": "client",
  "schemaVersion": "1",
  "messages": [
    { "role": "user", "content": "make it black and white and trim to the first 5 seconds" }
  ],
  "media": { "type": "video", "duration": 6.0, "width": 1280, "height": 720, "fps": 30, "hasAudio": true },
  "thumbnails": ["data:image/jpeg;base64,/9j/…"]
}
```

- `media` describes the **current edited** clip (after the stack), so the model reasons about what the user sees.
- `thumbnails` holds at most 4 JPEGs, longest side ≤ 512 px, quality 0.6. They are sampled evenly from the edited composition via `AVAssetImageGenerator` + `videoComposition`. The field name and encoding (data URLs) are **placeholders** until Backend's schema lands.

### 5.2 Response (server → iOS)

```json
{ "schemaVersion": "1", "status": "tool_calls",
  "toolCalls": [ { "id": "call_1", "name": "apply_color_filter", "arguments": { "filter": "black_and_white" } },
                 { "id": "call_2", "name": "trim_video", "arguments": { "start": "0", "end": "5" } } ] }
```

`arguments` has **exactly** the shape of today's toolFunctions args (section 2). A final turn looks like `{ "schemaVersion": "1", "status": "final", "message": { "role": "assistant", "content": "Done." } }`. iOS also accepts `content` or `text` at the top level until the field is final.

### 5.3 Tool results (iOS → `POST /api/chat`, same conversation)

For each call, in call order, iOS appends the assistant turn with its `tool_calls` and then one tool message per call:

```json
{ "role": "tool", "tool_call_id": "call_1", "name": "apply_color_filter",
  "content": "{\"ok\":true,\"executedOn\":\"device\"}" }
```

The result object is `{ ok, error?, executedOn: "device" | "server" }`. iOS may add `summary` (for example `"Trimmed to 0:00–0:05 (5.0 s)"`) and `media` (the updated media object) so the model sees the effect. It is sent as a JSON string in `content`, the OpenAI-compatible shape; this is a **placeholder** if Backend prefers an object.

| Situation | Result |
|---|---|
| Applied on device | `{ ok: true, executedOn: "device" }` |
| Validation error on device | `{ ok: false, error: "<message>", executedOn: "device" }` |
| GAP, user tapped "Process in cloud" and it succeeded | `{ ok: true, executedOn: "server" }` |
| GAP, cloud step failed | `{ ok: false, error: "<server error>", executedOn: "server" }` |
| GAP, user tapped "Skip this step" | `{ ok: false, error: "skipped_by_user", executedOn: "device" }`. Backend tells the model the step was declined |
| Unknown tool | `{ ok: false, error: "unknown_tool", executedOn: "device" }` |

The loop repeats until `status: "final"`. Rounds are **capped server-side**, so iOS has no retry or round logic of its own beyond handling `final` (plus a defensive local cap of 8 rounds against a misbehaving server).

### 5.4 Behavior when client mode isn't live

The client path sits behind `NativeEditingFlags.clientExecution` (UserDefaults key `native.clientExecution`, default **off** until Backend ships). With the flag off, the existing path is unchanged (captions three-step flow, jobs API). With the flag on, a server response that is not client-mode JSON (for example an SSE stream from an older server, or HTTP 400) falls back to the existing path for that message.

### 5.5 Depends on Backend (open items)

1. The final names for `thumbnails` and the final-message field, plus whether the tool `content` is a string or an object.
2. `GET /api/tools/schema`. iOS will diff it against `NativeToolExecutor.supportedTools` at launch and treat any tool it doesn't know as a GAP.
3. `mediaType` on job results (for cloud steps on photos, later).
4. The server `audio_fade` `start` bug (`afade st=undefined`) affects cloud parity only. Native doesn't use `start`.

## 6. Privacy

Thumbnails and metadata go to the model. Full video is uploaded only on a cloud step the user approves. See `docs/asc/PRIVACY_NUTRITION.md` and `public/legal/privacy.html`, which are updated in the same change as the client-mode wiring.
