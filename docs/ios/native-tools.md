# FinalCap iOS: native tool mapping (on-device execution)

**Status:** v2 (replaces v1 from PR #86). Product rule changed: **no uploads on iOS by default.**
**Owner:** FinalCut iOS
**Source of truth for tools:** [`docs/api/tools-schema.v1.json`](../api/tools-schema.v1.json) (`schemaVersion: "1"`, 46 tools), served live at `GET /api/tools/schema`.
**Related:** [`docs/api/CLIENT_TOOL_EXECUTION.md`](../api/CLIENT_TOOL_EXECUTION.md) (client-mode contract, Backend #85), [`NATIVE_EDIT_UX.md`](NATIVE_EDIT_UX.md) (edit cards, badges, photo mode, error codes), [`docs/PHOTO_SUPPORT.md`](../PHOTO_SUPPORT.md) (server photo pipeline, cloud path only).

## 0. Product rule

- The chat model's tool calls are executed **on the iPhone** against a non-destructive edit stack. The preview updates immediately from a composed `AVPlayerItem`; a file is written **only on export**.
- **Nothing is uploaded by default.** The model receives media metadata (type, duration, width, height, fps, hasAudio) and up to 4 JPEG thumbnails through `/api/chat` in `execution: "client"` mode. That is the only data that leaves the device.
- A tool with no on-device implementation returns `{ "ok": false, "error": "unsupported_on_device", "executedOn": "device" }` to the model, which can pick another approach or explain.
- The server path (`/api/jobs/process-video`) runs **only** when the user turns on **Settings → Allow cloud processing** (default **off**). Photos going to the cloud path are converted HEIC/HEIF → upright JPEG first (prod FFmpeg 4.4 has no HEIF decoder); on-device photo edits need no conversion.
- We do **not** bundle FFmpeg (section 4).

## 1. Native building blocks

| Block | Used for |
|---|---|
| `AVMutableComposition` (`insertTimeRange`, `removeTimeRange`, `scaleTimeRange`, `insertEmptyTimeRange`) | Timeline: trim, speed, audio delay, silence removal, (multi-clip concat/transitions later) |
| `AVMutableVideoComposition(asset:applyingCIFiltersWithHandler:)` + custom `renderSize` | One ordered Core Image chain per frame: crop, rotate, flip, resize/pad, color controls, color filters, text, captions burn-in, single-clip fade. Same object drives preview (`AVPlayerItem.videoComposition`), thumbnails (`AVAssetImageGenerator`) and export |
| Text and captions | Rendered once per string to a `CGImage` (Core Text) and composited in the CI handler at the frame's `compositionTime`. This is the preview-capable equivalent of `AVVideoCompositionCoreAnimationTool` (which is export-only and needs a separate `AVSynchronizedLayer` for preview); preview and export stay pixel-identical |
| `AVMutableAudioMix` (`setVolume`, `setVolumeRamp`) | Volume ≤ 1, fades |
| Offline audio render: `AVAssetReader` (composition + audio mix) → PCM → `AVAudioEngine` manual rendering (`AVAudioUnitEQ`, `AVAudioUnitDelay`, `AUDynamicsProcessor`, `AUPeakLimiter`) and small Swift DSP (biquads, gain, pan, LFO, gate, reverse) → `.caf` → re-inserted as the composition's audio track | Gain > 1, EQ/filters, echo, pan, dynamics, tremolo, reverse, normalize |
| Core Image on `CIImage(contentsOf:)` with orientation applied | Photos: every frame tool above, written with `CIContext` (`jpeg`/`png`/`heif` representation) on export |
| `AVAssetExportSession` | Export (mp4/mov/m4a) with progress and Cancel. Background continuation: `BGContinuedProcessingTask` (iOS 26+), `beginBackgroundTask` (iOS 17–25) |
| Speech: `SpeechAnalyzer`/`SpeechTranscriber` (iOS 26+), `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true` (iOS 17–25) | On-device captions → SRT/VTT, burn-in via the CI text path |

## 2. Tool-by-tool mapping (all 46 schema tools)

`*` = required arg. "Build" = the TestFlight build the native path ships in ("10" = build 10, "next" = follow-up). Status is **Native**, **Partial** (some arg values native, the rest `unsupported_on_device`) or **GAP** (always `unsupported_on_device` unless cloud processing is allowed).

### 2.1 Timeline and frame

| Tool | Args | Native implementation | Status | Build |
|---|---|---|---|---|
| `trim_video` | `start*`, `end*` (seconds or `[[HH:]MM:]SS[.ms]`) | Composition `removeTimeRange` outside `[start, end)` on the current timeline; validates `end > start`, clamps to duration | Native | 10 |
| `adjust_speed` | `speed*` (0.25–4) | Composition `scaleTimeRange(full → d/speed)`; pitch kept with `audioTimePitchAlgorithm = .spectral` | Native | 10 |
| `crop_video` | `x*`, `y*`, `width*`, `height*` (top-left origin, current canvas px) | CI `cropped(to:)` (y flipped) + translate; `renderSize` = crop (even) | Native | 10 |
| `rotate_video` | `angle*` (deg, clockwise) | 90° multiples: affine + canvas swap; other angles: rotate about centre, same canvas, black fill | Native | 10 |
| `flip_video_horizontal` | – | CI affine `scaleX: -1` | Native | 10 |
| `flip_video_vertical` | – | CI affine `scaleY: -1` | Native | 10 |
| `resize_video` | `width*`, `height*` (one may be -1) | CI Lanczos scale + `renderSize` (even) | Native | 10 |
| `resize_video_preset` | `preset*` 9:16, 16:9, 1:1, 2:3, 3:2 | Aspect-fit onto a black canvas of the preset size (pad, as the description promises) | Native | 10 |
| `adjust_brightness` | `brightness*` (-1…1) | `CIColorControls.inputBrightness` | Native | 10 |
| `adjust_contrast` | `contrast*` (0…3) | `CIColorControls.inputContrast` | Native | 10 |
| `adjust_saturation` | `saturation*` (0…3) | `CIColorControls.inputSaturation` | Native | 10 |
| `adjust_hue` | `degrees*` | `CIHueAdjust` (radians) | Native | 10 |
| `apply_color_filter` | `filter*` red, green, blue, yellow, cyan, magenta, sepia, grayscale, black_and_white, invert, warm, cool, vintage; `intensity` 0…1 | `CIColorMatrix` with the server's `buildColorFilter` matrices mixed with identity by intensity; warm/cool as colour-matrix channel gains (R/B), `CIColorInvert`, `CIPhotoEffectTransfer` for vintage, black_and_white = grayscale + high contrast | Native | 10 |
| `add_text` | `text*`; `x`=10, `y`=10, `fontsize`=24, `color`="white" | Core Text → `CGImage`, composited top-left at (x, y) in the CI chain | Native | 10 |
| `add_video_transition` | `transition*`, `duration`=1 | Single clip: `fade` = fade from/to black in the CI chain. Other types need ≥ 2 clips (multi-clip import not in the iOS UI yet) | Partial | next |
| `get_video_dimensions` | – | Local query of the **edited** clip (size, duration, fps, hasAudio) | Native | 10 |
| `get_supported_formats` | – | Local answer: video mp4, mov; audio m4a, wav; image jpg, png, heic | Native | 10 |

### 2.2 Audio

| Tool | Args | Native implementation | Status | Build |
|---|---|---|---|---|
| `adjust_audio_volume` | `volume*` (≥ 0) | ≤ 1: audio-mix `setVolume`; > 1: offline render gain (clipped) | Native | 10 |
| `audio_fade` | `type*` in/out, `duration*`, optional `start` (Backend #92) | Audio-mix `setVolumeRamp` anchored to the final timeline (fade in from `start`/0, fade out ending at clip end) | Native | 10 |
| `audio_delay` | `delay*` ms | Composition `insertEmptyTimeRange` on the audio track, truncated at the video end | Native | next |
| `audio_highpass` | `frequency*` | Offline render: RBJ biquad HP, Q 0.707 (`AVAudioUnitEQ` .highPass) | Native | next |
| `audio_lowpass` | `frequency*` | Offline render: biquad LP | Native | next |
| `adjust_bass` | `gain*` dB | Offline render: low shelf 100 Hz | Native | next |
| `adjust_treble` | `gain*` dB | Offline render: high shelf 3 kHz | Native | next |
| `audio_equalizer` | `frequency*`, `width`=200, `gain*` | Offline render: peaking EQ, Q = f / width | Native | next |
| `audio_pan` | `pan*` (-1…1) | Offline render: server's linear law; mono unchanged | Native | next |
| `audio_echo` | `delay*` ms, `decay*` | Offline render: feedback delay line (`AVAudioUnitDelay` equivalent) | Native | next |
| `audio_tremolo` | `frequency`=5, `depth`=0.5 | Offline render: LFO gain | Native | next |
| `audio_reverse` | – | Offline render: PCM reversed | Native | next |
| `normalize_audio` | `target*` LUFS | Offline: BS.1770 loudness analysis → static gain (approximation of 2-pass `loudnorm`) | Native | next |
| `audio_compressor` | `threshold`, `ratio`, `attack`, `release` | Offline render: feed-forward compressor (`AUDynamicsProcessor` equivalent) | Native | next |
| `audio_limiter` | `level`, `attack`, `release` | Offline render: peak limiter (`AUPeakLimiter` equivalent) | Native | next |
| `audio_gate` | `threshold`, `ratio`, `attack`, `release` | Offline render: downward expander/gate | Native | next |
| `audio_silence_remove` | `start_threshold`, `start_duration`, `stop_threshold`, `stop_duration` | `AVAssetReader` level scan → composition `removeTimeRange` for silent spans | Native | next |
| `audio_chorus` | `in_gain`, `out_gain`, `delays`, `decays`, `speeds`, `depths` | No Apple AU; would need custom modulated-delay DSP | GAP | – |
| `audio_flanger` | `delay`, `depth`, `regen`, `width`, `speed` | No Apple AU; custom DSP | GAP | – |
| `audio_phaser` | `in_gain`, `out_gain`, `delay`, `decay`, `speed` | No Apple AU; custom all-pass chain | GAP | – |
| `audio_vibrato` | `frequency`, `depth` | No Apple AU; custom pitch-modulation DSP | GAP | – |
| `audio_stereo_widen` | `delay`, `feedback`, `crossfeed` | No Apple AU; custom DSP | GAP | – |
| `audio_dynamic_normalize` | `mode` dynaudnorm/compand + params | No equivalent to dynaudnorm/compand curves | GAP | – |
| `add_audio_track` | `audioFile*`, `mode`, `volume` | Mechanically native (second composition audio track), but the contract has no way to reference user-picked audio (the model can't supply bytes) | GAP | – |

### 2.3 Captions and formats

| Tool | Args | Native implementation | Status | Build |
|---|---|---|---|---|
| `generate_captions` | `language`=auto, `translate_language`, `style`, `position`, `burn_in`=true | On-device speech (SpeechTranscriber iOS 26+, SFSpeechRecognizer on-device iOS 17–25) → SRT/VTT; burn-in via CI text per cue. `translate_language` has no on-device translator in the edit path → `unsupported_on_device` for that part | Partial | next |
| `convert_video_format` | `format*` mp4, webm, mov, avi, mkv, flv, ogv | mp4/mov = export container setting; others have no AVFoundation writer | Partial | 10 (mp4/mov) |
| `extract_audio` | `format` mp3, wav, aac, ogg, flac, m4a | m4a (`AVAssetExportPresetAppleM4A`), wav (`AVAssetWriter` LPCM); others not writable | Partial | next |
| `convert_audio_format` | `format*` mp3, wav, aac, ogg, flac, m4a, wma | Same as `extract_audio` | Partial | next |
| `convert_image_format` | `format*` jpg, png, webp | Photos: `CIContext` jpeg/png representation on export; ImageIO can't write webp | Partial | 10 (jpg/png) |

### 2.4 Summary

- **Native (33):** trim_video, adjust_speed, crop_video, rotate_video, flip_video_horizontal, flip_video_vertical, resize_video, resize_video_preset, adjust_brightness, adjust_contrast, adjust_saturation, adjust_hue, apply_color_filter, add_text, get_video_dimensions, get_supported_formats, adjust_audio_volume, audio_fade, audio_delay, audio_highpass, audio_lowpass, adjust_bass, adjust_treble, audio_equalizer, audio_pan, audio_echo, audio_tremolo, audio_reverse, normalize_audio, audio_compressor, audio_limiter, audio_gate, audio_silence_remove.
- **Partial (6):** add_video_transition (single-clip fade), generate_captions (no on-device translation), convert_video_format (mp4/mov), extract_audio (m4a/wav), convert_audio_format (m4a/wav), convert_image_format (jpg/png).
- **GAP (7):** audio_chorus, audio_flanger, audio_phaser, audio_vibrato, audio_stereo_widen, audio_dynamic_normalize, add_audio_track.
- **Build 10 scope:** the 18 tools marked "10" plus mp4/mov and jpg/png formats, photo mode, and the no-upload default. Everything marked "next" returns `unsupported_on_device` in build 10.

Legacy aliases (`adjust_volume`, `highpass_filter`, `lowpass_filter`, `echo_effect`, `bass_adjustment`, `treble_adjustment`, `equalizer`, `delay_audio`, `speed_video`, `get_video_info`) resolve to the canonical tool before dispatch.

## 3. Edit stack

- `EditStack` is a value type: `base` (source URL, never modified) + ordered `[EditEntry]` (`id`, `toolCallId`, `tool`, typed `NativeOp`, `executedOn`).
- Timeline ops fold into an `AVMutableComposition` in stack order. Frame ops form an ordered CI chain evaluated per frame, so a crop after a rotate uses rotated coordinates. Fades are anchored to the final timeline.
- Every call is validated against the folded canvas/duration before it is pushed; a failure returns `{ok:false, error, executedOn:"device"}` and leaves the stack unchanged.
- Undo pops the last entry. The preview item is rebuilt from the stack after every change (cheap: no rendering until export).
- A cloud step (only with **Allow cloud processing** on) flattens the stack to a file, uploads it, and the result becomes the new base; the pre-cloud `(base, stack)` stays in history for undo.

## 4. Is a small LGPL FFmpeg build ever justified?

No. The GAP list is six niche audio effects plus `add_audio_track` (a contract gap, not a codec gap) and exotic containers. All can be done later with custom DSP or stay unsupported. FFmpeg on iOS would add 10–30 MB, LGPL relinking obligations, no GPL encoders, and a build we own (ffmpeg-kit is retired).

## 5. Client-mode contract (as implemented)

Per [`CLIENT_TOOL_EXECUTION.md`](../api/CLIENT_TOOL_EXECUTION.md):

- Request `POST /api/chat`: `{ execution: "client", messages, media: {type, duration, width, height, fps, hasAudio}, thumbnails? }`. `thumbnails` are raw base64 or data URLs, at most 4, each at most 300 KB.
- Response: `{ schemaVersion: "1", status: "tool_calls" | "final", toolCalls: [{id, name, arguments}], messages, round, maxRounds, message? }`. The final text is the string `message`. The server echoes `messages`; iOS continues from the echo.
- Tool results are appended as `{ role: "tool", tool_call_id, content: { ok, error?, executedOn: "device" | "server", output?: { duration, width, height } } }`.
- Rounds are capped server-side (`maxRounds` 6); iOS only loops until `status: "final"` (plus a defensive local cap).

| Situation | Tool result |
|---|---|
| Applied on device | `{ ok: true, executedOn: "device", output: { duration, width, height } }` |
| Invalid / missing args | `{ ok: false, error: "invalid_arguments", executedOn: "device" }` |
| Photo, video-only tool | `{ ok: false, error: "unsupported_for_photo", executedOn: "device" }` |
| No native implementation (default) | `{ ok: false, error: "unsupported_on_device", executedOn: "device" }` |
| Cloud processing allowed, server succeeded | `{ ok: true, executedOn: "server" }` |
| Cloud processing allowed, server failed | `{ ok: false, error: "<stable code>", executedOn: "server" }` |

## 6. Privacy

Media stays on the device. The model gets metadata and up to 4 thumbnails per chat turn. Full media is uploaded only when the user has turned on **Allow cloud processing** and a step needs it. See `docs/asc/PRIVACY_NUTRITION.md` and `public/legal/privacy.html`.

## iOS allowlist (build 10)

Requests from the app send `User-Agent: FinalCap-iOS/<CFBundleVersion>` (build 10 → `FinalCap-iOS/10`). For that build and later, the server should expose **only** these 20 tools to the model. Anything else still gets `{ ok: false, error: "unsupported_on_device", executedOn: "device" }` from the app as a safety net.

```
trim_video
adjust_speed
crop_video
rotate_video
flip_video_horizontal
flip_video_vertical
resize_video
resize_video_preset
adjust_brightness
adjust_contrast
adjust_saturation
adjust_hue
apply_color_filter
add_text
adjust_audio_volume
audio_fade
get_video_dimensions
get_supported_formats
convert_video_format
convert_image_format
```

Argument restrictions on device (other values return `invalid_arguments`, so ideally narrow the enums in the filtered schema too):

- `convert_video_format.format`: `mp4`, `mov` only.
- `convert_image_format.format`: `jpg`, `png` only.
- `adjust_speed.speed`: 0.25–4.
- Photos: only the frame tools (`crop_video`, `rotate_video`, `flip_video_*`, `resize_video`, `resize_video_preset`, `adjust_*` colour tools, `apply_color_filter`, `add_text`, `convert_image_format`, `get_video_dimensions`, `get_supported_formats`). Timeline/audio tools return `unsupported_for_photo`.
