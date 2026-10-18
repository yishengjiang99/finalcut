# Streaming captions (web)

Plain speech captioning on the web ("add captions in Chinese") streams the video's **audio** from the
browser straight to ElevenLabs realtime speech-to-text (`scribe_v2_realtime`), translates the committed
text with Grok through our server, and shows the captions as a live overlay on the preview; on Export they are burned into the video frames in the browser (WebCodecs + canvas + mediabunny), so they show in Photos and every player. The picture is
never uploaded and never processed on the server. Songs (`mode: "lyrics"`) and the iOS app keep the upload-based
[lyric_captions](LYRIC_CAPTIONS.md) flow.

Source: `src/streamingCaptions.js` (browser), `src/server/streamingCaptions.js` (server),
`src/lyricShared.js` (line building and ASS, shared). Tests mock ElevenLabs.

## Prod config

```
ELEVENLABS_API_KEY=...        # in /home/finalcut/apps/pages/finalcut/.env  (never commit it)
# ELEVENLABS_API_BASE=https://api.us.elevenlabs.io   # optional regional host (https only)
```

Plus the key the translate step already needs (`XAI_API_TOKEN`). Restart `finalcut` after editing `.env`. Without
`ELEVENLABS_API_KEY`: `GET /api/streaming-captions/status` says `available:false`, the token route
answers 503, and the chat tool uses the older flow. The key stays on the server; only a 15-minute
single-use token reaches the browser. No CSP is set today; if one is added it needs
`connect-src wss://api.elevenlabs.io`.

## Flow

1. `GET /api/streaming-captions/status` → `{available}`; the tool uses this flow only when true and the mode is not `lyrics`.
2. No prompt: the browser starts streaming the audio as soon as captions are requested.
3. The browser extracts the audio (16 kHz mono PCM), plans commit points at the quietest spot 20–30 s apart.
4. `POST /api/streaming-captions/token` just before connecting. Connect to `wsUrl?…&token=…`.
5. Stream 0.5 s chunks (`input_audio_chunk`, `commit:true` on the chunk that ends a segment) at the pacing constant.
6. Each `committed_transcript_with_timestamps` becomes caption lines; lines are translated in order in batches of ≤ 20 with `POST /api/streaming-captions/translate`, while later audio is still streaming.
7. When every range is transcribed and translated the flow **ends**: no burn and no re-encode at this point. The lines become a **caption track** attached to the video (see "Overlay, style and export"); percent reaches 100 and the chat shows the applied card "Captions · English → Chinese".

## Overlay, style and export

