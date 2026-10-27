# Client tool execution (`POST /api/chat` with `execution: "client"`)

Lets a native client (iOS) plan edits with Grok and **execute the tool calls on the
device**. The server never runs ffmpeg for the turn itself; it only sees metadata and
(optionally) up to 4 small thumbnails — unless the app uploads media to a metered media
route (`/api/jobs/process-video`, or the `ffmpeg_cli` fallback's `/api/ffmpeg-cli/run`)
because no on-device tool can handle the request.

Omitting `execution` keeps the existing streaming (SSE) behaviour exactly as before.
Any other value than `"client"` is rejected with 400.

## Auth and quota

Same as normal chat: `Authorization: Bearer <accessToken>`, `sample-access-token`,
or a session cookie. The free daily inference quota (`429 daily_limit_reached` when
exhausted; subscribers are unlimited) is charged **once per edit turn**:

- The first POST of a turn (a new user message) is charged.
- Every `status: "tool_calls"` response carries a top-level `turnToken` (opaque string).
  Echo the **latest** one as a top-level `turnToken` in the next continuation POST (see §2).
  Each round issues a new token; each token works for one continuation. A continuation
  with a valid token is not charged, and is allowed even if the quota ran out mid-turn
  (response header `X-Inference-Charged: false`).
- A missing, reused, expired (30 min) or mismatched token is not an error: the request is
  charged like a new turn. Clients that don't send it (build 9) are charged per POST.
- If the phone asks the server to run one of the turn's tool calls (a metered media route
  such as `/api/jobs/process-video`), send headers `X-Turn-Token: <latest turnToken>` and
  `X-Tool-Call-Id: <toolCalls[i].id>`. Each tool call id runs free once; anything else is
  charged per request as before.

With `FREE_EDITS_IOS=unlimited`, iOS clients are never limited, and usage is counted with
the same per-turn rule. See [`FREE_EDITS_IOS.md`](./FREE_EDITS_IOS.md).

## Tool schema

`GET /api/tools/schema` (public, cacheable) returns

```json
{
  "schemaVersion": "1",
  "tools": [ { "type": "function", "function": { "name": "apply_color_filter", "parameters": { … } } }, … ],
  "mediaTypes": { "apply_color_filter": ["video", "image"], "trim_video": ["video"], "convert_image_format": ["image"], … }
}
```

The same document is committed as [`tools-schema.v1.json`](./tools-schema.v1.json).
`src/test/client-tool-execution.test.js` fails if `src/tools.js` drifts from it; after
changing tools, bump `TOOLS_SCHEMA_VERSION` in `src/server/toolsSchema.js` when the
change is breaking and run `npm run schema:tools`.

`arguments` in tool calls have exactly the shape of these function parameters (the
same objects the web `toolFunctions.js` receive).

Additive, optional parameters are added within schemaVersion `"1"`; clients must ignore
properties they don't know. Additions so far:

- `audio_fade.start` (number of seconds, `minimum: 0`, optional): where the fade begins,
  measured from the start of the clip. The fade runs from `start` to `start + duration`. For a
  fade-in the audio is silent before `start`; for a fade-out it is silent after
  `start + duration`. If omitted, a fade-in starts at `0` and a fade-out starts at
  `max(0, clip length - duration)`, so it ends at the end of the clip. A negative or
  non-numeric value returns **400** `{ "code": "invalid_arguments" }` from
  `POST /api/process-video` and `POST /api/jobs/process-video`.

## iOS User-Agent and tool allowlist

The server decides which tools the FinalCap iOS app gets. The app sends no capability
list. It identifies itself with its User-Agent:

```
User-Agent: FinalCap-iOS/<build>        e.g. FinalCap-iOS/10   (build = CFBundleVersion, integer)
```

The rule lives in `src/server/iosToolAllowlist.js` (`IOS_TOOL_ALLOWLIST`, `{ toolName: minBuild }` or
`{ toolName: { minBuild, maxBuild } }`, both inclusive), with UA
parsing in `src/server/clientInfo.js` (`^FinalCap-iOS/(\d+)`). For a UA starting with
`FinalCap-iOS`:

- A tool is offered only if it is on the allowlist **and** `minBuild <= build <= maxBuild`, intersected
  with the tools valid for `media.type`.
