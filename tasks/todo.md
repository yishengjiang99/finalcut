# Task Tracker

## Active Tasks

<!-- Add tasks here using the format below -->
<!-- - [ ] Task description -->

### Export quality: stop avoidable generation loss (2026-11-25)

Measured (10 s 1080p, Y-PSNR vs source): web edit at x264 veryfast/crf 23 = 38–40 dB per
edit, compounding to ~35 dB after 5 edits (each edit re-encodes the last output). veryfast/crf 18
= +3–4 dB per edit at ~same speed. iOS H.264 HighestQuality tone-maps HLG HDR to 8-bit SDR;
the HEVC preset over the same CI composition keeps 10-bit HLG/BT.2020 (verified with avfoundation on macOS).

Web (ffmpeg.wasm)
- [x] One shared `X264` constant (veryfast, crf 18, yuv420p) in ops/encode.js; process.js, multi.js, trim.js import it
- [x] concat/transitions: output at the highest clip fps (cap 60, fallback 30) instead of fixed 30
- [x] Burned-WebM recorder: bitrate scaled to the canvas instead of the browser's ~2.5 Mbps default
Server (fallback + iOS cloud steps)
- [x] `-crf 18` for the 14 filter ops that re-encode at the libx264 default (both switch copies), burn_subtitles, transitions
iOS
- [x] NativeExporter: HEVC HighestQuality when a source video track is HEVC (keeps HDR/10-bit); H.264 otherwise
- [x] ProjectVideoCompositor (transitions): HDR + wide-color source frames, 10-bit buffers
- [x] Timeline projects: lossless passthrough when the project is one untouched, trimmed clip
Verify
- [x] vitest 1297 + 6 new pass; ExportTests + ProjectComposerTests 17/17 (incl. 3 new); web argv run through native ffmpeg (60 fps join kept, crf 18)
- Review: full iOS suite has 4 failures that reproduce identically on 8289a2a without these changes
  (PhotoModeTests.testCaptionsOnPhotoAreNoLongerRefused crashes the host: "freed pointer was not the last
  allocation"; NativeToolTests soundtrack x2; TopBarLayoutTests SE width). Not caused by this change.
  Web HDR/10-bit sources still become 8-bit H.264 (x265 10-bit is single-threaded in wasm).

### Timeline view → agent tools (2026-10-27)

Tools array: `IOS_TIMELINE_TOOLS` in src/server/iosTimelineTools.js; device side
`TimelineTools.names` + `commandFor` in ios/FinalCut/Timeline/TimelineToolExecutor.swift.

Gaps (TimelineView actions with no tool), plus snapshot fixes so the agent can see them:
- [x] Tests first: ios-timeline-tools, project-context, timeline-agent-e2e, ProjectCommandTests.swift
- [x] Snapshot: `selectedAudioClipId` + `playheadSeconds` (ProjectSummary → projectContext.js)
- [x] `select_timeline_clip` → `ProjectCommand.selectClip` (video or audio clip; omitted clears)
- [x] `seek_playhead` → `EditorViewModel.seekPlayhead(to:)`; TimelineView playhead follows the model
- [x] Wired: tools array, allowlist, Swift names/executor/ToolCatalog, docs/api/IOS_TIMELINE_TOOLS.md
- [ ] Verify: npm test (done), iOS ProjectCommandTests/UndoRedo/EditRouting (running)
- Skipped: `set_timeline_view` (zoom / show-hide) — little agent value

Deliberately not exposed: Photos/Files import (needs the user's picker), New project
(clears the session), Save project (autosaved after every mutation).

## Completed Tasks

<!-- - [x] Task description -->

## Review

<!-- Add review notes here after completing tasks -->

## Web `concat_videos` (2026-10-27)
- [x] Engine: `buildConcatArgs` (ops/multi.js) + `concatClips` (ffmpegEngine.js), hard-cut join with the transition normalization
- [x] Web-only tool `concat_videos` in v2.js (not tools.js: no schema bump, iOS unaffected) + guidance
- [x] Client sends `clips` [{id,label}] (clientTurn.js); server validates (`validateClips`) and adds a context line for the web profile only
- [x] App.jsx `project.listClips/loadClips` via a ref so clips added mid-turn count
- [x] Tests: concat.test.js; v2-api web tool list; full `vitest --run` passes (1171)
- Review: v2-api's tool count was already stale (48 vs 49 at HEAD); corrected to 49. Not yet exercised in a real browser with ffmpeg.wasm.
