# lyric_captions: bilingual lyric/speech captions

> **Web, plain speech:** "add captions in Chinese" now streams the audio to ElevenLabs realtime STT, shows a live overlay and adds a caption track on Export (no burn, no server video processing); see [STREAMING_CAPTIONS.md](STREAMING_CAPTIONS.md). This upload-based flow remains for songs (`mode: "lyrics"`), for iOS, and as the fallback when `ELEVENLABS_API_KEY` is not set.

Audio in, captions out. The client sends only the audio track. The server transcribes it with
word timestamps, identifies the song and corrects misheard lyrics, translates each line, and
returns timed lines (plus an ASS file when the video size is given). The client burns the captions
into the video: the original line on top, the translation under it, about 20% up from the bottom.

Code: `src/server/lyricCaptions.js` (endpoint, pipeline, ASS), `src/lyricCaptionsClient.js` (web),
`lyric_captions` in `src/tools.js`. Tests: `src/test/lyric-captions*.test.js`.

## Chat tool

`lyric_captions` is an agentic tool: `GET /api/tools/schema` and `/api/chat` offer it to the
model for videos (never photos). It is the tool for **any request to caption or subtitle a video in
another language**, for plain speech as well as songs. Its description maps these phrasings to it:

- plain speech: "add captions in Chinese", "add Chinese captions", "Chinese subtitles", "translate the
  video into Chinese and burn the captions", "translate the speech to Spanish" (the model sets
  `mode: "speech"`, `target_language: "zh-Hans"` for Chinese, and leaves `source_language` out so the
  spoken language is detected);
- songs: "add lyrics captions", "subtitle the song in German and Chinese", "translate the lyrics on
  the video to Spanish" (`mode: "lyrics"` or `auto`).

`generate_captions` is for same-language captions (and, on web, soft SRT/VTT files). Its web
description and the system prompt send other-language requests to `lyric_captions`; on iOS its
description says it never translates. The model fills
`target_language` from the language the user wants the translation in, and `source_language` only
when the user names the spoken or sung language.

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `target_language` | string, required | | Code or name: `zh-Hans`, `zh-Hant`, `es`, `Japanese`. BCP-47 tags are kept as given. |
| `source_language` | string | `auto` | Sung/spoken language. |
| `mode` | `auto` \| `lyrics` \| `speech` | `auto` | `lyrics` identifies the song and checks published lyrics. `speech` (ordinary talking) only fixes obvious errors and never searches. `auto` lets the server decide from the transcript. |
| `position_from_bottom_pct` | number 0–45 | 20 | Bottom of the caption block, as % of the video height. |
| `font_size` | integer 8–400 | 48/1280 of the height | In video pixels. Prefer `size`. |
| `font` | `Noto Sans CJK SC` \| `Inter` | `Noto Sans CJK SC` | Whitelist: the fonts the browser engine can draw. `Inter` is Latin only. Web overlay only. |
| `size` | `small` \| `default` \| `large` \| `xl` | `default` | 0.75× / 1× / 1.4× / 1.8× of the default size (48 px at 720×1280, scaled). |
| `position` | `bottom` \| `middle` \| `top` | `bottom` | ASS Alignment 2 / 5 / 8. Bottom uses `position_from_bottom_pct` as MarginV; middle has MarginV 0; top has MarginV 8 % of the height. |

