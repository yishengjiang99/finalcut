# FinalCap — Lightweight Release: Looks, Caption Styles, Before/After, Frame Export, Edit-History Tool

Status: validated proposal prompt. Uploaded as a document only at the owner's direction on 2026-10-26; not dispatched to any implementation chat. When picked up, implement exactly this scope — anything beyond it needs a new decision.

## Role and objective

You are a senior iOS engineer (Swift, SwiftUI, AVFoundation, Core Image) working in the FinalCap repo (`yishengjiang99/finalcut`). FinalCap is a chat-first, local-first AI video editor: the user describes an edit, the server planner (Grok tool-calling) emits client tools, and the iOS app executes them on-device against an `EditStack` of native operations. No media is uploaded for editing; all rendering is on-device.

Objective: ship five independently useful features that reuse the existing single-video pipeline and do NOT depend on the multi-clip timeline work:

1. One-tap cinematic looks + reusable style recipes
2. Caption style presets (+ manual caption text correction)
3. Before/after comparison
4. Frame (cover / thumbnail) export
5. AI edit-history inspector (read-only tool)

## Verified starting points (checked against main on 2026-10-26, commit fd741d6)

- `ios/FinalCut/NativeEditing/FrameRenderer.swift` — renders the op stack per frame (`apply(to:time:)`); supports `.colorControls` (CIColorControls brightness / contrast / saturation), `.hue`, and `.colorFilter` via `matrix(for:intensity:)` + `applyColorFilter`. `renderText(_:fontSize:color:)` and `renderCaption(_:canvas:)` exist.
- `ios/FinalCut/NativeEditing/Captions.swift` — `CaptionCue { start, end, text }` only; there are NO style fields today. `FrameRenderer.renderCaption` is fixed-style: semibold system font, white, centered, black 60%-alpha rounded background, metrics derived from canvas size. Caption styling is genuinely new, additive work.
- `ios/FinalCut/NativeEditing/NativeComposer.swift` — the composed result exposes `makeImageGenerator(maxSize:)` returning an `AVAssetImageGenerator` over the composition and its `audioMix`. Frame export needs UI + saving, not new rendering.
- `ios/FinalCut/NativeEditing/EditStack.swift` — `EditStack.entries: [EditEntry]`; `EditEntry { id, tool, op, toolCallId, executedOn }`. Snapshots are Codable and persisted; ops are plain values. History inspection and recipe serialization need no new storage machinery.
- `ios/FinalCut/NativeEditing/NativeOp.swift` — existing ops include trim, speed, crop, rotate, flips, resize, pad, colorControls, hue, colorFilter, `text(x, y, fontSize, color)` — note: text has NO timing fields — volume, audio fade, outputFormat, captions. `NativeToolParser` maps tool names to ops and already supports a `NativePlan.query` path (e.g. `get_video_dimensions`, `get_supported_formats`); the edit-history tool follows that exact pattern.
- A `resize_video_preset` tool already exists (pad to preset canvas sizes). Do not rebuild social sizing; at most surface it in the export sheet.
- Server side: `src/server/iosToolAllowlist.js`, `src/server/toolsSchema.js`, `src/server/clientExecution.js` own the client-tool surface. The ONLY server change in this scope is registering the one read-only history query tool — and first check `src/server/iosTimelineTools.js` and `docs/api/` in case the landed agentic-orchestration contract already exposes the edit stack; prefer reuse over a new registration.

## Feature specs

### 1. One-tap looks + reusable recipes

- Define named looks as parameter bundles over existing ops: at minimum Cinematic, Vintage, Vibrant, Soft Portrait, plus the existing named color filters. Each look is an ordered list of (colorControls, hue, colorFilter) values plus an intensity scalar (0...1) that interpolates the bundle toward neutral.
- New client tool `apply_look { name, intensity? }`: it resolves to the underlying ops and pushes them onto the EditStack as normal entries, so undo, redo, history, and export all work unchanged. Add a Looks row in the editor UI (preset chips + intensity slider) that goes through the same code path as the tool — one implementation, two entry points.
- Recipes: "Save current style" captures the stack's look-relevant ops (colorControls, hue, colorFilter, text, caption style) as a named Codable recipe, persisted on-device alongside the edit-stack snapshots. Tool `apply_recipe { name }` plus a recipe list in the same UI row. Applying a recipe to a different video validates and clamps ops against the target canvas the way `NativeToolParser` validates today.

### 2. Caption style presets

