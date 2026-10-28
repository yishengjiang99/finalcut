# iOS timeline tools (multi-clip projects, multi-track audio)

Server-side contract for the agentic timeline editing shipped with the
multi-clip FinalCap iOS project model. Definitions live in
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

## Build gating

`TIMELINE_TOOLS_MIN_BUILD = 14`: gating is by app version — the timeline
executor first ships in **app version 1.2, build 14** (PR #124;
TestFlight-workflow builds stamp higher run_numbers and also pass). Builds
≤ 13 keep exactly their previous tool set; web clients never see these tools;
photo media never receives them.

## Tool catalog

All times are **seconds**. `source*` = source-media time; `timeline*` /
`atProjectTime` = project-timeline time. Gains are linear (1 = unchanged,
0.2 = 20%). Every mutation accepts optional `expectedRevision` (integer) and
`idempotencyKey` (string ≤ 64).

Inspection (read live device state):

| Tool | Arguments | Returns (device `output`) |
| --- | --- | --- |
| `get_project_timeline` | `startIndex?`, `maxClips?` (≤100), `includeAudioClips?` | clip order + ranges, track overview, revision, duration, counts, `truncated` when paged |
| `list_project_assets` | `type?` | assets: id, type, label, duration, hasAudio |
| `get_clip_details` | `clipId` | asset, source range, project range, speed, original audio, effects, transition |
| `get_audio_track_details` | `trackId` | kind, volume, muted, clips with placement/fades/loop |
| `get_project_info` | — | projectId, revision, canvas, duration, counts, selected clip |
| `get_project_duration` | — | duration (project seconds) |

