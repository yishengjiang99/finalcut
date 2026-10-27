# Multi-clip timeline (FinalCap iOS, build 14+)

FinalCap edits used to be one video on an `EditStack`. Build 14 adds a first-class
multi-clip timeline: multiple video clips in sequence, independent overlapping audio
tracks, per-clip effects/speed, transitions, and AI tools that edit the same project
the user edits by hand. Everything stays on-device (AVFoundation + Core Image, no
FFmpeg in the app) and local-first: media is never uploaded for timeline work.

## Model (`ios/FinalCut/Timeline/`)

- `EditorProject` — assets, ordered video clips, audio tracks/clips, canvas, selection.
  Video-clip positions are **derived** from order + source ranges + speeds (never
  stored), so clips cannot overlap or drift; project duration is derived too.
  Non-cut transitions store an overlap that shortens the project; on the timeline the
  two clips genuinely overlap in composition tracks and are blended.
- Three time bases are kept distinct everywhere: **source time** (inside a file),
  **clip-local** (after trim/speed), **project time** (after layout). Captions are
  stored per clip in source time (plus project-time captions for migrated stacks) and
  mapped explicitly — `projectCaptions()` — so they survive trim/split/speed/reorder.
- `ProjectCommand` — the ONLY mutation path. The SwiftUI timeline and the AI tool
  executor both dispatch commands; each is validated against a copy and applied
  atomically (a bad command changes nothing and returns a stable error code).
- `ProjectHistory` — value-snapshot undo/redo of the project (no media copies),
  folded into `EditStack`'s existing undo so one Undo button covers both worlds.
- `ProjectStore` — durable storage:
  `Application Support/Projects/<id>/project.json` (atomic write) +
  `Media/<asset-id>.<ext>` (atomic copy, free-space check, SHA-256 duplicate
  detection). Nothing timeline-related lives in the temporary directory.

## Composition (`ProjectComposer` + `ProjectVideoCompositor`)

One `AVMutableComposition` per project drives BOTH preview (`AVPlayerItem`) and
export (`AVAssetExportSession`), so they cannot diverge:

- Video clips insert sequentially (source range, then per-track time scaling for
  speed). With transitions, neighbours alternate between two tracks so ranges
  overlap; `ProjectVideoCompositor` (custom `AVVideoCompositing`) blends the two
  source frames (cross-dissolve / fade-through-black at midpoint), normalises each
  clip's own orientation, runs that clip's Core Image effect chain, fits it into
  the project canvas (aspectFit default), and draws project-time captions last.
- Original audio rides its own composition track per clip — same range, same
  scaling — so it cannot drift and moves with the clip when reordered.
- Independent audio tracks are packed greedily onto composition tracks: overlapping
  clips coexist and mix. Gain is clip × track, applied exactly once in the
  `AVAudioMix`; fades and stored automation (ducking) are ramps on the same mix.
  Audio longer than the project is clamped to the project end. Looping inserts
  repeated passes. No intermediate files, no offline renders on the normal path.
- Ducking (`AudioDucking`): the phone decodes the dialogue (RMS in 100 ms windows)
  and stores gain automation points on the music clip — a normal, undoable edit.

Single-clip and photo sessions are untouched: they keep the original
`NativeComposer` path bit-for-bit. A project routes through the project composer
only when it has >1 video clip or any audio track. The old `youtube_soundtrack` op
migrates to a normal clip on a "Soundtrack" lane; in timeline mode new soundtracks
are inserted the same way.

## AI tools (server contract on main; executor ships in build 14)

30 tools are defined in `src/server/iosTimelineTools.js` **on main** (the server
track landed first), gated by `TIMELINE_TOOLS_MIN_BUILD` in `iosToolAllowlist.js`
— currently `2_000_000_000`, dark on every shipped build, to be flipped to 14 when
this branch's executor ships in build 14. The client sends a bounded
`media.project` summary (IDs, order, ranges, gains, `revision` — no media, no
paths); the server validates it (`projectContext.js`) and renders it into the
model context. This branch's executor (`Timeline/TimelineToolExecutor.swift`)
implements the landed contract in full: camelCase arguments, the persisted
project `revision` (one increment per command, per batch, or undo/redo),
`expectedRevision` → `project_revision_conflict` with nothing applied,
`idempotencyKey` replay, `batch_timeline_edits` (all-or-nothing), the
`apply_audio_ducking` track semantics (dialogue = video-clip original audio +
`againstTrackIds` tracks, voiceover tracks by default), and the contract result
shape (`projectRevision`, affected/created IDs, fresh summary). Legacy
single-clip tools used on a project are translated: frame/colour tools hit the
selected clip, `resize_video` sets the canvas, trim/speed translate only when
the project has exactly one clip (otherwise the model uses the clip tools).

## Known limits

- One sequential video track (no picture-in-picture / overlay video track yet).
- Transitions: cut, cross-dissolve, fade-through-black. Overlap is clamped to
  half of each neighbour.
- `AVAudioMix` clamps gain at 1.0 (same as the legacy composer); gains >1 are
  stored and honoured in data, capped in the mix.
- Server/cloud editing of a project is not supported; timeline projects are
  on-device only (the chat tools all execute on device).
