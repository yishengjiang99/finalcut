# FinalCap iOS — On-device editing UX handoff

**Audience:** FinalCut iOS (NativeToolExecutor + edit stack), FinalCut Backend (client-execution mode)
**Replaces:** the v1 rule that every chat edit uploads and waits on a server job.
**Promise to the user:** your video and photos never leave your iPhone. Nothing uploads unless the user turns on Cloud processing in Settings, and that setting is off by default.

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
| `unavailable` | Tool has no native version and Cloud processing is off (tool result `ok:false`, `unsupported_on_device`) | Muted card: "Not available on iPhone yet". No Retry. The model follows with one line of text saying so |
| `cloud` | Cloud processing is on and this step runs on the server | Inline progress (section 5) and "Cloud" badge |
| `failed` | Executor error | Error line + Retry |

Several tool calls in one turn render as a stack of cards in call order. The assistant's final text arrives after the cards settle.

Because the server leaves tools iOS can't run out of the model's tool list (based on the `FinalCap-iOS/<build>` User-Agent), `unavailable` should be rare. Design it quiet, not alarming.

## 2. Progress

**Edits never block the screen.** They change the composition, not the file, so there is no full-screen dimmer. The inline card spinner is enough, and the composer stays usable. Most edits should settle in well under a second.

If a device edit takes longer than about 1.5 seconds (for example a heavy Core Image pass building its first frame), show a thin indeterminate bar along the bottom edge of the preview. Do not dim the preview.

**Captions** run on-device speech recognition and can take a while on long clips. Show them as an edit card with determinate progress when available: "Transcribing on your iPhone… 40%". The composer stays usable.

Export is the only step with a progress sheet (section 4).

## 3. Preview before export

- The preview always plays the **current edit stack live** (AVVideoComposition / AVAudioMix). Nothing is rendered to a file until Export.
- A small "Preview" label sits at the top-left of the player while unrendered edits exist.
- **Edits strip:** a row under the timeline stub reading "Edits (3)". Tapping it opens a sheet listing the stack in order, each with a toggle (on or off) and delete. Turning an edit off updates the preview live.
- **Compare:** press and hold the preview to show the original clip; release to return to the edited version. Label while holding: "Original".
- **Undo:** the Undo link on the newest card removes that edit. Undo on an older card removes just that edit if the stack allows it; otherwise it removes it and everything after it, and says so ("Also removes 2 later edits").

**Sample chips (video, build 10):** every chip must map to something that runs on the device, either one of the 20 allowlisted tools or on-device captions. Use: "Generate captions", "Red filter", "Speed up 2×", "Add a title", "Fade out audio". Drop "Trim silence" (no native silence detection yet) and "Burn in" unless burn-in is done natively. "Translate to Spanish" can come back once translation runs on the device or sends text only. When the tool list grows, update the chips with it.

## 4. Export, background, and notification

1. Tap Export, pick a destination in `ExportSheet` (Save to Photos / Share / Save to Files).
2. A progress sheet shows **determinate** progress: "Rendering on your iPhone… 42%", a Cancel button, and the line "You can leave the app. We'll let you know when it's ready."
3. **First export only:** the sheet also shows a "Notify me when it's done" button. Tapping it triggers the system notification permission prompt. Don't ask for notification permission at launch or before the first export. If the user never taps it, don't ask again automatically; the option stays in Settings.
4. **Leaving the app:**
   - iOS 26 and later: the export continues as a system background task, and the system shows its own progress. No extra app UI needed.
   - iOS 17 to 25: the app gets a short window. If the export isn't done, it pauses. When the user comes back, the progress sheet reopens with "Resuming export…" and continues from where it stopped. Don't restart from 0% silently.
5. **When it finishes in the background,** post a local notification:
   - Title: "Your video is ready"
   - Body: "Saved to Photos. Tap to open FinalCap." (or "Ready to share." for the Share destination; tapping opens the share sheet)
   - Photos: "Your photo is ready". Photo exports are usually instant, so this should rarely fire.
6. **When it finishes in the foreground:** no notification. Show the "Saved to Photos" toast (or open the share sheet).
7. On cancel: return to the editor with the stack untouched.
8. If the export fails in the background, notify: "Export didn't finish. Open FinalCap to try again."

## 5. Cloud processing (opt-in setting, off by default)

**Setting:** Settings has a toggle labelled "Cloud processing", off by default, with the footnote: "Lets FinalCap upload a clip to our servers for edits your iPhone can't do yet. Off means nothing is ever uploaded."

