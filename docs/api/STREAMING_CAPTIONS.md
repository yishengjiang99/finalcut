# Streaming captions (web)

Plain speech captioning on the web ("add captions in Chinese") streams the video's **audio** from the
browser straight to ElevenLabs realtime speech-to-text (`scribe_v2_realtime`), translates the committed
text with Grok through our server, and burns the captions in the browser (ffmpeg.wasm). The picture is
never uploaded. Songs (`mode: "lyrics"`) and the iOS app keep the upload-based
[lyric_captions](LYRIC_CAPTIONS.md) flow.

Source: `src/streamingCaptions.js` (browser), `src/server/streamingCaptions.js` (server),
`src/lyricShared.js` (line building and ASS, shared). Tests mock ElevenLabs.

## Prod config

```
ELEVENLABS_API_KEY=...        # in /home/finalcut/apps/pages/finalcut/.env  (never commit it)
# ELEVENLABS_API_BASE=https://api.us.elevenlabs.io   # optional regional host (https only)
```

Plus the keys the translate step already needs (`XAI_API_TOKEN`) and, for the burn fallback, the
`fonts-noto-cjk` package and an ffmpeg with libass. Restart `finalcut` after editing `.env`. Without
`ELEVENLABS_API_KEY`: `GET /api/streaming-captions/status` says `available:false`, the token route
answers 503, and the chat tool uses the older flow. The key stays on the server; only a 15-minute
single-use token reaches the browser. No CSP is set today; if one is added it needs
`connect-src wss://api.elevenlabs.io`.

## Flow

1. `GET /api/streaming-captions/status` → `{available}`; the tool uses this flow only when true and the mode is not `lyrics`.
2. Consent every time: **"Send the audio to ElevenLabs?"** (see below). "Not now" ends the tool with "Audio not sent. Nothing was changed."
3. The browser extracts the audio (16 kHz mono PCM), plans commit points at the quietest spot 20–30 s apart.
4. `POST /api/streaming-captions/token` just before connecting. Connect to `wsUrl?…&token=…`.
5. Stream 0.5 s chunks (`input_audio_chunk`, `commit:true` on the chunk that ends a segment) at the pacing constant.
6. Each `committed_transcript_with_timestamps` becomes caption lines; lines are translated in order in batches of ≤ 20 with `POST /api/streaming-captions/translate`, while later audio is still streaming.
7. When every range is transcribed and translated, the browser burns the final lines (Noto Sans CJK SC Bold 48 at 720×1280, scaled; MarginV 20 %; Alignment 2; one two-line Dialogue per caption). The captions-lineage guard makes a second run replace, not stack.

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

### `POST /api/streaming-captions/burn` (consented fallback)

Multipart: `video` (file), `lines` (JSON array of `{start,end,text,translation}`, ≤ 3000),
`target_language?`, `language?`, `args?` (`{position_from_bottom_pct, font_size}`). Returns `video/mp4`.
Used only when the browser cannot burn and the user agrees to upload the video. Same ASS builder as
the lyric burn. 400 on malformed lines, 503 `lyric_captions_unavailable` without ffmpeg/libass/the font.

## Browser behavior

* **Pacing:** `STREAM_PACE_DEFAULT = 4`: audio goes out four times faster than real time (0.5 s chunks every 125 ms), so a 56 s clip is sent in about 14 s. Override with `localStorage.setItem('fc.streamPace','1')` (real time; any value is clamped to 0.5–4).
* **Percent:** `floor(99 × seconds transcribed AND translated ÷ total seconds)`, monotonic, **never above 99**; the UI shows 100 only after the burn. Stage text: `Listening…`, `Translating…`; status line `"<stage> <percent>%"`.
* **Progress object** (`onProgress`): `{percent, stage:'listening'|'translating', text, lines:[{start,end,text,translation}], coveredEnd, ranges:[{index,start,end,status:'pending'|'running'|'transcribed'|'done'|'failed'}]}`.
* **Cancel:** the editor's Stop aborts: the socket closes, no more audio or translate calls, the job shows as cancelled.
* **Timeouts:** 15 s to connect, 30 s without an answer (also after the last chunk) abandons the socket; each range gets one retry; nothing waits open-ended.
* **Errors from ElevenLabs:** `rate_limited`, `queue_overflow`, `resource_exhausted`, `commit_throttled`: wait 2 s, retry the range once, then "The transcription service is busy. Try again in a moment."; `quota_exceeded`, `unaccepted_terms`: "Translated captions aren't available right now. Try again later."; `auth_error`: silent retry with a fresh token; `session_time_limit_exceeded` and a dropped socket: keep the finished lines and ask to continue; `insufficient_audio_activity`: an empty segment, not an error; any other: retry the range once, then the couldn't-finish message.
* **Resume:** after a drop (or `session_time_limit_exceeded`) the client resumes **by itself up to 3 times per session** (the whole job, not per range; it is not reset when a range finishes): a short backoff (0.5 s, 1.5 s, 3 s), a fresh token (`resumeSessionId`, same job, no new charge) and streaming only from the start of the first unfinished range. Only when that budget is used up and something is already finished does the user see "The connection dropped at 0:34. Captions up to there are kept. [Continue] [Cancel]"; **Continue** grants a new budget of 3. With nothing finished there is nothing to keep, so it ends with the "couldn't finish" message. Timestamps of a resumed session are relative to its start and are offset by that start.
* **Translation failures** retry the translation only (no new socket): once, then the range fails.

## Messages (Design wording)

| When | Text |
|---|---|
| Consent title | Send the audio to ElevenLabs? |
| Consent body | FinalCap will stream this video's audio, but not the picture, to ElevenLabs to transcribe it. ElevenLabs may keep the audio and the transcript, and FinalCap can't delete them. The text is then sent to FinalCap, which sends it to xAI (Grok) to translate. **Privacy details** → `/legal/privacy.html#streaming-captions` |
| Consent buttons | **Send audio** / **Not now** (decline is focused) |
| Declined | Audio not sent. Nothing was changed. |
| Failed, nothing finished | Captions couldn't finish. Nothing was changed. Try again. |
| Service restarted (`job_lost`/`job_expired`, after one silent retry) | Captions couldn't finish because the service restarted. Nothing was changed. Try again. |
| Socket dropped | The connection dropped at 0:34. Captions up to there are kept. **Continue** / **Cancel** |
| Session time limit | The transcription session reached its time limit at 0:34. Captions up to there are kept. **Continue** / **Cancel** |
| Busy | The transcription service is busy. Try again in a moment. |
| Audio over 10 min | This video's audio is too long for translated captions. Try a clip under 10 minutes. |
| 503 unavailable | Translated captions aren't available right now. Try again later. |

## Privacy

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

## Still to check in a real browser

* The 1006 drops above, in Safari and Chrome, from a normal consumer network.
* Maximum session length and the token's first-use window.