Style on the web: invalid values never fail the call; they fall back to the default and are clamped
(`resolveCaptionStyle` in `src/lyricShared.js`). The web model asks one question first ("Which font and
where should the captions go? Default is Noto Sans CJK SC Bold, bottom, 20% up.") when the look is
unspecified, then passes explicit `font`, `size` and `position`; a stated preference, "default" or
"just do it" goes straight to the call. The same params are in the iOS schema, but the iOS app draws
its own captions, its tool text and system message are unchanged, and it does not get the question.

Who runs it:

- **Web (streaming chat):** the browser runs it (`toolFunctions.lyric_captions`, see "Web flow").
- **Client execution mode (`execution: "client"`):** offered to non-iOS clients, which run the
  flow below and post a short result back.
- **FinalCap iOS:** offered to every build that sends the `FinalCap-iOS/<build>` user agent (build 10
  and up, the same floor as the other iOS tools), with no build gate, for videos only, with an iOS
  description of the on-device flow. See "iOS" below.

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

Auth: `Authorization: Bearer <accessToken>` (iOS), a session cookie (web), or `sample-access-token`,
like other edits. Charged as one edit (`requireInferenceAccess`), and only after the dependency check
(503), the request fields, and an ffprobe of the audio have passed. A refused upload is never
charged. From a client-mode chat tool call, send `X-Turn-Token: <latest turnToken>` and
`X-Tool-Call-Id: <toolCalls[i].id>` so the run isn't charged on top of the chat turn
(`X-Inference-Charged: false`; each tool call id is free once). With `FREE_EDITS_IOS=unlimited`, iOS
is never blocked and gets `X-Inference-Unlimited: true` (usage still counted once per job, polls are
not counted). Rate limit: the video-processing limiter (20 per 15 min per IP, a plain-text 429).

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
| 401 | | Missing, invalid or expired Bearer token. |
| 400 | `invalid_arguments` | Missing or invalid `target_language`, `mode`, `position_from_bottom_pct`, `font_size`, `width`/`height`, or no `audio` field. |
| 400 | `audio_only` / `no_audio` / `unsupported_audio_format` | A video was sent, there's no audio stream, or the file is unreadable. |
| 413 | `audio_too_large` / `audio_too_long` | Over 25 MB or 10 min. |
| 429 | `daily_limit_reached` | Free-edit limit, same as other edits (never with `FREE_EDITS_IOS=unlimited` for iOS). A 429 with a plain-text body is the per-IP rate limiter. |
| 403 | | `Active subscription required`: a web user without a subscription. |
| 503 | `lyric_captions_unavailable` | Missing `OPENAI_API_KEY`/`XAI_API_TOKEN`, ffmpeg or ffprobe. The message names what's missing. |
| job `failed` | `no_speech` | Nothing was transcribed. |
| job `failed` | `lyric_captions_model_error` | The model's reply wasn't usable. |
| 404 | `job_lost` | The server restarted after the job was made (every deploy restarts it; jobs live in memory): `{"error":"Job not found","code":"job_lost","retryable":true}`. Send the audio again. |
| 404 | `job_expired` | The job was dropped after the 30-minute TTL: same body with `"code":"job_expired"`. Send the audio again. |
| 404 | | Poll or result of an unknown id or someone else's job: `{"error":"Job not found"}` / `{"error":"Result not available"}` (no code, nothing to retry). |

**iOS results the server rewrites.** App builds that cannot run `lyric_captions` answer with an error or an
unknown-tool result. Tool results do pass through the server's chat loop (`POST /api/chat`,
`execution: "client"`, role `tool`), where `rewriteLyricCaptionsResult` (`src/server/clientExecution.js`)
replaces them for `FinalCap-iOS` clients before the model sees them: an unknown/unsupported result
(`unsupported_on_device`, `unknown_tool`, …) becomes `{"ok":false,"code":"unsupported_on_device","error":"lyric_captions is not available in this version of the app. Tell the user Chinese captions need the latest app update, and offer captions in the video's own language."}`;
any other error becomes `{"ok":false,"error":"Captions couldn't finish. Nothing was changed. Try again."}`
with no raw text. Successful results and `skipped_by_user` pass through. This is not a build gate and
does not change which tools are offered (an `unsupported_on_device` result still stops that tool being
offered for the rest of the turn, as for any tool).

`POST /api/lyric-captions/:jobId/burn` from an iOS client (Bearer, or a `FinalCap-iOS/*` UA) and
`lyric_captions` sent to `/api/process-video` or `/api/jobs/process-video` answer **400**
`{"code":"not_available_on_server","operation":"lyric_captions"}` (`unsupported_for_photo` for a
photo on the process-video routes). iOS draws the captions itself.

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
   fails, it falls back to chat completions (`LYRIC_CAPTIONS_FALLBACK_MODEL`, default `XAI_UTILITY_MODEL`),
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
   - Not charged again. Returns 404 `job_lost` / `job_expired` (`job_not_found` for an unknown id), 409 `job_not_ready`
     before success, and 503 `lyric_captions_unavailable` without libass or the CJK font.
   - Transcription still needs only the audio. The video goes up for the burn step, as it does for
     every other web edit.

