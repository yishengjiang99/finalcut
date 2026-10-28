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
