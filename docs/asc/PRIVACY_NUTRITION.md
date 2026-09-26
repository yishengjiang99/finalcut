# FinalCap — App Privacy (nutrition label) draft

Complete App Store Connect → App Privacy to match **shipping** behavior. Mark TBD until iOS confirms.

## Data linked to user (likely)

| Type | Example | Purpose | Linked | Tracking |
|------|---------|---------|--------|----------|
| Contact Info — Email | Sign-in | Account | Yes | No |
| Identifiers — User ID | Account / guest id | Account, quota | Yes | No |
| Purchases | StoreKit transaction ids | Commerce | Yes | No |
| Usage Data — Product Interaction | Edit/job analytics if any | Analytics / app functionality | TBD | No |
| Diagnostics — Crash Data | Crash logs if collected | App functionality | TBD | No |

## Data not linked / on-device

| Type | Notes |
|------|--------|
| Audio / Speech | iOS build 10+: dictation is **on-device only** (`requiresOnDeviceRecognition`); audio is never uploaded, only the text request. Server captions upload audio/video **only** when the user turns on Settings → Cloud processing (default off). |
| Photos / Videos | iOS build 10+: media **stays on device**; edits render and export on the iPhone. The chat request carries metadata (type, size, duration, hasAudio) and **up to 4 still-frame thumbnails** (≤512 px JPEG) for the model — declare **Photos or Videos** (app functionality, not linked, no tracking) for the thumbnails. Full clips upload only with the opt-in Cloud processing setting. Web still uploads clips for processing. |
| Search History | N/A unless you add it |
| Precise Location | Should be **not collected** unless you add location features |

## Tracking

Default: **Do not track** across apps/sites. No third-party ad SDK in v1. If you add ATT-required SDKs later, revisit.

## Nutrition ↔ legal HTML

[`public/legal/privacy.html`](../../public/legal/privacy.html) must list the same uploads: edit-request thumbnails + metadata, opt-in cloud clips (iOS) / video files (web), auth identifiers, push tokens (if added), purchase receipts, and diagnostics. It also states that the microphone is used only for on-device dictation. Local export notifications are on-device (no push token).

## Explicit non-claims

Do not declare camera capture, contacts scrapes, or Photo Recipes Recommend frame uploads unless FinalCap ships them.