**With the setting off (default):** tools without a native version produce the `unavailable` card. No upload prompt appears in chat, because the user hasn't opted in and we shouldn't nudge them toward uploading on every edit.

**With the setting on:**
- A step that needs the server shows a `cloud` card with staged progress: "Uploading… 30%", then "Processing in cloud…", then "Downloading result…". It does not block the screen.
- After it finishes, the card shows a "Cloud" badge instead of "On device" (tool result `executedOn: "server"`).
- **Flattening:** a cloud step needs a real file, so earlier device edits are rendered into the upload, and the downloaded result becomes the new base clip. The Edits sheet shows a divider: "Earlier edits were baked in by a cloud step." Edits before the divider can't be toggled individually. Undoing the cloud step restores the old base clip and all its edits (iOS keeps them in history). Edits after the cloud step keep stacking on the device.

## 6. Privacy copy

The model receives the user's text, clip metadata, and (when a vision model is configured) up to 4 still frames. It never receives the video.

- First-run line under the composer (once): "Your video stays on your iPhone. FinalCap sends your request and a few still frames to the AI so it understands your clip."
- Export success footnote when no cloud step was used: "Rendered on your iPhone."

**ASC:** `docs/asc/PRIVACY_NUTRITION.md` and `public/legal/privacy.html` need to cover the still frames and metadata, plus full-video uploads only when Cloud processing is turned on (FinalCut iOS owns that update).

## 7. Header (editor top bar)

The top bar is a **single row, about 44 pt tall**, with everything vertically centered. From left to right: "FinalCap" title, Import, Export, free-edit count, Upgrade.

- **Upgrade never wraps.** It's a compact capsule, 32 to 36 pt tall, with the crown and "Upgrade" on one line in `.subheadline` semibold. It has the highest layout priority in the row.
- **The free-edit count gives way first.** When space is tight it shortens from "0 free left" to "0 left". If the row is still too narrow, the count moves to a small line directly under the header instead of squeezing Upgrade.
- If it's still too narrow after that (large Dynamic Type), the "FinalCap" title truncates before Import or Export.
- Verify at 375 pt wide (iPhone SE) and at Dynamic Type sizes up to XL.

**While edits are unlimited** (server returns `unlimited: true`):
- Hide the free-edit count entirely. The row is title, Import, Export, Upgrade.
- Never open the paywall automatically. Upgrade still opens it when tapped.
- The paywall must not sell "Unlimited AI edits" while edits are already unlimited. That's misleading to users and a likely App Review problem. Swap the subhead to: "Editing is free while FinalCap is new. Subscribe to support it and keep unlimited edits when free limits return." Restore the original subhead when `unlimited` is false.


## 7a. Dictation (mic button in the composer)

Speech is recognized on the device only. Audio is never uploaded.

- **Placement:** a mic icon inside the prompt field, trailing edge. When the field has typed text, the mic is replaced by the Send button; clearing the text brings the mic back.
- **First tap:** request microphone and speech recognition permission (system prompts). If either is denied, show a one-line inline note under the field: "Turn on Microphone and Speech Recognition for FinalCap in Settings." with a Settings link.
- **Listening:** the mic becomes a red stop button with a soft pulsing ring, the placeholder reads "Listening…", and partial text appears live in the field. A light haptic plays when listening starts and stops. If the keyboard is up, dismiss it.
- **Sending:** a prompt sends on its own with no confirm step: 0.4 s after a sentence ending in `.`, `?` or `!`, after 1.0 s of silence otherwise, or at once when the recognizer marks the result final. Trailing punctuation is removed before sending. An empty transcript is never sent.
- **Continuous listening:** after a send, the field clears, the placeholder goes back to "Listening…", and the next thing the user says becomes the next prompt. Tapping stop ends dictation and sends anything already recognized.
- **Queued prompts:** if an edit is still running, the new prompt appears right away as a user bubble with a small "Queued" label, and the label disappears when it starts.
- **Auto-stop:** if nobody speaks for 30 seconds, stop listening and return the mic to idle, so the microphone isn't left on by accident.
- **Editing before send:** if the user taps into the field while listening, stop listening and keep the text in the field unsent so they can fix it.
- **Unavailable:** if the device or language can't do on-device recognition, show the mic dimmed; tapping it shows "Dictation isn't available on this device." There is no server fallback.

