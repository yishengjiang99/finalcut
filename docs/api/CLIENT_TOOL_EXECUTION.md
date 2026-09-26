# Client tool execution (`POST /api/chat` with `execution: "client"`)

Lets a native client (iOS) plan edits with Grok and **execute the tool calls on the
device**. The server never runs ffmpeg in this mode and never receives the media;
it only sees metadata and (optionally) up to 4 small thumbnails.

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

Thumbnails are sent to the model as `image_url` inputs (`detail: "low"`) only when the
configured model accepts images. By default this mode uses the same model as the
streaming chat (`grok-3`), which has no image input, so only the metadata is used
and `thumbnailsSentAsImages` is `false`. Set `XAI_CLIENT_MODEL` to a vision-capable
Grok model (for example a `grok-4.x` model) to forward the thumbnails. The response
then reports `thumbnailsSentAsImages: true`.