- A missing or unparseable build (`FinalCap-iOS`, `FinalCap-iOS/abc`) or a build older than
  every entry gets **no** tools. It never falls back to the full list.
- Device-limited arguments are narrowed in the offered definitions: `convert_video_format.format`
  ∈ `mp4|mov`, `convert_image_format.format` ∈ `jpg|png`, `adjust_speed.speed` 0.25–4.
  `generate_captions` has no `translate_language` (no on-device translator), and its
  description and `position`/`burn_in` text describe on-device speech and burn-in instead of the
  server/FFmpeg pipeline. `language`, `style`, `position` and `burn_in` are unchanged otherwise.

This applies to `POST /api/chat` in every mode (client mode: the offered `tools`; default
streaming mode: client-sent `tools` are filtered, and `tools`/`tool_choice` are dropped when none
remain). It also applies to `GET /api/tools/schema`, which returns the filtered `tools` and `mediaTypes`
with the same `schemaVersion: "1"` and `Vary: User-Agent`.

Any other UA gets all 46 tools exactly as before. That includes web browsers and iOS build 9 and
earlier, which send the default `FinalCap/<build> CFNetwork/…` UA and still upload to the server.
The web request is byte-for-byte unchanged.

Allowlist for build 10 (from `docs/ios/native-tools.md`, "iOS allowlist (build 10)"), all
`minBuild: 10`: trim_video, adjust_speed, crop_video, rotate_video, flip_video_horizontal,
flip_video_vertical, resize_video, resize_video_preset, adjust_brightness, adjust_contrast,
adjust_saturation, adjust_hue, apply_color_filter, add_text, adjust_audio_volume, audio_fade,
get_video_dimensions, get_supported_formats, convert_video_format, convert_image_format, plus
**generate_captions** (on-device speech, no translation). That's 21 tools. `translate_captions` and
`burn_subtitles` are not tools the model sees and are not allowlisted. To ship a tool on device in
a later build, add `tool_name: <build>` to the allowlist.

Grouped effect tools (`channel_mixer`, `color_adjust`, `apply_filter`, `stylize`, `blur_sharpen`,
`lut`, `vignette_grain`, `segment`, `audio_effect`) are iOS-only definitions gated on
`GROUPED_EFFECTS_MIN_BUILD`, which is currently off for every real build. From that build on, the
four `adjust_*` tools are retired and iOS gets 26 tools. See [`IOS_GROUPED_TOOLS.md`](./IOS_GROUPED_TOOLS.md).

## 1. First turn

```http
POST /api/chat
Authorization: Bearer …
Content-Type: application/json

{
  "execution": "client",
  "messages": [{ "role": "user", "content": "Apply a red filter" }],
  "media": { "type": "image", "width": 4032, "height": 3024 },
  "thumbnails": ["/9j/4AAQSkZJRgABAQ…"]
}
```

- `media`: `{ type: "video"|"image", duration?, width?, height?, fps?, hasAudio?, codec? }`.
  It goes into the system prompt. For `image` only photo-capable tools are offered.
- `thumbnails`: at most **4** base64 JPEG/PNG strings (raw or `data:image/jpeg;base64,…`),
  each at most **300KB** decoded. More than 4 returns **400**, an oversized one **413**,
  and non-image data **400**.
- Client `system` messages are ignored (the server owns the system prompt).

Response:

```json
{
  "schemaVersion": "1",
  "status": "tool_calls",
  "toolCalls": [
    { "id": "call_1", "name": "apply_color_filter", "arguments": { "filter": "red", "intensity": 1 } }
  ],
  "messages": [
    { "role": "user", "content": "Apply a red filter" },
    { "role": "assistant", "content": null, "tool_calls": [
      { "id": "call_1", "type": "function", "function": { "name": "apply_color_filter", "arguments": "{\"filter\":\"red\",\"intensity\":1}" } }
    ] }
  ],
  "round": 1,
  "maxRounds": 6,
  "thumbnailsSentAsImages": false,
  "turnToken": "v1.eyJ1Ijoi…"
}
```

If the model's arguments are not valid JSON, the call has `"arguments": {}` and
`"argumentsError": "invalid_arguments_json"`.

## 2. Continue with tool results

