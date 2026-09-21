# FinalCut iOS

Native SwiftUI shell for FinalCut (iOS 17+).

## Open in Xcode

1. Clone this repo (or open the `ios/` folder from a checkout).
2. Open `ios/FinalCut.xcodeproj` in Xcode 15+.
3. Select the **FinalCut** scheme and an iOS 17+ simulator or device.
4. Build & Run (`Cmd+R`).

## Configuration

| Setting | Value |
|--------|--------|
| Bundle ID | `com.grepawk.finalcut` |
| Deployment target | iOS 17.0 |
| Default API base URL | `https://grepawk.com` |
| IAP product (placeholder) | `com.grepawk.finalcut.subscription.monthly` |

Override the API base URL at runtime via `APIConfig.shared.baseURL`.

## Auth (this scaffold)

**Google Sign-In is deferred** (product decision). No Google Sign-In SDK; SignIn does not call `POST /api/auth/mobile/google`.

- SignIn is a **stub** (“Coming soon”) with **Continue to editor (local demo)**.
- **No `GOOGLE_IOS_CLIENT_ID` required** for this scaffold.
- **DEBUG / demo only:** `GET /api/sample-access-token`, then send header `sample-access-token: <token>` on API calls (jobs enqueue, poll, **and** result downloads). Never `Authorization: Bearer <sample-token>`.
- Unused Bearer helpers may remain on `APIClient` for a future phase; not active in SignIn.
- Cookie jar is optional/temporary; not primary.

## Paywall — StoreKit 2 (not Stripe)

- Uses StoreKit 2 placeholders: `Product.products`, `purchase()`, `Transaction.currentEntitlements`.
- Placeholder product id: **`com.grepawk.finalcut.subscription.monthly`** (configure in App Store Connect or a StoreKit Configuration file).
- PaywallView: **Subscribe** / **Restore purchases** call stub helpers; they no-op gracefully when products are missing (typical simulator).
- **Does not** open Stripe Checkout URLs or use `ASWebAuthenticationSession` for billing.
- Local demo can continue without a purchase.

## Architecture (v1)

- **Preview playback + scrub**: AVKit / AVFoundation only.
- **Edits / processing**: prefer **async jobs API** (poll-only):
  - `POST /api/jobs/process-video` (multipart) → `{ jobId }`
  - `GET /api/jobs/:id` → `{ status, progress?, error?, resultUrl? }` with `status ∈ queued|running|succeeded|failed`
  - Absolute `resultUrl` on `https://grepawk.com` (download may still need auth)
- Sync `POST /api/process-video` remains for web; iOS should not prefer it.
- Editor stays in `processing` through `queued|running`; flips to `ready` / `failed` only on terminal status.
- **No on-device FFmpeg** in v1.

## Screens (Design names)

1. Landing  
2. SignIn  
3. Paywall  
4. Editor — single root (TopBar → Preview → Chat → SampleChips → Composer)  
5. ExportSheet  

Editor states: `empty | uploading | ready | processing | failed`.

Local demo flow: Landing → SignIn (continue) → Paywall (buy/restore/skip) → Editor (**empty → import → ready**).


## Captions three-step flow

Captions are **three separate sync steps** (not one async captions job):

1. **Generate** — `POST /api/generate-captions` (raw video body + optional `X-Args`) → soft `{ srt, vtt }` chips under the assistant bubble. Overlay: “Generating captions…”. 422 → inline “no speech” (no fake VTT).
2. **Translate** (optional) — `POST /api/translate-captions` JSON `{ srtContent, targetLanguage }` → source + target chips. Overlay: “Translating…”.
3. **Burn-in** — sync multipart `POST /api/process-video` with `operation=burn_subtitles` and `args` including `srtContent` (+ `translatedSrtContent` for dual). **Do not** use `/api/jobs/process-video` for burn/add_audio. Overlay: “Burning subtitles…”. On success, swap preview to the burned clip; keep soft download chips.

Auth (DEBUG/demo): `GET /api/sample-access-token`, then header `sample-access-token` on generate/translate/burn and result downloads — never `Authorization: Bearer` with the sample token.

Other long FFmpeg edits still use the async jobs poll path from Backend #51.

## Tests

```bash
xcodebuild test -project FinalCut.xcodeproj -scheme FinalCut -destination 'platform=iOS Simulator,name=iPhone 16'
```

`FinalCutTests` covers API URL construction (jobs + captions), JobStatus / JobPollResponse decoding, caption JSON decode, and burn_subtitles multipart field names.

## App Store submission

ASC checklist, listing copy, Review notes, privacy / export / StoreKit:

→ [`docs/asc/README.md`](../docs/asc/README.md)

Reusable iOS shipping playbook (extracted from Grok Camera learnings):

→ [`docs/playbooks/ios-app-from-scratch.md`](../docs/playbooks/ios-app-from-scratch.md)