Upload size, measured on a 12 s 1080x1920 sample (10 Mbit/s H.264, typical of phone video):
video 16.0 MB, 16 kHz mono WAV 384 KB (2.4%, about 42× smaller), mono AAC m4a at 48 kbit/s
70 KB (0.45%, about 220× smaller).

## iOS (for the FinalCut iOS team; nothing in `ios/` changed)

### No build gate

`lyric_captions` is in `IOS_TOOL_ALLOWLIST` at build 10, the same floor as the other iOS tools; there
is no cutoff constant. **Risk:** the server only sees the build number, so builds that predate the
client-side executor (this section) are offered a tool they cannot run; the app answers an unknown
tool with an error result and the model then tells the user it could not do it. For
`User-Agent: FinalCap-iOS/<build>`:

- `GET /api/tools/schema` and `POST /api/chat` (`execution: "client"`) offer `lyric_captions` for
  **videos only** (never photos; `mediaTypes.lyric_captions` is `["video"]`). It sits right after
  `generate_captions`.
- Parameters are the same as on web. The description is iOS-specific
  (`LYRIC_CAPTIONS_IOS_DESCRIPTION`): it also covers plain speech (`mode: "speech"`) and phrasing such
  as "add Chinese captions" and "translate the video into Chinese"; the app asks before uploading,
  sends only the audio, and draws the captions; if Cloud processing is off or the user declines,
  nothing is uploaded and the model must not retry this turn; the model never quotes the text.
- `generate_captions` gets `GENERATE_CAPTIONS_WITH_LYRIC_DESCRIPTION` on every iOS build: same-language
  only, translation goes to `lyric_captions`.
- The iOS/10 and iOS/12 tool snapshots now include `lyric_captions` (22 and 23 tools).

### Flow the app runs (client execution)

The tool call arrives as `{ "id": "call_…", "name": "lyric_captions", "arguments": { "target_language": "zh-Hans", "source_language": "de", "mode": "auto" } }`.

1. **Cloud processing off:** show the card below and **never call the server**. Post the tool
   result `{"ok":false,"error":"skipped_by_user","executedOn":"device"}`.
2. **Cloud processing on:** show the consent prompt **every time**. "Not now" → the same
   `skipped_by_user` result.
3. **Extract audio** (refuse over 10 min before uploading):
   - `AVAssetExportSession` with `AVAssetExportPresetAppleM4A` (`.m4a`, smallest upload), or
   - `AVAssetReader` with `AVLinearPCMBitDepthKey: 16`, `AVSampleRateKey: 16000`,
     `AVNumberOfChannelsKey: 1`, written out as a WAV.
4. **Upload:** `POST /api/lyric-captions`, `multipart/form-data`, headers
   `Authorization: Bearer <accessToken>`, `User-Agent: FinalCap-iOS/<build>`,
   `X-Turn-Token: <latest turnToken>`, `X-Tool-Call-Id: <the call id>`. Fields: `audio` (file),
   `target_language`, plus `source_language`, `mode`, `position_from_bottom_pct`, `font_size` when
   the tool call has them, and `width`/`height` = the render size after `preferredTransform`
   (optional; only needed if you want `ass`). Response **202**
   `{ jobId, status: "queued", operation: "lyric_captions", durationSec, pollUrl, resultUrl }`.
5. **Poll** `GET pollUrl` (= `/api/jobs/<jobId>`, same Bearer) with backoff (e.g. start at 2–3 s,
   ×1.5, cap 10 s; the poll limiter allows 100 requests per 15 min per IP). Body:
   `{ jobId, status: queued|running|succeeded|failed, progress, code?, error?, summary?, resultUrl?, contentType? }`.
   `progress` is 0 → 0.2 (audio decoded) → 0.5 (transcribed) → 0.9 (lyrics checked and translated) → 1.
6. **Result:** `GET resultUrl` (= `/api/jobs/<jobId>/result`) → the JSON above. It is kept 30 minutes;
   fetch it once and keep it on device. The audio is already deleted on the server by then.
