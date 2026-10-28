# Task Tracker

## Active Tasks

<!-- Add tasks here using the format below -->
<!-- - [ ] Task description -->

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
