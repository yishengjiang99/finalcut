# iOS timeline tools (multi-clip projects, multi-track audio)

Server-side contract for the agentic timeline editing shipped with the
multi-clip FinalCap iOS project model (app version 1.2). Definitions live in
`src/server/iosTimelineTools.js`; gating in `src/server/iosToolAllowlist.js`
(`TIMELINE_TOOLS_MIN_BUILD`); project-context validation in
`src/server/projectContext.js`; the wire protocol is the existing
client-execution mode of `POST /api/chat` (see
[`CLIENT_TOOL_EXECUTION.md`](./CLIENT_TOOL_EXECUTION.md)).

## Ownership

- **Server**: model interaction, prompt construction, tool definitions,
  build gating, argument schema validation, round limits, usage accounting,
  bounded telemetry (counts/codes only).
- **iPhone**: assets, project state, composition, preview, rendering, export,
  and every actual edit. The server never treats its snapshot as more
  authoritative than the device; inspection tools read live device state.

## The binding constraint: the device executor's vocabulary

Tool names and argument shapes are EXACTLY the ones the shipped device
executor parses (`ios/FinalCut/Timeline/TimelineToolExecutor.swift`,
`TimelineTools.names`, dispatching to `ProjectCommand`). They are snake_case
(`clip_id`, `track_id`, `asset_id`, `timeline_start`, `source_start`, …).
Renaming a tool server-side only breaks it — a name the device does not know
falls through to `unsupported_on_device`. Any contract change must land on
the device first (or in the same release).

## Build gating (by app version)

Timeline tools are gated to **app version 1.2 and later**. The gate constant
is build-based because the client UA carries the build number:
`TIMELINE_TOOLS_MIN_BUILD = 21`, where 21 is the first build of version 1.2 —
the `ios-testflight.yml` workflow stamps `CURRENT_PROJECT_VERSION` with its
run_number, and the v1.2 dispatch was run 21. Build numbers are monotonic
across dispatches, so build ≥ 21 ⇔ version ≥ 1.2 for every build this
pipeline produces. Older builds keep exactly their previous tool set; web
clients never see these tools; photo media never receives them. The five
timeline suggestion pills in `config/ios-suggestions.json` carry the same
`minBuild: 21`.

## Project snapshot (`media.project`)

Timeline-capable clients attach a metadata-only snapshot of the whole project
to each client-execution request as `media.project` (the native
`ProjectSummary` shape; a top-level `project` field is also accepted and
wins). Validated by `projectContext.js`: IDs/labels/durations/ranges only,
≤ 64 KB serialized, no media bytes, and any `path`/`url`-style key anywhere
is rejected with 400. The server derives a bounded model-facing summary
(windowed around the selected clip); when it truncates, the prompt says so
and the model must use `get_timeline` / `list_project_assets`.

## Tool catalog (25 tools)

All times are **seconds**. `start`/`end`/`source_*` = source-media time;
`timeline_start`/`at` = project-timeline time. Gains are linear
(1 = unchanged, 0.2 = 20%).

Inspection (every result carries the fresh summary in `output.project`):

| Tool | Arguments |
| --- | --- |
| `get_timeline` | — (full summary + `project_duration`) |
| `list_project_assets` | — (summary's asset list resolves names → UUIDs) |
| `get_clip_info` | `clip_id` → `output.clip` details |
| `get_project_duration` | — → `output.duration` |

Video mutations:

| Tool | Arguments |
| --- | --- |
| `append_video_clips` | `asset_ids[]` (full source range, appended in order) |
| `reorder_video_clips` | `clip_ids[]` (every current clip exactly once) |
| `split_video_clip` | `clip_id`, `at` (project time) |
| `trim_video_clip` | `clip_id`, `start`, `end` (source time) |
| `remove_video_clip` | `clip_id` |
| `duplicate_video_clip` | `clip_id` |
| `set_video_clip_speed` | `clip_id`, `speed` |
| `apply_clip_effect` | `clip_id?` (omit = all clips), `kind`, `value?`/`filter?`/`intensity?` |
| `set_video_clip_transition` | `clip_id`, `type` (cut/cross_dissolve/fade_through_black), `duration?` |

Audio mutations:

| Tool | Arguments |
| --- | --- |
| `create_audio_lane` | `name?`, `kind?` (music/voiceover/effects/other) |
| `insert_audio_clip` | `track_id`, `asset_id`, `timeline_start`, `source_start?`, `source_duration?`, `volume?`, `loop?`, `repeat_until?` |
| `move_audio_clip` | `clip_id`, `timeline_start`, `track_id?` |
| `trim_audio_clip` | `clip_id`, `source_start`, `source_duration` |
| `remove_audio_clip` | `clip_id` |
| `set_audio_clip_volume` | `clip_id`, `volume` |
| `set_audio_track_volume` | `track_id`, `volume` |
| `mute_audio_track` | `track_id` XOR `clip_id` (a video clip's original audio), `muted?` |
| `set_audio_fade` | `clip_id`, `type` (in/out), `duration` |
| `loop_audio_clip` | `clip_id`, `repeat_until?` |
| `set_audio_ducking` | `clip_id` (the MUSIC clip), `attenuation?` — device analyses speech on-device |

Project:

| Tool | Arguments |
| --- | --- |
| `set_project_canvas` | `width`, `height`, `fit?` (aspect_fit/aspect_fill) |

## Results and errors

Success (device executor's `timelineSuccess`):

```json
{ "ok": true, "executedOn": "device",
  "output": { "project_duration": 27, "project": { "…fresh ProjectSummary…" },
              "affected_ids": ["…"], "created_id": "…", "message": "…" } }
```

`affected_ids` / `created_id` appear when the command reports them. The fresh
`project` summary after every mutation is what makes multi-step chaining
reliable within the 6-round cap.

Failures are `{ "ok": false, "error": "<code>" }` or
`"<code>: <human hint>"` (e.g. `"clip_not_found: call get_timeline for
current clip IDs"`). Codes the model may see: `invalid_arguments`,
`asset_not_found`, `clip_not_found`, `audio_track_not_found`,
`invalid_source_range`, `invalid_timeline_position`,
`unsupported_on_device`, `resource_limit_exceeded`, `cancelled`, `no_media`,
plus the pre-existing `skipped_by_user`. No filesystem paths or exception
traces ever appear in a model-visible result.

## Agent behavior (server prompt)

`TIMELINE_AGENT_INSTRUCTIONS` is appended to the client-execution system
prompt only when a project snapshot is present AND the build is offered
timeline tools. Rules cover: inspect-before-editing and ID resolution, scope
discipline (clip vs track vs project; `mute_audio_track` + `clip_id` for one
clip's original audio), preserving unspecified properties, source- vs
project-time, ducking semantics, honest completion reporting, error recovery
without loops (follow the hint; re-inspect once), and sequencing inside the
round cap. When a snapshot is present but the build has no timeline tools,
the prompt instead says the project is visible but not editable per-clip.

## Deferred beyond v1.2

Not implemented by the v1.2 device executor, and therefore NOT offered:
batched edits (`batch_timeline_edits`), project revision checks
(`expectedRevision`), idempotency keys, insert-at-index for video,
per-track detail queries, separate per-clip original-audio tool (subsumed by
`mute_audio_track` with `clip_id`). Adding any of these requires a device
release first; the server definitions must follow the device, per the
binding-constraint note above.