- Introduce `CaptionStyle`: preset id, font weight / size scale, text color, outline (stroke width + color) or none, background (color + opacity, including fully transparent), position (top / center / bottom). Ship presets: Bold Social, Minimal, Outlined, Classic. Classic is today's exact rendering and the default, so existing projects render identically.
- Parameterize `FrameRenderer.renderCaption` with the style; the current hard-coded values become the Classic definition. Style is project-level state stored with the edit-stack snapshot (Codable; snapshots saved before this change must decode with Classic as the default — a decode failure on old projects is a release blocker).
- Tool `set_caption_style { preset, position?, background_opacity? }` plus a style picker in the captions UI.
- Manual correction: in the captions editor, tapping a cue lets the user edit its text (`CaptionCue.text` is mutable); edits re-render through the same burn-in path and are recorded as a stack entry so undo works.

### 3. Before/after comparison

- In the preview pane, a Compare control: press-and-hold (and a toggle) swaps the player item between the composed edit and the original asset at the SAME playback time, preserving play/pause state. No renderer or composer changes — build both player items from the existing composition path and the untouched source asset.
- Label the states unambiguously while comparing ("Original" / "Edited"). Photo mode may share the toggle if it falls out naturally; if not, ship video-only and say so in the delivery summary.

### 4. Frame export

- From the preview, a "Save frame" action / sheet: scrub (reuse preview seeking) to the target time, grab the frame via the composed result's `makeImageGenerator` at native resolution, optionally overlay text via the existing `renderText`, export JPEG or PNG, save to Photos and offer the share sheet — reuse `PhotoLibrarySaver` and the ExportSheet patterns.
- The export uses the COMPOSED (edited) frame, not the raw source, and the UI says so ("exports the edited frame"). This is the cover/thumbnail path for YouTube and social posts.

### 5. AI edit-history inspector

- Read-only query tool `get_edit_history` following the `NativePlan.query` pattern: returns the ordered EditStack entries as human-readable summaries (tool name + plain-language op summary + executedOn), plus counts. It must not mutate state, and it must work for photo stacks too.
- Register it in the server allowlist + schema (the only server edit in this scope; see the reuse note above) with the same build-gating discipline as neighboring query tools. The planner answers "What have you changed so far?" from this tool's output — the real stack, never from chat memory.
- Summaries are generated from the op values (e.g. "Trimmed to 0:04-0:11", "Applied Cinematic look at 80%"), not free text the model invents.

## Constraints

- Local-first: no new server media processing, no uploads, no new network calls beyond the one tool registration. Everything renders on-device.
- Do not disturb the multi-clip timeline work or the agentic orchestration contract (`docs/api/`, `iosTimelineTools.js`): this release targets the existing single-video pipeline. If the timeline work has landed by the time you start, build on top of it and keep these features working in single-video projects; do not fork the op model.
- Backward compatibility: existing saved projects and snapshots decode unchanged; the default caption style renders identically to today.
- Every new tool validates arguments in `NativeToolParser` with the existing error-code discipline (the `ServerErrorCode` mapping) and is covered in `FinalCutTests` alongside `NativeToolTests` / `NativeToolParserTests`.
- Repo working agreements: small, frequent, verified commits pushed directly to main via the tree-verified gh-push flow (never force-push); on a CI failure, report the first failure (workflow, run id, failing step) and stop — no polling loops, no autonomous repair cycles.

## Out of scope (deliberately postponed)

Scene detection, face tracking, stabilization, reverse video, animated picture-in-picture, speed ramping, auto-montage. Timed titles / lower thirds beyond what caption styling provides (the text op has no timing fields; that is a separate op-model change). A soundtrack mixing UI (volume and audio-fade ops and the AVAudioMix path already exist; surfacing them is not part of this prompt).

## Acceptance

- Each feature works end-to-end in the single-video flow: the chat tool path AND its UI entry point, undo/redo intact, and exports reflect the change.
- Tests: parser tests for `apply_look`, `apply_recipe`, `set_caption_style`, `get_edit_history`; a golden-value test that Classic caption rendering matches the pre-change metrics; a snapshot-decode test using a pre-change saved project.
- The delivery summary lists, per feature: files touched, tool names added, anything deferred — with the commit SHAs on main.

## Estimates (validated 2026-10-26, one experienced engineer)

Looks + recipes 2-3 days · Caption styles + correction 2-4 days · Before/after 1-2 days · Frame export 1-2 days · Edit-history tool 1-2 days. Each feature ships independently, in the order above.
