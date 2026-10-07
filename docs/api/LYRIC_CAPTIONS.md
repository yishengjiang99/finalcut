# lyric_captions: bilingual lyric/speech captions

Audio in, captions out. The client sends only the audio track. The server transcribes it with
word timestamps, identifies the song and corrects misheard lyrics, translates each line, and
returns timed lines (plus an ASS file when the video size is given). The client burns the captions
into the video: the original line on top, the translation under it, about 20% up from the bottom.

Code: `src/server/lyricCaptions.js` (endpoint, pipeline, ASS), `src/lyricCaptionsClient.js` (web),
`lyric_captions` in `src/tools.js`. Tests: `src/test/lyric-captions*.test.js`.

## Chat tool

`lyric_captions` is an agentic tool: `GET /api/tools/schema` and `/api/chat` offer it to the
model for videos (never photos). Its description maps requests such as "add lyrics captions",
"subtitle the song in German and Chinese", and "translate the lyrics on the video to Spanish" to the
tool. The model fills `target_language` from the language the user wants the translation in, and
`source_language` only when the user names the sung language.

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `target_language` | string, required | | Code or name: `zh-Hans`, `zh-Hant`, `es`, `Japanese`. BCP-47 tags are kept as given. |
| `source_language` | string | `auto` | Sung/spoken language. |
| `mode` | `auto` \| `lyrics` \| `speech` | `auto` | `lyrics` identifies the song and checks published lyrics. `speech` only fixes obvious errors and never searches. |
| `position_from_bottom_pct` | number 0–45 | 20 | Bottom of the caption block, as % of the video height. |
| `font_size` | integer 8–400 | 48/1280 of the height | In video pixels. |

Who runs it:

- **Web (streaming chat):** the browser runs it (`toolFunctions.lyric_captions`, see "Web flow").
- **Client execution mode (`execution: "client"`):** offered to non-iOS clients, which run the
  flow below and post a short result back.
- **FinalCap iOS:** not offered. The tool isn't in `src/server/iosToolAllowlist.js` and the iOS/10
  tool snapshot is unchanged. Sending audio to the server conflicts with the iOS promise that media
  stays on device unless Cloud processing is on, so it needs either Cloud processing on or a
  one-time consent prompt. **Open decision for iOS and Design.** To ship it, add
  `lyric_captions: <build>` to the allowlist once a build implements the iOS contract below.

The tool result the model sees is short: song title, artist, link and confidence, line count, and
languages. It never contains the lyric text. Example:
`lyric_captions done: 14 lines, de → zh-Hans (14 translated), mode lyrics. Song: "Title" by Artist (high confidence, verified with web search) https://…`
Client-mode clients should post something like
`{"ok":true,"executedOn":"device","output":{"song":{…},"lineCount":14,"language":"de","targetLanguage":"zh-Hans"}}`.

Burned captions can't be removed from the pixels. Like `generate_captions`, the web client never
captions on top of burned captions. A second caption call re-burns from the uncaptioned source,
replacing the earlier captions. If other edits were applied on top of burned captions, a new
caption call is refused with a clear message (`src/captionLineage.js`). Native clients should
follow the same rule.

## POST /api/lyric-captions

Auth: Bearer or session, like other edits. Charged as one edit (`requireInferenceAccess`), and only
after the request passes validation and the dependency check. Rate limit: the video-processing
limiter (20 per 15 min per IP).

`multipart/form-data` fields:

| Field | Required | Notes |
| --- | --- | --- |
| `audio` | yes | Audio only: WAV (16 kHz mono preferred), m4a/AAC, opus/ogg, mp3. At most **25 MB** and **10 min**. A file with a real video stream is refused (`audio_only`). Cover art is fine. |
| `target_language` | yes | As in the tool. |
| `source_language`, `mode`, `position_from_bottom_pct`, `font_size` | no | As in the tool. |
| `width`, `height` | no, but both or neither | Display size of the video (after rotation). When given, the result includes `ass`. |

`202 {"jobId","status":"queued","operation":"lyric_captions","durationSec","pollUrl","resultUrl"}`

Poll `GET /api/jobs/:jobId`. It uses the general API limiter (100 per 15 min), so back off: the web
client polls at 3 s ×1.5, capped at 10 s. While running, `progress` goes 0.2 (audio decoded) → 0.5
(transcribed) → 0.9 (corrected) → 1. On success the poll body has a lyric-free
`summary: {song, mode, language, targetLanguage, lineCount, translatedCount, webSearch}`, and
`resultUrl` serves the result JSON:

```json
{
  "song": { "title": "…", "artist": "…", "url": "https://…", "confidence": "high", "source": "web_search" },
  "mode": "lyrics",
  "language": "de",
  "targetLanguage": "zh-Hans",
  "webSearch": true,
  "model": "grok-4.7",
  "style": { "fontName": "Noto Sans CJK SC", "fontSize": 48, "marginV": 256, "marginLR": 48, "outline": 3, "shadow": 1, "alignment": 2,
             "positionFromBottomPct": 20, "fontSizeOfHeight": 0.0375, "marginLROfWidth": 0.0667 },
  "lines": [
    { "start": 1.2, "end": 3.0, "text": "<corrected original line>", "translation": "<translation>",
      "words": [{ "w": "<as heard>", "start": 1.2, "end": 1.5 }] }
  ],
  "ass": "[Script Info]…"
}
```

- `song` is `null` for speech or when no song was identified. Without web search, `source` is
  `model_knowledge`, `confidence` is capped at `medium`, and there is no `url`.
- `lines[].start/end` come from the first and last word. Timestamps are never changed by the
  correction step. `words` are the recognizer's words, for karaoke-style highlighting. Corrected
  text can differ from them.
- `translation` is `""` when the model gave none, or when it only repeats the original line. Never
  draw the same text twice.
- `style` sizes are for the given `width`/`height`, or 1080x1920 when none were given. Use the
  `…Of…` ratios to scale.