Info.plist copy:
- `NSMicrophoneUsageDescription`: "FinalCap uses the microphone so you can speak your edit requests."
- `NSSpeechRecognitionUsageDescription`: "FinalCap turns your speech into text on your iPhone. Your voice isn't uploaded."

## 8. Photo mode

When the imported asset is a photo (`mediaType: "image"`), everything runs on the device through Core Image. Nothing uploads.

- Hide the timeline stub and the playback controls. The photo is shown aspect-fit in the preview area.
- Sample chips switch to photo-safe tools: "Make it warm" (`apply_color_filter`), "Black and white" (`apply_color_filter` grayscale), "More contrast" (`adjust_contrast`).
- Compare (press and hold to see the original) and the Edits strip work the same as for video.
- The Export sheet title is "Save photo". Save to Photos in the original format. There is no render percentage; show a short spinner.
- If the model calls a video-only tool on a photo (trim, audio, captions, speed), show a failed card that says "That works on videos, not photos." with no Retry. The on-device tool list for photos should make this rare.

## 9. Server error codes (Cloud processing on only)

These apply only when a step actually goes to the server. Map the `code` field to UI and never show the raw `error` text.

| `code` | Where it shows | Copy key | UI |
|---|---|---|---|
| `unsupported_for_photo` | Edit card | `edit.failed.photoUnsupported` | Failed card, no Retry |
| `invalid_arguments` | Edit card | `edit.failed.invalidArgs` | Return the error to the model first so it can correct the call; show the card only if the model gives up |
| `unsupported_image_format` | Edit card | `edit.failed.generic` | Should be unreachable, since HEIC is converted on the device before any upload |
| anything else / no code | Edit card | `edit.failed.generic` | Failed card with Retry |

## 10. Copy strings

| Key | String |
|---|---|
| `edit.applying` | Applying {tool}… |
| `edit.onDevice` | On device |
| `edit.cloud` | Cloud |
| `edit.undo` | Undo |
| `edit.unavailable` | Not available on iPhone yet |
| `edit.failed.device` | Couldn't apply this on your iPhone. |
| `edit.failed.photoUnsupported` | That works on videos, not photos. |
| `edit.failed.invalidArgs` | Couldn't apply that edit. Try saying it another way. |
| `edit.failed.generic` | Something went wrong with that edit. |
| `captions.transcribing` | Transcribing on your iPhone… {pct}% |
| `cloud.setting.title` | Cloud processing |
| `cloud.setting.footnote` | Lets FinalCap upload a clip to our servers for edits your iPhone can't do yet. Off means nothing is ever uploaded. |
| `cloud.uploading` | Uploading… {pct}% |
| `cloud.processing` | Processing in cloud… |
| `cloud.downloading` | Downloading result… |
| `cloud.flattened` | Earlier edits were baked in by a cloud step. |
| `export.rendering` | Rendering on your iPhone… {pct}% |
| `export.leaveHint` | You can leave the app. We'll let you know when it's ready. |
| `export.notifyMe` | Notify me when it's done |
| `export.resuming` | Resuming export… |
| `export.rendered.local` | Rendered on your iPhone. |
| `export.photo.title` | Save photo |
| `notif.video.title` | Your video is ready |
| `notif.video.body.photos` | Saved to Photos. Tap to open FinalCap. |
| `notif.video.body.share` | Ready to share. |
| `notif.photo.title` | Your photo is ready |
| `notif.failed.title` | Export didn't finish |
| `notif.failed.body` | Open FinalCap to try again. |
| `preview.label` | Preview |
| `preview.original` | Original |
| `header.freeLeft.long` | {n} free left |
| `header.freeLeft.short` | {n} left |
| `header.upgrade` | Upgrade |
| `dictation.listening` | Listening… |
| `dictation.unavailable` | Dictation isn't available on this device. |
| `dictation.permissionDenied` | Turn on Microphone and Speech Recognition for FinalCap in Settings. |
| `paywall.subhead.unlimitedPeriod` | Editing is free while FinalCap is new. Subscribe to support it and keep unlimited edits when free limits return. |
| `dictation.queued` | Queued |
| `privacy.firstRun` | Your video stays on your iPhone. FinalCap sends your request and a few still frames to the AI so it understands your clip. |

## 11. Out of scope for this slice

Multi-track timeline, keyframe UI, per-edit parameter sliders (the chat is still the way to adjust; "make it less bright" produces a new edit or replaces the last one of the same type).

*Owner: FinalCut Design. Coordinate in the FinalCut channel.*