* **Live overlay** (`src/captionTrack.js`, `VideoPreview` `captionTrack`): the active line (original, then translation; a translation equal to the original is not drawn twice) is drawn over the preview from `currentTime`. Placement follows the ASS Alignment: bottom (2, `bottom: N%`, default 20 %), middle (5, centered vertically) or top (8, 8 % from the top). Size = default (ASS reference 48 px on 1280, scaled) × `sizeScale`. Default style = the agreed one: Noto Sans CJK SC Bold, 20 % up, Alignment 2. The preview font is a CJK-capable system font stack, so glyph shapes can differ slightly from the final player's. **There are no style controls or caption buttons on the card**: the style is chosen in chat (next bullet).
* **Style through chat:** `lyric_captions` takes optional `font` (whitelist `Noto Sans CJK SC` default, `Inter` Latin only: the two fonts the browser engine and overlay can draw), `size` (`small` 0.75, `default` 1, `large` 1.4, `xl` 1.8), `position` (`bottom`/`middle`/`top`), `position_from_bottom_pct` (0–45, bottom only) and `font_size` in pixels (converted with the clip height, clamped to 0.5×–2.5×). Values are validated and clamped by `resolveCaptionStyle` (`src/lyricShared.js`); an unknown value is dropped to the default and logged as `style_ignored`, never an error. The server-owned web system prompt (`CAPTION_STYLE_GUIDANCE`; not sent for photos or the iOS app) makes the model ask **once**, "Which font and where should the captions go? Default is Noto Sans CJK SC Bold, bottom, 20% up.", when the look is unspecified, and call the tool straight away when a preference is stated or the user says "default"/"just do it". The tool result names the style it applied. The style drives the overlay; the exported caption track is a soft track, so the player's own caption settings decide how it looks.
* **Export (one button, all in the browser, nothing uploaded):** the header **Export** burns the captions into the picture the way a native app does: `src/captionBurn.js` (mediabunny, loaded on first export) decodes each frame with WebCodecs `VideoDecoder`, draws the caption on a canvas (`src/captionRender.js`: `fillText`/`strokeText`, bold Noto Sans CJK SC, 48 px at 720x1280 scaled to the frame height, white fill, 3 px black outline, 1 px shadow, original line then translation, bottom-centre 20% up, or the style chosen in chat), re-encodes with the hardware H.264 `VideoEncoder` and muxes an MP4 (`fastStart: in-memory`). Audio is stream-copied when the container allows (otherwise re-encoded by the browser). Rotation is baked into the frames so the caption is upright. No ffmpeg.wasm is involved, so there is no wasm core or 10 MB font in memory: on phones the long edge is capped at 1920 and a stall watchdog (45 s without a frame) ends the burn. The caption font is the system CJK font when present, then a bundled 2.5 MB subset (`public/fonts/NotoSansSC-Subset.ttf`, `scripts/fonts/make_caption_subset.py`) loaded with `FontFace`. A progress sheet with **Cancel** shows during the burn. **Fallback (one line says so):** if this browser has no WebCodecs H.264 encode, or the burn fails, the same Export saves the video with the captions as a `mov_text` track (`-c copy` via ffmpeg.wasm, not a burn) plus an SRT; if the file cannot hold a track, the SRT alone. There is no server burn route and no upload fallback. Client-log events (technical fields only, never caption text): `export_start`, `burn_start`, `burn_progress`, `burn_end`, `burn_error`, `export_fallback`, `mux_end`, `mux_error`, `export_srt_fallback`.
* **Where the captions show:** a burned caption is part of the picture, so it shows in Photos, Messages, social apps and every player. Only the fallback `mov_text` track is player-dependent (QuickTime and the iOS native player list it under subtitles; **Photos does not show embedded tracks**). Verified here in headless Chrome only (`tests/e2e/main-captions-burn.pw.mjs`, `src/test/caption-render.test.js`, `src/test/caption-export.test.js`); not verified on iOS Safari: WebCodecs H.264 encode, HEVC/MOV decode, CJK canvas fonts, memory on long or 4K clips and HDR colour.
* **Share sheet on phones:** on iPhone/iPad/Android (not on desktop) Export builds a `File` (`video/mp4` or `video/quicktime`, name `<clip>.mp4`) and, when `navigator.canShare({files})` is true, calls `navigator.share({files})` so iOS shows the share sheet with **Save Video**. If the mux took long enough that the tap's transient activation expired (`NotAllowedError`), a small sheet with one **Share** button shares on that tap. Cancelling the sheet (`AbortError`) is not an error; any other failure falls back to the normal download. Client-log events: `share_ready`, `share_ok`, `share_cancel`, `share_fail`.
* **Old burned captions:** a clip that already carries burned captions (from `generate_captions`) exports as is, without a track on top (caption lineage, `videoHasBurnedCaptions`). Captioning such a clip puts the overlay on the uncaptioned source clip.
* **Edits after captioning (safe behavior):** the track follows edits that keep the timeline (resize, crop, rotate, flips, add_text, colour edits, volume/audio filters, format conversion); **trim shifts the lines exactly** (lines outside the kept part are dropped, the rest clipped); **every other edit clears the overlay** (speed, silence removal, transitions, free-form ffmpeg, an unparsable trim…) and the chat says why. The earlier clip keeps its captions, so Undo brings them back.
* **Reload/crash:** the finished lines and style (text only) are saved in `localStorage` (`fc.captions.v1`, ≤ 8 videos, ≤ 900 KB) keyed by a fingerprint of the video (length + hash of 8 slices of 8 KB). Adding the same video again restores the captions ("Restored the captions you made for this video."). Removing captions forgets them.

