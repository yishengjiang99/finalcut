# Client tool execution (`POST /api/chat` with `execution: "client"`)

Lets a native client (iOS) plan edits with Grok and **execute the tool calls on the
device**. The server never runs ffmpeg in this mode and never receives the media;
it only sees metadata and (optionally) up to 4 small thumbnails.

Omitting `execution` keeps the existing streaming (SSE) behaviour exactly as before.
Any other value than `"client"` is rejected with 400.

## Auth and quota

Same as normal chat: `Authorization: Bearer <accessToken>`, `sample-access-token`,
or a session cookie. Every POST (first turn and every tool-result continuation)
counts as one chat turn against the free daily inference quota (`429
daily_limit_reached` when exhausted; subscribers are unlimited).

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
  "thumbnailsSentAsImages": false
}
```

If the model's arguments are not valid JSON, the call has `"arguments": {}` and
`"argumentsError": "invalid_arguments_json"`.

## 2. Continue with tool results

Execute each tool call on the device. Then POST `messages` from the previous response
with one OpenAI-style tool message appended per call:

```json
{
  "execution": "client",
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