Errors (`{"error","code","operation":"lyric_captions"}`):

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_arguments` | Missing or invalid `target_language`, `mode`, `position_from_bottom_pct`, `font_size`, `width`/`height`, or no `audio` field. |
| 400 | `audio_only` / `no_audio` / `unsupported_audio_format` | A video was sent, there's no audio stream, or the file is unreadable. |
| 413 | `audio_too_large` / `audio_too_long` | Over 25 MB or 10 min. |
| 429 | `daily_limit_reached` | Free-edit limit, same as other edits. |
| 503 | `lyric_captions_unavailable` | Missing `OPENAI_API_KEY`/`XAI_API_TOKEN`, ffmpeg or ffprobe. The message names what's missing. |
| job `failed` | `no_speech` | Nothing was transcribed. |
| job `failed` | `lyric_captions_model_error` | The model's reply wasn't usable. |

Results live in server memory for 30 minutes (for the burn fallback), then the job is dropped.
The uploaded audio and the converted WAV are deleted as soon as transcription finishes.

## Pipeline (server)

1. ffprobe validation, then ffmpeg conversion to 16 kHz mono WAV.
2. Speech-to-text: OpenAI `whisper-1`, `verbose_json`, `timestamp_granularities[]=word` and
   `segment`. This reuses the existing OpenAI transcription setup; `whisper-1` is the OpenAI model
   that returns word timestamps, so there is no faster-whisper sidecar.
3. Lines: segments are split at pauses over 1.2 s and sentence ends, and before passing ~42 Latin
   or ~18 CJK characters. Splits prefer the last comma or clause break. A segment that repeats the
   previous one while overlapping it in time is dropped as a recognizer duplicate. A line really
   sung twice stays twice.
4. Correction and translation: one Grok call with numbered lines. For `lyrics`/`auto` it uses the
   Responses API (`POST /v1/responses`, `tools:[{"type":"web_search"}]`,
   `include:["no_inline_citations"]`, model `LYRIC_CAPTIONS_MODEL`, default `grok-4.7`). If that
   fails, it falls back to chat completions (`LYRIC_CAPTIONS_FALLBACK_MODEL`, default `grok-3`),
   using model knowledge only. `speech` goes straight to the fallback. The reply must keep one line
   per input index. Extra lines are discarded, so no lyric text beyond what was sung in the clip is
   ever returned.

## Caption style (defaults)

Defined at 720x1280 and scaled for other sizes:

| | 720x1280 | Scale rule |
| --- | --- | --- |
| Font | Noto Sans CJK SC, Bold (`-1`), one family for both lines | |
| Font size | 48 | 48/1280 × H |
| Colours | Primary `&H00FFFFFF` white, outline `&H00000000` black, shadow `&H80000000` | |
| Border | `BorderStyle=1`, `Outline=3`, `Shadow=1`, `ScaleX/Y=100`, `Spacing=0` | |
| Anchor | `Alignment=2` (bottom-center) | |
| MarginV | 256 | 0.2 × H (or `position_from_bottom_pct`) |
| MarginL / MarginR | 48 | 48/720 × W |
| Events | one `Dialogue` per line: `original\Ntranslation` | |
| Wrapping | `WrapStyle: 0` (smart wrap): a long original line may wrap to two lines while the block stays anchored at 20% | |

The exact style line at 720x1280 (asserted in `src/test/lyric-captions.test.js`):

```
Style: Default,Noto Sans CJK SC,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,48,48,256,1
```

Lyric text is made inert: `{` and `}` become parentheses, a backslash becomes `/`, and newlines
become spaces. Fonts: `sudo apt-get install -y fonts-noto-cjk` (prod and the dev box), then
`fc-match "Noto Sans CJK SC:bold"` should print `NotoSansCJK-Bold.ttc: "Noto Sans CJK SC" "Bold"`.

## Web flow (`src/lyricCaptionsClient.js`)

1. Decode the video's audio in the browser (`AudioContext.decodeAudioData`), then resample and
   down-mix to 16 kHz mono with `OfflineAudioContext`, and encode a WAV (1.9 MB per minute).
2. `POST /api/lyric-captions` with the WAV only, then poll and fetch the result.
3. Burn-in: **server fallback**. The web app has no client-side ffmpeg (every web edit already
   runs on the server), so it calls `POST /api/lyric-captions/:jobId/burn`.
   - multipart `video`, plus optional `args` JSON `{position_from_bottom_pct, font_size}`.
   - Returns `video/mp4` with `X-Lyric-Captions-Burn: server`.
   - The server builds the ASS from the finished job's lines, sized to the uploaded video (rotation
     aware), and burns it with `ass=` + `libx264 -preset medium -crf 20`, audio copied when
     AAC/MP3/ALAC, `+faststart`.
   - Not charged again. Returns 404 `job_not_found` after the 30 min TTL, 409 `job_not_ready`
     before success, and 503 `lyric_captions_unavailable` without libass or the CJK font.
   - Transcription still needs only the audio. The video goes up for the burn step, as it does for
     every other web edit.

Upload size, measured on a 12 s 1080x1920 sample (10 Mbit/s H.264, typical of phone video):
video 16.0 MB, 16 kHz mono WAV 384 KB (2.4%, about 42× smaller), mono AAC m4a at 48 kbit/s
70 KB (0.45%, about 220× smaller).

## iOS contract (for the FinalCut iOS team; nothing in `ios/` changed)

Requires Cloud processing on, or a one-time consent prompt (see "Chat tool").

1. **Extract audio**:
   - `AVAssetExportSession` with `AVAssetExportPresetAppleM4A` (`.m4a`, smallest upload), or
   - `AVAssetReader` with `AVLinearPCMBitDepthKey: 16`, `AVSampleRateKey: 16000`,
     `AVNumberOfChannelsKey: 1`, written out as a WAV.
   - Refuse clips over 10 min before uploading.
2. **POST** `/api/lyric-captions` (Bearer) with `audio`, `target_language`, optional fields, and
   `width`/`height` = the render size after `preferredTransform`. Poll with backoff, then GET
   `resultUrl`.
3. **Render** with `AVVideoCompositionCoreAnimationTool`, one caption block per `lines[]` entry:
   - Parent layer = render size, video layer, and an overlay layer with
     `isGeometryFlipped = false`. In a video composition, Core Animation's origin is bottom-left,
     so the block's bottom edge is at `y = 0.2 × H`.
   - One `CATextLayer` (or a layer holding an attributed string) per line:
     - Text: `text`, a line break, then `translation`, centered.
     - Width `W − 2 × (48/720 × W)`. Let it wrap; grow upward from the 20% anchor.
     - Font: `NotoSansCJKsc-Bold`, bundled, or `PingFangSC-Semibold` as the system fallback.
       Size `48/1280 × H`.
     - White fill. Black stroke about 3 px at 720x1280 (scaled): draw a stroked copy under the
       filled copy, or use `strokeWidth` (negative = stroke + fill).
     - Shadow: black at 50%, offset 1 px (scaled), small radius.
   - Show only from `start` to `end`: `opacity` keyframes with
     `beginTime = AVCoreAnimationBeginTimeAtZero + start`, `isRemovedOnCompletion = false`,
     hold 0 outside the range.
   - Skip `translation` when it is empty. Never draw a line twice.
4. Report back with a short tool result (song, lineCount, languages), never the lyrics.

## Cost per call (estimate; check current price lists)

- Speech-to-text: `whisper-1` is billed per audio minute (it was $0.006/min, so ≤ $0.06 for the
  10 min cap and about $0.02 for a 3 min song).
- Grok: one call. Input is about 30 tokens per line plus about 400 for instructions; output is
  about 40 tokens per line. A 40-line song is roughly 2k input and 2k output tokens.
- `lyrics`/`auto` add the `web_search` tool's per-search charges and the tokens of the pages Grok
  reads, which usually cost more than the model tokens. `speech` mode skips search.
- Server burn-in (web only) costs one x264 re-encode of the video in server CPU time.