## Routes

### `POST /api/streaming-captions/token`

Auth + `requireActiveSubscription` + 20 requests / 15 min / IP, then 503 if unconfigured, then the
ElevenLabs mint. **Not charged here** (see "When the edit is counted" under `/translate`).

Body (all optional): `{ "source_language": "en", "resumeSessionId": "<sessionId of a recent token>" }`

```json
{
  "token": "sutkn_…",
  "expiresInSec": 900,
  "sessionId": "9d2f…",
  "wsUrl": "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
  "query": {
    "model_id": "scribe_v2_realtime", "audio_format": "pcm_16000", "include_timestamps": "true",
    "commit_strategy": "manual", "language_code": "en"
  },
  "sampleRate": 16000,
  "maxAudioSeconds": 600,
  "operation": "streaming_captions"
}
```

`language_code` is present only when `source_language` is not `auto`. `Cache-Control: no-store`.
Errors: 503 `{error, code:"streaming_captions_unavailable"|"streaming_captions_busy", operation:"streaming_captions"}`
(key unset, ElevenLabs refused or busy), 429 `{code:"rate_limited"}`, 403 (no subscription / free
limit), 401. The token is never logged.

`sessionId` is the captions job. Send it back on every translate call; to continue the same job after a
dropped connection pass it as `resumeSessionId` (same user, within 30 min): the response has the same
`sessionId` and a new token, and the job keeps its charged state.

### `POST /api/streaming-captions/translate`

Auth + subscription + 300 requests / 15 min / IP. Text only, stateless. Speech only: the mode is fixed
to `speech` on the server (no song lookup, no web search, whatever the client sends).

```json
{ "target_language": "zh-Hans", "source_language": "auto",
  "segments": [{ "i": 0, "start": 0.5, "end": 2.5, "text": "Hello my friend" }],
  "context": ["previous line", "…up to 4"], "sessionId": "<sessionId from /token>" }
```

Limits: ≤ 40 segments, ≤ 400 chars each, ≤ 8000 chars total (413 `batch_too_large`).

```json
{ "lines": [{ "i": 0, "text": "Hello my friend", "translation": "你好，我的朋友" }],
  "language": "en", "model": "…", "targetLanguage": "zh-Hans", "operation": "streaming_captions" }
```

