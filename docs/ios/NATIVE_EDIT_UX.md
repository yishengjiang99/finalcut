# FinalCap iOS — On-device editing UX handoff

**Audience:** FinalCut iOS (NativeToolExecutor + edit stack), FinalCut Backend (client-execution mode)
**Replaces:** the v1 rule that every chat edit uploads and waits on a server job.
**Promise to the user:** your video stays on your iPhone unless you choose cloud processing for one step.

---

## 1. How edits look in chat

Each tool call from the model becomes an **edit card** in the chat, attached under the assistant message that requested it.

```
┌──────────────────────────────────────┐
│ ✂︎  Trim · 0:05–0:15          ✓ On device │
│     Undo                                  │
└──────────────────────────────────────┘
```

| Card state | When | UI |
|---|---|---|
| `applying` | Executor is building the composition | Small inline spinner, copy "Applying trim…" |
| `applied` | Composition updated | Check mark, "On device" badge, Undo link |
| `needsCloud` | Tool has no native version | Cloud prompt (section 4) |
| `cloud` | Step is running on the server | Inline progress (section 4) |
| `failed` | Executor or server error | Error line + Retry (and "Try in cloud" if the server supports that tool) |

Several tool calls in one turn render as a stack of cards in call order. The assistant's final text arrives after the cards settle.

## 2. Progress

**Device edits do not block the screen.** They change the composition, not the file, so there is no full-screen dimmer for them. The inline card spinner is enough, and the composer stays usable.

**Only two things get the blocking dimmer:**
- Export rendering (section 3)
- Cloud fallback steps (section 4)

If a device edit takes longer than about 1.5 seconds (for example a heavy Core Image pass building its first frame), show a thin indeterminate bar along the bottom edge of the preview. Do not dim the preview.

## 3. Preview before export

- The preview always plays the **current edit stack live** (AVVideoComposition / AVAudioMix). Nothing is rendered to a file until Export.
- A small "Preview" label sits at the top-left of the player while unrendered edits exist.
- **Edits strip:** a row under the timeline stub reading "Edits (3)". Tapping it opens a sheet listing the stack in order, each with a toggle (on or off) and delete. Turning an edit off updates the preview live.
- **Compare:** press and hold the preview to show the original clip; release to return to the edited version. Label while holding: "Original".
- **Undo:** the Undo link on the newest card removes that edit. Undo on an older card removes just that edit if the stack allows it; otherwise it removes it and everything after it, and says so ("Also removes 2 later edits").

**Export:**
1. Tap Export, pick a destination in `ExportSheet` (Save to Photos / Share / Save to Files).
2. Blocking dimmer with **determinate** progress from the export session: "Rendering on your iPhone… 42%" plus a Cancel button.
3. On success: "Saved to Photos" toast (or the share sheet opens).
4. On cancel: return to the editor with the stack untouched.

## 4. Cloud fallback (tool not available on device)

Falling back means uploading the clip, which breaks the default promise, so it is **always visible and always the user's choice**.

**First fallback in a project** shows a prompt card in chat:

> **This step needs cloud processing**
> Reverse audio isn't available on your iPhone yet. FinalCap can upload this clip (48 MB), process it, and bring the result back.
> [Process in cloud]  [Skip this step]
> ☐ Don't ask again for this project

- "Skip this step" marks the card skipped and lets the model continue (send a `role: "tool"` result with `ok: false, error: "skipped_by_user"`).
- With "Don't ask again" checked, later fallbacks in the same project start without the prompt but still show the cloud badge.

**While running,** use the existing processing dimmer with staged copy:
"Uploading… 30%", then "Processing in cloud…", then "Downloading result…".

**After it finishes,** the card shows a **"☁ Cloud" badge** instead of "On device". This maps directly to `executedOn: "server"` in the tool result.

**Flattening (engineering implication, please confirm):** a cloud step needs a real file, so all earlier device edits get rendered into that upload. The downloaded result becomes the new base clip. Show a divider in the Edits sheet: "Earlier edits were baked in by a cloud step". Edits before the divider can no longer be toggled individually; undoing the cloud step restores the pre-cloud stack.

## 5. Privacy copy

The model receives clip metadata and up to 4 still frames, never the video. Say that plainly:

- First-run line under the composer (once): "Your video stays on your iPhone. FinalCap sends a few still frames to the AI so it understands your clip."
- Export success footnote when no cloud step was used: "Rendered on your iPhone."

**Flag for ASC:** thumbnails going to the server should be reflected in `docs/asc/PRIVACY_NUTRITION.md` (user content, used for app functionality, not linked to identity if that's true). Cloud fallback uploads the full video, so that also needs to be disclosed.

## 6. Copy strings

| Key | String |
|---|---|
| `edit.applying` | Applying {tool}… |
| `edit.onDevice` | On device |
| `edit.cloud` | Cloud |
| `edit.undo` | Undo |
| `edit.failed.device` | Couldn't apply this on your iPhone. |
| `edit.tryCloud` | Try in cloud |
| `cloud.prompt.title` | This step needs cloud processing |
| `cloud.prompt.body` | {tool} isn't available on your iPhone yet. FinalCap can upload this clip ({size}), process it, and bring the result back. |
| `cloud.uploading` | Uploading… {pct}% |
| `cloud.processing` | Processing in cloud… |
| `cloud.downloading` | Downloading result… |
| `export.rendering` | Rendering on your iPhone… {pct}% |
| `export.rendered.local` | Rendered on your iPhone. |
| `preview.label` | Preview |
| `preview.original` | Original |
| `edit.failed.photoUnsupported` | That works on videos, not photos. |
| `export.photo.title` | Save photo |
| `privacy.firstRun` | Your video stays on your iPhone. FinalCap sends a few still frames to the AI so it understands your clip. |

## 7. Photo mode (added after #82)

When the imported asset is a photo (`mediaType: "image"`):

- Hide the timeline stub and the playback controls. The photo is shown aspect-fit in the preview area.
- Sample chips switch to photo-safe tools: "Make it warm" (`apply_color_filter`), "Black and white" (`apply_color_filter` grayscale), "More contrast" (`adjust_contrast`).
- Compare (press and hold to see the original) and the Edits strip work the same as for video.
- The Export sheet title is "Save photo". Save to Photos in the original format (JPEG or PNG per `contentType`). There is no render percentage; show a short spinner.
- If a tool that doesn't apply to photos comes back as a 400 (trim, audio, captions, speed), show a failed edit card with the copy `edit.failed.photoUnsupported`: "That works on videos, not photos." Never show the raw server error.

## 8. Out of scope for this slice

Multi-track timeline, keyframe UI, per-edit parameter sliders (the chat is still the way to adjust; "make it less bright" produces a new edit or replaces the last one of the same type).

*Owner: FinalCut Design. Coordinate in the FinalCut channel.*