Video mutations: `append_video_clips` (`clips: [{assetId, sourceStart?, sourceEnd?}]`, ≤ 20),
`insert_video_clip` (`assetId`, `atIndex`, trims), `reorder_video_clips`
(`orderedClipIds` — every current clip exactly once), `split_video_clip`
(`clipId`, `atProjectTime`), `trim_video_clip` (`clipId`, `sourceStart`,
`sourceEnd` — source time), `remove_video_clip`, `duplicate_video_clip`,
`set_clip_speed` (`clipId`, `speed` 0.05–16), `set_clip_effect` (`clipId?`
omit = all clips, `effect {kind, …}`), `set_clip_original_audio` (`clipId`,
`enabled?`, `gain?` — that clip's camera audio only), `set_clip_transition`
(`clipId`, `kind` cut/cross_dissolve/fade_through_black, `duration`).

Audio mutations: `create_audio_track` (`label?`, `kind`
music/voiceover/effects/other — never replaces existing tracks),
`add_audio_clip` (`trackId?`, `assetId`, `timelineStart`, `sourceStart?`,
`sourceDuration?`, `gain?`, `loop?`, `repeatUntil?` — adds, never deletes a
soundtrack), `move_audio_clip`, `trim_audio_clip` (source range),
`remove_audio_clip`, `set_audio_clip_volume`, `set_audio_track_volume`,
`mute_audio_track`, `set_audio_clip_fade` (`fadeIn?`/`fadeOut?` seconds),
`loop_audio_clip`, `apply_audio_ducking` (`trackId`, `againstTrackIds?`,
`amount?` — detection on device; no fabricated speech timestamps).

Project: `set_project_canvas` (`width`, `height`).

Timeline view (what the user sees): `select_timeline_clip` (`clipId?` — a
video or audio clip ID, as if tapped; omit to clear both selections; a
revisioned mutation like a tap, so it is batchable) and `seek_playhead`
(`seconds`, project time, clamped to the duration). `seek_playhead` is view
state only: no revision change, no `expectedRevision`/`idempotencyKey`, never
batched; it returns `{ playheadSeconds, projectRevision }`.

Snapshot fields that let the agent resolve deictic requests: `selectedClipId`
("this clip"), `selectedAudioClipId` ("this audio"), `playheadSeconds`
("here", "at the playhead"). The model-facing summary always carries all
three, `null` when unknown.

Batch: `batch_timeline_edits` (`operations: [{type, arguments}]`, ≤ 20,
mutations only, no nesting). The device validates the whole batch first and
applies **all-or-nothing**; a failure result names the failing operation index
in `output.failedOperationIndex` and leaves the project unchanged.

## Result contract

Success (mutations): `{ ok: true, executedOn: "device", output: {
projectRevision, affectedClipIds?, createdClipId?/createdTrackId? (for
creators), duration?, videoClipCount?, audioTrackCount? } }`.

Failure: `{ ok: false, executedOn: "device", error: <code>, output?: {...} }`
with stable codes: `invalid_arguments`, `asset_not_found`, `clip_not_found`,
`audio_track_not_found`, `audio_clip_not_found`, `invalid_source_range`,
`invalid_timeline_position`, `project_revision_conflict` (with
`output.currentRevision`), `unsupported_on_device`,
`resource_limit_exceeded`, `cancelled` — plus the pre-existing
`skipped_by_user`. Never include filesystem paths or exception traces in
model-visible results.

Revision contract: the device increments the project revision on every
applied mutation (a batch = one increment). A mutation whose
`expectedRevision` ≠ the device's current revision is rejected with
`project_revision_conflict` and changes nothing. The agent then calls
`get_project_timeline` once and replans. `idempotencyKey` deduplicates a
retried mutation within a turn (a replayed continuation must not apply an
edit twice, and must never duplicate appended clips or soundtrack inserts).

## Native mapping (iOS multi-clip implementation)

Tools map onto `ProjectCommand` cases in
`ios/FinalCut/Timeline/ProjectCommand.swift`, executed through the same
command layer as manual timeline edits (shared undo/redo history):

| Tool | ProjectCommand |
| --- | --- |
| append/insert video | `appendVideoClip` |
| reorder | `reorderVideoClips` |
| split / trim / remove / duplicate | `splitVideoClip` / `trimVideoClip` / `removeVideoClip` / `duplicateVideoClip` |
| speed / original audio / effect / transition | `setVideoClipSpeed` / `setVideoClipOriginalAudio` / `applyClipEffect` / `setVideoClipTransition` (+ `setVideoClipFades` for clip audio fades) |
| audio track/clip tools | `createAudioTrack`, `insertAudioClip`, `moveAudioClip`, `trimAudioClip`, `removeAudioClip`, `setAudioClipVolume`, `setAudioClipMuted`, `setAudioTrackVolume`, `setAudioTrackMuted`, `setAudioFade`, `loopAudioClip`, `setAudioClipAutomation` |
| ducking | `setAudioClipAutomation` fed by on-device `AudioDucking` analysis |
| canvas | `setCanvas` |
| select_timeline_clip | `selectClip` |
| seek_playhead | none — `EditorViewModel.seekPlayhead(to:)` (same path as the ruler scrubber) |

The request snapshot is the native `ProjectSummary`
(`EditorProject.summary()`), sent as `media.project`; the server normalizes
its field names (`durationSeconds` → `duration`, `assetID` → `assetId`,
`gain` → `volume`, …). See `src/server/projectContext.js` for the canonical
shape and limits.

## Coordination status (2026-10-26)

Ownership split set by the user: this server contract is the single source of
truth for the timeline feature. The iOS multi-clip implementation builds its
Phase E dispatch against these tool names, argument shapes, error codes, and
the snapshot schema above, and does not edit anything under `src/server/`.
(The iOS worktree's earlier independent server cut — `TIMELINE_MIN_BUILD`,
`validateProjectSummary`, `get_timeline`/`create_audio_lane`-style names — was
superseded by this contract and dropped.)

Coordination resolved 2026-10-27: the iOS track's PR #124 implements THIS
camelCase contract on device (revision checks, idempotency, atomic batch),
and the gate is set to its build, 14 (app version 1.2).

## Remaining native dependencies (not server work)

1. Wire `ProjectSummary` into `ClientChat.swift` requests (send the snapshot
   with each client-execution POST, top-level `project` or `media.project`).
2. Implement the tool executor in the iOS tool dispatch: map each tool name
   to its `ProjectCommand`, validate against the live project (existence,
   ranges, revision), apply through the command layer, and return the result
   contract above — including `projectRevision` and affected IDs.
3. Track a project revision counter natively (increment per applied command,
   including undo/redo) and honor `expectedRevision` / `idempotencyKey`.
4. Ship in a build, then set `TIMELINE_TOOLS_MIN_BUILD` to that build number
   (one line in `iosToolAllowlist.js`) — until then the tools stay dark.
5. Optionally send `thumbnailRefs` so thumbnails are bound to asset/clip IDs.

## Tests

- `src/test/project-context.test.js` — snapshot validation, aliases, limits,
  truncation honesty, label-injection safety, thumbnail refs.
- `src/test/ios-timeline-tools.test.js` — schema validity, gating (no real
  build / min build / web / photo), argument + batch validation.
- `src/test/timeline-agent-e2e.test.js` — the §16 montage scenario, the
  follow-up reorder+mute, revision-conflict recovery, malformed-call
  handling, old-build behavior, "split this clip here" / "fade this audio"
  resolved from the snapshot's selection + playhead, and select + seek, all
  through the real endpoint with a scripted model and a fake device.
- `ios/FinalCutTests/ProjectCommandTests.swift` — summary reports both
  selections; `select_timeline_clip` / `seek_playhead` through the device
  executor (revision, clamping, invalid args, playhead in the request).