**When the edit is counted:** here, once per captions job, after the first batch that produced a translated
line (before that response is sent). Later batches and resumes (same `sessionId`) are never charged again, and a
job that never gets a translated line (the model failed, the translation only repeated the original, the
user cancelled before the first batch, the token was minted and never used) is not counted. The token mint
is not charged. A request with no known `sessionId` (missing, expired after 30 min, or another user's) is
treated as its own job and charged once on its first translated batch, so the route is no free pass. Web
subscribers have no per-edit counter (the charge step passes them); iOS free installs would be counted
(iOS does not use this route yet). If the charge is refused (daily limit) the call answers with the refusal
(`429 {code:"daily_limit_reached"…}` and the `X-Inference-Daily-*` headers) and **no translated lines**; the job
may try again. There is still no refund for an edit that was counted and later fails. Trade-off: ElevenLabs
transcription (a cost to us) happens before the charge, bounded by the 20 tokens / 15 min rate limit and the
subscription check on the token route.

`text` is the lightly corrected original; a translation that only repeats the original comes back as
`""`. 503 `lyric_captions_unavailable` without `XAI_API_TOKEN`; 502 `{code:"translation_failed", retryable:true}`
when the model call fails. The server keeps nothing: a restart between batches loses no state and the
client simply repeats the call.

## Browser behavior

* **Pacing:** `STREAM_PACE_DEFAULT = 4`: audio goes out four times faster than real time (0.5 s chunks every 125 ms), so a 56 s clip is sent in about 14 s. Override with `localStorage.setItem('fc.streamPace','1')` (real time; any value is clamped to 0.5–4).
* **Percent:** moves as audio is decoded and sent, not only when a range is translated: `5` once the audio is decoded, then `5 + floor(94 × (½ × seconds sent ÷ total + ½ × seconds transcribed AND translated ÷ total))`, monotonic, **never above 99**; the status shows 100 ("Captions ready") when the lines are ready; there is no burn step in the caption flow. Stage text is honest: `Connecting…` (token/socket), `Listening…` (audio going out / being transcribed), `Translating…` (all audio sent, waiting for the last translations); status line `"<stage> <percent>%"`.
* **Progress object** (`onProgress`): `{percent, stage:'connecting'|'listening'|'translating', text, pickingUp, lines:[{start,end,text,translation}], coveredEnd, ranges:[{index,start,end,status:'pending'|'running'|'transcribed'|'done'|'failed'}]}`.
* **Stall watchdog:** if nothing happens for **20 s** (no chunk sent, no message from the service, no translation) a streaming run is ended as a drop and **resumed** (see Resume); a hang outside a stream (token mint, decode) ends with "Captions stopped making progress. Nothing was changed. Try again." and a **Retry** button. A gap of more than max(3 s, 6 × the watchdog tick) between timer ticks means the page was frozen (phones freeze background tabs), not that the network stalled: the clock restarts and the socket is checked/resumed instead of failed.
* **Never started → upload flow:** if streaming could not start at all (no session was ever accepted: token, WebSocket or decode failed), the tool falls back to the existing upload-based lyric-captions flow, which asks before uploading the video's audio. Once streaming has started there is no fallback; the failure shows one message with **Retry** (not for "declined", "too long" or quota errors).
* **Tab hidden/visible:** the client logs `visibilitychange`, `pagehide`, `pageshow`, `freeze` and `resume`. When the tab becomes visible a socket that is not OPEN, or that has said nothing for 8 s, is replaced at once (no waiting for a timeout) and the UI shows "Picking up where we left off…" until the socket is back. A stalled send counts as a resume, not a failure. On phones the status shows "Keep this tab open until captions finish". The page requests a **screen wake lock** while streaming (released when done, re-requested on return; harmless if unsupported or refused).
* **Cancel:** the editor's Stop aborts: the socket closes, no more audio or translate calls, the job shows as cancelled.
* **Timeouts:** 15 s to connect, 30 s without an answer (also after the last chunk) abandons the socket; each range gets one retry; nothing waits open-ended.
* **Errors from ElevenLabs:** `rate_limited`, `queue_overflow`, `resource_exhausted`, `commit_throttled`: wait 2 s, retry the range once, then "The transcription service is busy. Try again in a moment."; `quota_exceeded`, `unaccepted_terms`: "Translated captions aren't available right now. Try again later."; `auth_error`: silent retry with a fresh token; `session_time_limit_exceeded` and a dropped socket: keep the finished lines and ask to continue; `insufficient_audio_activity`: an empty segment, not an error; any other: retry the range once, then the couldn't-finish message.
* **Resume:** after a drop (or `session_time_limit_exceeded`) the client resumes **by itself up to 3 times per session** (the whole job, not per range; it is not reset when a range finishes): a short backoff (0.5 s, 1.5 s, 3 s), a fresh token (`resumeSessionId`, same job, no new charge) and streaming only from the start of the first unfinished range. Only when that budget is used up and something is already finished does the user see "The connection dropped at 0:34. Captions up to there are kept. [Continue] [Cancel]"; **Continue** grants a new budget of 3. With nothing finished there is nothing to keep, so it ends with the "couldn't finish" message. Timestamps of a resumed session are relative to its start and are offset by that start.
* **Translation failures** retry the translation only (no new socket): 3 tries in all with a 1.5 s then 4 s backoff (network errors, 429, 5xx). A network failure while the tab is hidden does not use a try: it waits for `visibilitychange` to visible (logged `tr_wait_visible`/`tr_resume`) and retries at once. Then the range fails.

## Client log (iPhone debugging)

`POST /api/client-log` (authenticated by the same header/cookie as the app, 16 KB, ≤ 60 events, 600 per 5 min per user) writes one journal line per event: `client-log {"sid":…,"b":<build>,"u":<user id>,"i":…,"ev":…}`. Never audio, transcript, translation text or tokens: those keys are dropped and secret-looking values redacted. The first `env` event is sent immediately with `fetch` `keepalive`, and every other event is sent immediately too, each with `keepalive` (only `pct` and `ws_tick` are batched, at 1 s), so the last event before a tab is killed still arrives. Events: `env`, `vis`, `pagehide`, `pageshow`, `freeze`, `resume`, `plan`, `token_req/res`, `ws_new/open/session_started/first_msg/first_chunk/first_partial/committed/close/tick/error`, `tr_req/tr_res`, `pct`, `auto_resume`, `kick`, `stall`, `timer_gap`, `hidden`, `idle_timeout`, `run_end`, `probe_end`, `extract_start/end`, `streamed`, `run_done`, `captions_attached`, and at export `export_start`, `mux_end`, `mux_error` (code and a short ASCII message), `export_srt_fallback`, `style_ignored` (names of dropped style fields), `decode_error`, `pump_error`. `b` is the build id (git short sha) of the bundle that is running.

## New-version bar

The bundle knows its commit (`__BUILD_ID__`, from `git rev-parse`). The app polls `/api/health` (`commit`) on load, every few minutes and when the tab becomes visible; if the server's commit is different it shows a small "New version available — reload" bar. It never reloads by itself, so it never interrupts a run. For this to work the HTML must not be cached: see "index.html caching" in `docs/DEPLOYMENT.md` / `nginx.conf`.

## Messages (Design wording)

| When | Text |
|---|---|
| Failed, nothing finished | Captions couldn't finish. Nothing was changed. Try again. |
| Service restarted (`job_lost`/`job_expired`, after one silent retry) | Captions couldn't finish because the service restarted. Nothing was changed. Try again. |
| Socket dropped | The connection dropped at 0:34. Captions up to there are kept. **Continue** / **Cancel** |
| Session time limit | The transcription session reached its time limit at 0:34. Captions up to there are kept. **Continue** / **Cancel** |
| Busy | The transcription service is busy. Try again in a moment. |
| Audio over 10 min | This video's audio is too long for translated captions. Try a clip under 10 minutes. |
| 503 unavailable | Translated captions aren't available right now. Try again later. |

## Privacy

There is **no consent prompt** on web: asking for captions starts the stream (the privacy page's "Streaming captions (optional)" section says so and says what leaves the browser). The only dialog left in this flow is **Continue / Cancel** after a dropped connection.


Audio goes from the browser directly to ElevenLabs. ElevenLabs retains audio and transcripts by
default; zero-retention mode is Enterprise-only (`enable_logging=false`), so it is not used. Do not tell
users ElevenLabs deletes anything. The privacy page has a "Streaming captions (optional)" section
(`#streaming-captions`), a subprocessor line and a retention line. The server handles the transcript
text in memory per request and stores nothing.

## Real-key test results (2026-10-18)

Run against the live API from the build box with a ~56 s non-repeating speech clip (11 sentences, known
start times), commits at 24.8 s and 50.4 s, `scribe_v2_realtime`, `pcm_16000`, 0.5 s chunks. Token mint
worked every time (HTTP 200); the key and tokens were never logged.

* **Word timestamps (verified):** 8 of 8 sentence starts that the model transcribed verbatim were within
  **0.05-0.14 s** of the truth (mean +0.09 s), at 2x and 4x, across all three commits, with no
  non-monotonic word starts. In a session that is not resumed, `words[].start/end` are **session-absolute**
  (the 2nd commit starts at 25.42 s, not 0.6 s). In a **resumed session** (a new socket that begins at
  50.4 s) they are **relative to that session's start** (the commit's first word was at 0.82 s). The client's
  `offsetWords` handles both; the burned lines were identical in both cases.
* **Commits:** one `committed_transcript` plus one `committed_transcript_with_timestamps` per `commit: true`,
  in order. Without a commit the service **auto-commits around 36 s** of audio, so a commit every 20-30 s (as
  the planner does) is needed to keep ranges aligned.
* **Pacing:** 2x and 4x are accepted: no `rate_limited`, `queue_overflow` or `commit_throttled`, same text and
  same timestamps as 1x (a 56 s clip finished in 28.7 s at 2x and 14-19 s at 4x, including a drop and resume).
  **Caveat:** the socket is frequently closed by the far end or the network with code **1006** (no close frame, no error
  message), at any pace, including 1x and with a bare 30-line client that does not use this module. In a
  series of 12 minimal-client runs only 2 finished. The resume path (fresh token, continue from the first unfinished
  range) recovered some drops, but a second drop in a row exhausts the per-range retry ("couldn't finish").
  `keepalive_interval_ms` in the query made it worse and is no longer sent. Browser WebSocket stacks
  (which negotiate permessage-deflate) have **not** been tested, and Node `ws` with permessage-deflate dropped 2 of 2;
  test in real Safari/Chrome before turning pacing above 1x on by default.
* **Default is 4x** (decision of the product owner). `fc.streamPace` can turn it back down (1 = real time); max 4.

## Drop-rate sweep at 4x (2026-10-18, from the build box)

Raw `ws` client, the ~56 s speech clip, 4x pace, 8 runs per variant, real key (never logged). A "drop" is a close with code 1006 before the audio finished. `control_echo` is an **unrelated** WebSocket echo server, not ElevenLabs.

| Variant | Drops / runs | Drop times (s into the run) |
|---|---|---|
| baseline (manual commits, 0.5 s chunks, timestamps + language detection) | 5 / 8 | 11.4, 4.2, 4.1, 1.3, 9.3 |
| `commit_strategy=vad` | **3 / 8** | 5.9, 9.2, 10.9 |
| 0.25 s chunks | 5 / 8 | 8.7, 4.6, 12.8, 2.9, 11.3 |
| 1 s chunks | 6 / 8 | 3.5, 12.7, 2.9, 4.3, 1.2, 1.0 |
| no `include_timestamps` | 6 / 8 | 3.8, 1.4, 11, 23.3, 7.5, 0.8 |
| no language detection | 4 / 8 | 3.4, 0.8, 2.6, 2.2 |
| `language_code=en` | 5 / 8 | 3.5, 7.6, 6.2, 1.8, 2.3 |
| US host (`api.us.elevenlabs.io`) | 6 / 8 | 5.2, 1.8, 7.6, 3.8, 1.9, 1.4 |
| control: unrelated echo server | 7 / 8 | 0.7, 5.3, 2.7, 16.4, 5.3, 2.9, 16.3 |

Conclusion: **no variant is clearly better.** `vad` (3/8) and no-language-detection (4/8) are the lowest, but with 8 runs each the gap to the baseline (5/8) is within noise, and `vad` removes our own commit points (the planner aligns ranges to them), so it is not worth the risk. The unrelated echo server drops about as often (7/8), so the drops come from the box's network path, not from anything in the request. **Defaults are unchanged** (manual commits, 0.5 s chunks, 4x, timestamps and language detection on). The client's resume logic (3 automatic resumes, fresh token, continue from the first unfinished range) is the mitigation; test in real Safari/Chrome on a consumer network before drawing conclusions about browsers.

## Still to check in a real browser

* The 1006 drops above, in Safari and Chrome, from a normal consumer network.
* Maximum session length and the token's first-use window.