7. **Draw** the captions locally from `lines` (see "Rendering"). Never call
   `/api/lyric-captions/:jobId/burn` (400 `not_available_on_server` for iOS).
8. **Tool result** for the chat continuation, short and lyric-free:
   `{"ok":true,"executedOn":"device","output":{"duration":…,"width":…,"height":…,"song":{"title":…,"artist":…,"url":…},"lineCount":14,"language":"de","targetLanguage":"zh-Hans"}}`
   (the poll `summary` has these fields). On failure: `{"ok":false,"error":"<code>","executedOn":"device"}`
   using the server `code` (e.g. `no_speech`, `audio_too_long`, `lyric_captions_unavailable`).

Errors to handle: 401 (re-auth), 400 `invalid_arguments` / `audio_only` / `no_audio` /
`unsupported_audio_format`, 413 `audio_too_large` / `audio_too_long`, 429 `daily_limit_reached`
(JSON; never with `FREE_EDITS_IOS=unlimited`) or a plain-text 429 from the per-IP rate limiter, 503
`lyric_captions_unavailable`, a failed job with `code` `no_speech` or `lyric_captions_model_error`,
and 404 on poll/result with `code` `job_lost` (server restarted) or `job_expired` (30-minute TTL): show "Captions couldn't finish. Nothing was changed. Try again." and let the user retry (the audio is small; sending it again is safe, and a fresh job is a new request, which counts like any other). Poll through short outages: a network error or 502/503/504 while the server restarts is not a failure, retry for ~30 s first. A refused upload (any 4xx/503 before the 202) is not
charged.

### Plain speech: "add Chinese captions" (same build as the song flow)

On a build that has `lyric_captions`, "add Chinese captions" or "translate the video into Chinese"
reaches the app as the same tool call, with `mode` set to `speech`:

```json
{ "id": "call_…", "name": "lyric_captions", "arguments": { "target_language": "zh-Hans", "mode": "speech" } }
```

No new endpoint and no new code path: run the "Flow the app runs" steps above with these differences.

1. Same consent rules. Cloud processing off → card + `skipped_by_user`, nothing is uploaded. On →
   ask every time. (The upload prompt copy below mentions song lyrics; Design should supply a speech
   variant, for example "FinalCap will upload this video's audio, but not the picture, to transcribe
   and translate it. The audio is deleted after transcription.")
2. Extract the audio exactly as for songs (m4a via `AVAssetExportSession`, or 16 kHz mono WAV via
   `AVAssetReader`; 10 min cap).
3. `POST /api/lyric-captions` with `audio`, `target_language=zh-Hans`, `mode=speech`. Omit
   `source_language`: the spoken language is detected and returned as `language`.
4. Poll as before. Show **"Checking the words and translating…"** once `progress >= 0.5` (it is the
   `speech` text in the progress table below).
5. The result has `song: null`, `lines[]` with `text` (original) and `translation` (Chinese), and
   `language` (the detected spoken language). Draw it with the same overlay as songs (original on
   top, Chinese under it, Noto Sans CJK SC Bold so the glyphs render). Applied card:
   "Captions · Speech + Chinese".
6. Tool result (short, no text): `{"ok":true,"executedOn":"device","output":{"lineCount":4,"language":"en","targetLanguage":"zh-Hans","duration":…,"width":…,"height":…}}`.
7. If the video already has captions drawn by this tool or by on-device `generate_captions`, re-render
   from the version before them (see "Rendering"); never draw both.

What the user sees before and after: builds without `lyric_captions` (today) only get same-language
on-device captions and the model says translation is not available; builds from the cutoff get the
flow above. `zh-Hant` for Traditional; any other language name or code works the same way.

### Copy (Design, final)

Cloud processing **off** (card; never call the server):

> **Lyric captions use the cloud**
> To caption a song, FinalCap uploads this video's audio to transcribe and translate it. Turn on Cloud processing to use lyric captions.
>
> [Open Settings] [Not now]

Cloud processing **on**, shown **every time** before uploading:

> **Upload the audio?**
> FinalCap will upload this video's audio, but not the picture, to transcribe it, look up the song's lyrics, and translate them. The audio is deleted after transcription.
>
> [Upload audio] [Not now]

Progress stages:

| When | Text |
| --- | --- |
| Until the upload finishes (before the 202) | "Uploading audio…" |
| Job `progress < 0.5` (includes `queued`) | "Listening to the song…" |
| Job `progress >= 0.5` | "Finding lyrics and translating…", or "Checking the words and translating…" when the tool call's `mode` is `speech` |
| During the local burn (drawing/exporting on device) | "Adding captions…" |

Applied card, with language names from the result's `language` and `targetLanguage` (localized
names, e.g. `Locale.current.localizedString(forLanguageCode:)`):