Execute each tool call on the device. Then POST `messages` from the previous response
with one OpenAI-style tool message appended per call, plus the `turnToken` from that
response (so the continuation isn't charged as a new turn):

```json
{
  "execution": "client",
  "turnToken": "v1.eyJ1Ijoi…",
  "media": { "type": "image", "width": 4032, "height": 3024 },
  "messages": [
    …previous messages…,
    { "role": "tool", "tool_call_id": "call_1",
      "content": { "ok": true, "executedOn": "device", "output": { "width": 4032, "height": 3024 } } }
  ]
}
```

`content` may be a JSON object or a JSON string:
`{ ok, error?, executedOn: "device"|"server", output?: { duration, width, height } }`.

The response is either another `status: "tool_calls"` round or the final answer:

```json
{
  "schemaVersion": "1",
  "status": "final",
  "message": "Applied a red filter to your photo.",
  "messages": [ …, { "role": "assistant", "content": "Applied a red filter to your photo." } ],
  "thumbnailsSentAsImages": false
}
```

## Skipped steps (`skipped_by_user`)

If the user declines a step on device, return

```json
{ "role": "tool", "tool_call_id": "call_1",
  "content": { "ok": false, "error": "skipped_by_user", "executedOn": "device" } }
```

This is treated as an intentional choice, **not a failure**. In the current user turn:

- the tool message the model sees is annotated with `skipped: true` and a note that the
  user declined the step and that it must not call that tool again this turn;
- the system context lists the declined tools;
- the declined tool is removed from the offered tools, and any re-call of it is dropped.
  The model continues with the remaining steps and then gives the final answer.

## Tools the phone can't run (`unsupported_on_device`)

This is a safety net behind the allowlist. If the device gets a call it can't execute, return

```json
{ "role": "tool", "tool_call_id": "call_1",
  "content": { "ok": false, "code": "unsupported_on_device", "executedOn": "device" } }
```

The documented field is **`code`**, matching the server error codes. For tolerance, `error` or
`reason` with the same value are also accepted (build 10 sends `error`). In the current user turn:

- the tool message is annotated with `unsupportedOnDevice: true` and a note telling the model
  not to call or retry that tool and to tell the user briefly that the edit isn't available on the phone yet;
- the system context lists those tools;
- the tool is removed from the offered tools, and any re-call of it is dropped. If the final
  reply is empty, `message` is "Sorry, that edit isn't available on the phone yet."

## Loop cap

At most **6** assistant tool-call rounds per user turn (`maxRounds`). Once the cap is
reached, tools are withheld and the model has to reply with `status: "final"`. This
stops device retry loops.

## Thumbnails and vision

Thumbnails are sent to the model as `image_url` inputs (`detail: "low"`) only when
`XAI_CLIENT_MODEL` is set to a model that accepts images. By default this mode uses the
same model as the streaming chat (`XAI_CHAT_MODEL`, default `grok-4.3`) and thumbnails
stay on the server: only the metadata is used and `thumbnailsSentAsImages` is `false`.
Set `XAI_CLIENT_MODEL` to a vision-capable Grok model (for example `grok-4.3`) to
forward the thumbnails. The response then reports `thumbnailsSentAsImages: true`.

## Project context (multi-clip projects)

Timeline-enabled clients may attach a metadata-only snapshot of the whole
editing project to a client-execution request — as a top-level `project` field,
or as `media.project` (the shape the native `ProjectSummary` Codable emits).
It is optional; requests without it behave exactly as before. The snapshot
carries IDs, labels, durations and ranges only — never media bytes and never
local file paths (any `path`/`url`-style key is rejected with 400).

```json
{
  "execution": "client",
  "messages": [],
  "media": { "type": "video", "duration": 27, "width": 1920, "height": 1080, "hasAudio": true },
  "project": {
    "schemaVersion": 1,
    "projectId": "project-123",
    "revision": 18,
    "duration": 27,
    "canvas": { "width": 1920, "height": 1080, "fps": 30 },
    "assets": [
      { "id": "asset-beach", "type": "video", "label": "beach.mov", "duration": 10, "hasAudio": true },
      { "id": "asset-music", "type": "audio", "label": "music.m4a", "duration": 60 }
    ],
    "videoClips": [
      { "id": "clip-1", "assetId": "asset-beach", "timelineStart": 0, "sourceStart": 0, "sourceEnd": 10 }
    ],
    "audioTracks": [
      { "id": "track-music", "label": "Background Music", "kind": "music", "volume": 0.2, "muted": false,
        "clips": [{ "id": "audio-1", "assetId": "asset-music", "timelineStart": 0, "sourceStart": 0, "sourceDuration": 27 }] }
    ],
    "selectedClipId": "clip-1"
  }
}
```

The native summary's field names (`projectID`, `durationSeconds`, `assetID`,
`timelineStartSeconds`, `gain`, …) are accepted as aliases and normalized to
the shape above. All times are **seconds**: `source*` fields are in
source-media time, `timelineStart` is in project-timeline time.

