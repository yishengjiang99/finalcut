# Photo support (jpg / png / webp / heic)

The backend edits photos as well as videos. Photos go through a single-frame
FFmpeg pipeline (`-frames:v 1`, image2 muxer) and never get `-ss` / `-t`.

## Detection

`src/server/mediaType.js` → `detectMediaType()`:

1. Magic bytes (JPEG, PNG, WebP, GIF, BMP, TIFF, HEIF `ftyp` brands). These win over
   client hints because older iOS builds label every upload `video/mp4`.
2. Filename extension, then mimetype (`image/*`).
3. ffprobe fallback: exactly one video stream, no audio, image demuxer/codec or a
   single frame with no duration.

## Endpoints

### Async jobs — `POST /api/jobs/process-video`

Multipart field `video` may be a photo. Response now includes `mediaType`:

```json
202 { "jobId": "…", "status": "queued", "mediaType": "image", "pollUrl": "…" }
```

`GET /api/jobs/:id` always includes `mediaType: "image" | "video"`; succeeded jobs
carry `contentType` (`image/jpeg`, `image/png`, `image/webp`, or the video/audio type)
and `resultUrl`. `GET /api/jobs/:id/result` serves that Content-Type plus
`X-Media-Type` and an inline filename with the right extension.

Unsupported photo operations and invalid args are rejected up front with
`400 { "error": "Operation \"trim_video\" is not supported for photos. …" }`.

### Sync — `POST /api/process-video`

Raw body with `Content-Type: image/jpeg|image/png|image/webp|image/heic` (or any
type — bytes are sniffed) and `x-operation` / `x-args` headers. Returns the edited
image with the matching Content-Type and `X-Media-Type: image`.

## Operations

Supported for photos: `resize_video`, `crop_video`, `rotate_video` (quarter turns
use transpose; other angles expand the canvas), `flip_video_horizontal`,
`flip_video_vertical`, `add_text`, `adjust_brightness`, `adjust_contrast`,
`adjust_hue`, `adjust_saturation`, `apply_color_filter`, `convert_image_format`.

`apply_color_filter` args: `filter` (`red`, `green`, `blue`, `yellow`, `cyan`,
`magenta`, `sepia`, `grayscale`, `black_and_white`, `invert`, `warm`, `cool`,
`vintage`) and optional `intensity` 0–1 (default 1). It also works for videos.

Not supported for photos (400): `trim_video`, `speed_video`, every audio op,
captions / `burn_subtitles`, `add_audio_track`, transitions, `fade_transition`,
`convert_video_format`, `convert_audio_format`, `extract_audio`.

Output format: same as input for jpg/png/webp; HEIC → JPEG; gif/bmp/tiff → PNG;
`convert_image_format` accepts `jpg`, `png`, `webp`. WebP output falls back to PNG
if the FFmpeg build has no `libwebp` encoder.

## HEIC status

HEIC is decoded by FFmpeg's HEIF demuxer (FFmpeg ≥ 7.0; iPhone tile-grid HEICs
need ≥ 7.1). If FFmpeg can't read the file, the server tries libheif's
`heif-convert` CLI (`apt install libheif-examples`) and converts to JPEG first.
If neither works the job returns `415` with a message asking for JPEG/PNG.

## Video safety fix

`trim_video` now parses `start`/`end` (seconds or `HH:MM:SS`), skips `-ss` when
`start` is missing, and returns 400 for missing/invalid/reversed times instead of
running `ffmpeg -ss undefined`.