- a song was identified (`song` non-null): **"Lyrics · German + Chinese"**
- no song (`song` is `null`, e.g. speech): **"Captions · Speech + Chinese"**

### Rendering

Use `AVVideoCompositionCoreAnimationTool`, one caption block per `lines[]` entry:

- Parent layer = render size, video layer, and an overlay layer with `isGeometryFlipped = false`.
  In a video composition, Core Animation's origin is bottom-left, so the block's bottom edge is at
  `y = position_from_bottom_pct/100 × H` (default 0.2 × H).
- One `CATextLayer` (or a layer holding an attributed string) per line:
  - Text: `text`, a line break, then `translation`, centered. Skip `translation` when it is empty.
    Never draw a line twice.
  - Width `W − 2 × (48/720 × W)`. Let it wrap; grow upward from the anchor.
  - Font: `NotoSansCJKsc-Bold`, bundled, or `PingFangSC-Semibold` as the system fallback. Size
    `48/1280 × H` (or `font_size`).
  - White fill. Black stroke about 3 px at 720x1280 (scaled): draw a stroked copy under the filled
    copy, or use `strokeWidth` (negative = stroke + fill).
  - Shadow: black at 50%, offset 1 px (scaled), small radius.
- Show only from `start` to `end`: `opacity` keyframes with
  `beginTime = AVCoreAnimationBeginTimeAtZero + start`, `isRemovedOnCompletion = false`, hold 0
  outside the range.
- Caption from the uncaptioned source: if the video already has lyric captions drawn by this tool,
  re-render from the version before them instead of drawing on top (see "Chat tool").

## Cost per call (estimate; check current price lists)

- Speech-to-text: `whisper-1` is billed per audio minute (it was $0.006/min, so ≤ $0.06 for the
  10 min cap and about $0.02 for a 3 min song).
- Grok: one call. Input is about 30 tokens per line plus about 400 for instructions; output is
  about 40 tokens per line. A 40-line song is roughly 2k input and 2k output tokens.
- `lyrics`/`auto` add the `web_search` tool's per-search charges and the tokens of the pages Grok
  reads, which usually cost more than the model tokens. `speech` mode skips search.
- Server burn-in (web only) costs one x264 re-encode of the video in server CPU time. iOS draws on
  device, so an iOS call costs only speech-to-text and Grok.

## Restarts and lost jobs

Jobs (including the finished caption JSON) live in the memory of the one node process, and every deploy
restarts it. What this does about that:

- Job ids look like `j<8 hex boot id>_<uuid>`. A poll/result/burn for an id from before the restart gets
  404 with `code: "job_lost"` and `retryable: true` (status and `error` text are unchanged). The id
  format is opaque to clients.
- On SIGTERM the server keeps serving until pending jobs are done and their results were fetched, for
  at most 45 s, then exits (systemd's default stop timeout is 90 s). A deploy therefore only breaks a
  job that runs longer than that.
- The web client rides out the restart (retries 502/503/504 and network errors while polling) and, if
  the job is still lost, sends the audio once more. Any other failure shows one short message.
- User-facing wording (Design): job missing or poll failed "Captions couldn't finish. Nothing was
  changed. Try again."; audio over the limit (25 MB or 10 min) "This video's audio is too long for
  translated captions. Try a clip under 10 minutes."; 503 `lyric_captions_unavailable` "Translated
  captions aren't available right now. Try again later." The web tool result tells the model to relay
  exactly that message.
- Charging: a request that fails validation, or returns 503 before the 202, is never charged. Once the
  202 is returned the request has been counted (iOS free daily limit; the web app has no per-edit
  counter), so a job lost afterwards was counted. Do not tell users otherwise.
