# youtube_soundtrack: a YouTube link becomes the video's soundtrack

The user pastes a YouTube link in chat and asks for its audio as the soundtrack.
The client sends **only the link** to the server; the server extracts the audio and
returns an AAC file; the client mixes it into the video locally. No video is
uploaded and no YouTube video is downloaded — audio only.

Code: `server/tools/youtube-audio-tool.js` (endpoint + extraction + cache).
The tool definition is shared (`youtube_soundtrack` in `src/tools.js`); its iOS
gate (`YOUTUBE_SOUNDTRACK_MIN_BUILD`) and iOS description override live in
`src/server/iosToolAllowlist.js`. Tests: `src/test/youtube-audio-tool.test.js`
(endpoint), `src/test/youtube-soundtrack-web.test.js` (web tool + argv builder).

**Clients.** The web editor shipped first (see "Web flow"). The iOS app follows in
a later round on the same endpoint: gate, description override and contract are
in place (`docs/ios/native-tools.md` §5c describes the planned on-device flow);
no shipped iOS build has an executor yet.

## Chat tool

`youtube_soundtrack` is an agentic tool, executed by the client (client mode).
Offered to every web client, and to FinalCap-iOS builds ≥ 13
(`YOUTUBE_SOUNDTRACK_MIN_BUILD`).

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `url` | string, required | | The pasted YouTube link (watch / youtu.be / Shorts / live / music.youtube.com) or a bare video id. |
| `start_offset` | number ≥ 0 | 0 | Seconds into the YouTube audio where the soundtrack starts. |
| `original_volume` | number 0–1 | 0 | Level of the video's own audio under the soundtrack. 0 = muted (the YouTube audio is the soundtrack). |

## Web flow

In the web editor (`src/toolFunctions.js` → `youtube_soundtrack`), a chat turn
that calls the tool:

1. POSTs `{ url }` to `/api/youtube-audio/fetch` (session auth, or the
   sample-access token in sample mode, like the ffmpeg-cli calls).
2. Reads the AAC bytes plus the `X-Audio-Duration` / `X-Audio-Title` headers and
   refuses a `start_offset` past the end of the audio.
3. Applies the soundtrack through the existing ffmpeg.wasm audio path
   (`engine.addAudioTrack`, `buildAddAudioTrackArgs` in `src/wasm/ops/multi.js`):
   mode `replace` when `original_volume` is 0, else `mix` with the original
   track scaled to `original_volume`; the new track starts at `start_offset`
   (input seek), plays at full volume, and is padded/trimmed to exactly the
   video's length. Server error codes ride back to the model on the tool result
   (`lastExecution.errorCode`), so the chat can react to e.g.
   `youtube_audio_too_long`.

## Endpoint: POST /api/youtube-audio/fetch

Same access chain as the ffmpeg-cli endpoints: `videoProcessLimiter` (20 / 15 min /
IP), `requireAuthenticatedUser`, `requireInferenceAccess` — a fetch therefore counts
as one inference for free-tier installs, like any other server edit step. (On iOS,
when that client ships, the app will call it only with **Allow cloud processing**
on; the web editor sends no user media, just the link.)

Request (JSON, ≤ 10 KB):

```json
{ "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
```

Success: `200`, `Content-Type: audio/mp4`, the AAC (.m4a, 192 kbps) bytes, headers:

| Header | Meaning |
| --- | --- |
| `X-Audio-Duration` | Source audio length in seconds (the client validates `start_offset` against it). |
| `X-Video-Id` | The parsed 11-char YouTube video id. |
| `X-Audio-Title` | Percent-encoded video title (may be empty). |
| `X-Audio-Cached` | `true` when served from the server cache. |

Errors are JSON `{ error, code, ... }`:

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_youtube_url` | Missing link, or not a YouTube video link. |
| 401 / 402 / 429 | (auth chain) | Not signed in, or the inference-access chain says no (`paywall` / `daily_limit_reached`). |
| 404 | `youtube_video_unavailable` | The video is unavailable, private, or removed. |
| 422 | `youtube_audio_too_long` | Source longer than 10 minutes (body adds `durationSeconds`, `maxDurationSeconds`). |
| 422 | `youtube_live_not_supported` | The link is a live stream. |
| 502 | `youtube_fetch_failed` | yt-dlp/ffmpeg failed, timed out, or returned unusable output. |
| 503 | `youtube_audio_unavailable` | yt-dlp (or ffmpeg) is not installed/working on the server. |

## Extraction and cache

1. Parse the video id; canonicalize to `https://www.youtube.com/watch?v=<id>`.
2. Cache lookup: `youtube-audio-cache/<id>.m4a` + `<id>.json` under `TMP_DIR`
   (`FINALCUT_TMP_DIR`), fresh for `YOUTUBE_AUDIO_CACHE_TTL_MS` (default 24 h).
   Expired entries are swept opportunistically per request.
3. `yt-dlp --dump-single-json` for title/duration (duration cap enforced here, and
   again from the converted file when metadata has none). `is_live` is rejected.
4. `yt-dlp -f bestaudio/best` downloads the audio; the server FFmpeg binary
   (`FFMPEG_PATH`, as everywhere) converts to AAC 192 kbps `.m4a`; the result is
   written into the cache and served.

Timeouts: metadata 60 s, download 180 s, conversion 120 s.

## yt-dlp on the server (pinned)

yt-dlp is **not** an npm dependency; it is a pinned standalone binary, because
YouTube changes break extractors regularly and updates must be deliberate.

- Pinned version: **2026.10.21** (`YT_DLP_PINNED_VERSION` in
  `server/tools/youtube-audio-tool.js` — keep the two in sync).
- Install (on the server, as the service user):

  ```sh
  curl -L https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp
  yt-dlp --version   # → 2026.10.21
  ```

  Or point `YT_DLP_PATH` at any other location (`finalcut.service` env).
- Update: download the new release the same way, then bump
  `YT_DLP_PINNED_VERSION` and this doc in the same commit. If extraction starts
  failing with `youtube_fetch_failed` for previously-working links, a stale
  yt-dlp is the first suspect — update before debugging further.
- Missing/broken binary behavior: the endpoint answers
  `503 youtube_audio_unavailable`; the client reports the failure in chat and
  applies nothing. Nothing else on the server depends on yt-dlp.
