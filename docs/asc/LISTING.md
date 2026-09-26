# FinalCap App Store listing (en-US)

**Source of truth for upload:** `docs/asc/listing.en-US.json`. The upload script `.github/scripts/upload_finalcap_asc.py` reads that file, so edit the JSON and this doc together.
**Upload:** run the "ASC FinalCap upload listing" workflow. By default it uploads text only. Set `screenshots: true` to also replace the screenshots from `docs/asc/screenshots/`. The workflow never submits for review.
**App Name:** `FinalCap - AI Video Editor` · **Apple ID:** `6815060815` · **Bundle ID:** `com.ragnus.w2` · **SKU:** `finalcap-ai`
**Primary category:** Photo & Video

## Rules

- Claim only features in a shipped TestFlight build. Right now that's build 11 (current `main`), where edits run on grepawk.com.
- Lines marked **pending build 12** go live only once the native build is on TestFlight. Then swap them in and re-run the upload.
- Say "your video stays on your iPhone" (true from build 12). Never say "private", "offline" or "nothing leaves your phone". Chat messages and short edit results go through grepawk.com to the AI model.
- No competitor or platform brand names, no "Grok", no "Final Cut", no Apple product names in the name, subtitle or keywords.
- Don't claim translate or burn-in captions. Build 12's on-device captions don't do either.
- Don't repeat words from the name or subtitle in keywords. Apple already indexes them.

## Name (26/30)

`FinalCap - AI Video Editor`

## Subtitle (28/30)

`Edit videos just by chatting`

## Keywords (96/100)

`captions,subtitles,trim,cut,crop,clip,text,title,filter,color,speed,slow motion,reels,vlog,maker`

## Promotional text (156/170, editable without a new submission)

Live now:
> Describe the edit you want and FinalCap makes it. Trim, add titles, change the speed, apply color looks and generate captions, then save the clip to Photos.

**Pending build 12** (153/170):
> Your video stays on your iPhone. Describe the edit you want and see it right away: trims, titles, color looks, captions and more. Then save it to Photos.

## Description (live now)

```
FinalCap lets you edit a video by describing what you want. Type "cut the first three seconds", "add a title that says Day One" or "make it warmer", and FinalCap makes the edit and shows it in the preview.

EDIT BY CHATTING
• Trim, crop, rotate and flip
• Add text titles
• Speed clips up or slow them down
• Apply color looks, or adjust brightness, contrast and saturation
• Fade the audio in or out, or change the volume
• Generate captions from speech

PREVIEW, THEN SAVE
• Import a clip from Photos
• Check each change in the preview before you save
• Save the finished video to Photos or share it

Chat requests are handled by FinalCap's AI service. See the privacy policy for details.
```

### Pending build 12 changes to the description

- Replace the first paragraph with:
  > FinalCap lets you edit a video by describing what you want, and your video stays on your iPhone. Type "cut the first three seconds", "add a title that says Day One" or "make it warmer", and the edit shows up in the preview right away.
- Add a section after EDIT BY CHATTING:
  ```
  ON YOUR IPHONE
  • Edits run on your iPhone, so there's no upload and no waiting
  • Undo any step, or compare with the original
  • Dictate your request instead of typing
  • Edit photos too
  • Exports keep going in the background, and you get a notification when your video is ready
  ```
- Replace the last line with:
  > Your video stays on your iPhone. Only your chat messages go to FinalCap's AI service. See the privacy policy for details.

**Pending the effects build** (the first build with the grouped effects executor): add "Remove or swap color channels, blur the background, and add audio effects like reverb and EQ" to EDIT BY CHATTING.

## Subscription

Not mentioned in the description for now. Edits are free on iOS while `FREE_EDITS_IOS=unlimited` is set, and the StoreKit product isn't set up in App Store Connect yet. Add a SUBSCRIPTION section once the product exists.

## What's New

Apple doesn't allow editing it on the first version. For a later version, use: "Edit videos by chatting, with trims, titles, color looks, speed and captions."

## Screenshots

Final captures come from build 12. Frames are 6.9" iPhone (1320×2868, files `iphone69-NN-*.png`) and 13" iPad (2064×2752, files `ipad13-NN-*.png`) in `docs/asc/screenshots/`. Each frame has one short caption above the device capture.

| # | App state | Caption |
|---|---|---|
| 1 | Editor with the sample clip and a prompt being typed | Edit videos by chatting |
| 2 | Chat with an applied edit card | Just say what you want |
| 3 | Compare, split between original and edited | See every change first |
| 4 | Title text on the preview | Add titles in seconds |
| 5 | Color look applied | Color looks on command |
| 6 | Export sheet | Save it to Photos |

**Pending build 12:** frame 1's caption becomes "Your video stays on your iPhone".

## URLs

| Field | URL |
|---|---|
| Privacy policy | `https://grepawk.com/legal/privacy.html` |
| Support | `https://grepawk.com/legal/support.html` |
| Marketing | `https://grepawk.com` |

## Localization

English (U.S.) only for 1.0.