Validation (server, `src/server/projectContext.js`): serialized snapshot ≤
64 KB; ≤ 200 assets, ≤ 500 video clips, ≤ 64 audio tracks, ≤ 500 audio clips
per track (≤ 1000 total); IDs must be stable ID strings (no spaces/paths);
times must be finite and non-negative; clip → asset references must resolve;
IDs must be unique; `selectedClipId` must name a real clip. Violations are
400 (413 for size/count limits). The server does not persist the snapshot.

The model receives a **bounded summary** of the snapshot in the system prompt
(≤ 60 assets, ≤ 40 video clips windowed around the selected clip, ≤ 16 audio
tracks, ≤ 20 audio clips per track). When anything is cut, the summary is
flagged `truncated` and the prompt tells the model explicitly that it has not
seen the whole project and must use the inspection tools. Labels are
JSON-encoded into the prompt and marked as data, not instructions.

Responses (`tool_calls` and `final`) echo `project: { projectId, revision? }`
when a snapshot was sent.

### Thumbnail associations (`thumbnailRefs`)

With multiple clips, a thumbnail's identity must not depend on array position.
Clients may send `thumbnailRefs` alongside `thumbnails`:

```json
{ "thumbnailRefs": [{ "thumbnailIndex": 0, "assetId": "asset-beach", "sourceTime": 3.0 }] }
```

`thumbnailIndex` must reference a provided thumbnail; `assetId`/`clipId` must
match the project snapshot when one is sent. The model is told exactly which
asset/clip each thumbnail shows, and that it has not visually inspected
anything else. Counts and byte limits are unchanged (≤ 4, ≤ 300 KB each).

## Timeline tools

Multi-clip / multi-track editing runs through 25 iOS-only tool definitions
(`src/server/iosTimelineTools.js`, catalogued in
[`IOS_TIMELINE_TOOLS.md`](./IOS_TIMELINE_TOOLS.md)) whose names and argument
shapes match the shipped device executor exactly (snake_case:
`get_timeline`, `list_project_assets`, `get_clip_info`,
`get_project_duration`; video mutations append/reorder/split/trim/remove/
duplicate, `set_video_clip_speed`, `apply_clip_effect`,
`set_video_clip_transition`; audio mutations `create_audio_lane`,
`insert_audio_clip`, move/trim/remove, clip/track volume, `mute_audio_track`,
`set_audio_fade`, `loop_audio_clip`, `set_audio_ducking`; and
`set_project_canvas`). They are offered only to FinalCap-iOS builds ≥
`TIMELINE_TOOLS_MIN_BUILD` (= 21, the first build of app version 1.2;
`src/server/iosToolAllowlist.js`), only for video media, and never to web
clients. Timeline system-prompt rules (scoping, timing, recovery, sequencing)
are injected only when a project snapshot is present **and** the build is
offered the tools; a snapshot sent to an older build changes nothing except a
note that timeline tools are unavailable on that build.

Successful mutation results carry the device's fresh project summary:
`output: { project_duration, project, affected_ids?, created_id?, message? }`.
Failures are `{ ok: false, error: "<code>" }` or `"<code>: <hint>"`. Stable
timeline error codes: `invalid_arguments`, `asset_not_found`,
`clip_not_found`, `audio_track_not_found`, `invalid_source_range`,
`invalid_timeline_position`, `unsupported_on_device`,
`resource_limit_exceeded`, `cancelled`, `no_media`.

The server also validates timeline call arguments against the declared
schemas before returning them: a malformed call comes back with
`arguments: {}` and `argumentsError: "invalid_arguments"`, so the device can
answer through the normal tool-result path. The 6-round loop cap is
unchanged; multi-step plans fit by sequencing calls and chaining on each
result's fresh summary (batching/revision checks are deferred beyond v1.2 —
the device executor does not implement them).
