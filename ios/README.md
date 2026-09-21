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
- **DEBUG / demo only:** optional `sample-access-token` from `GET /api/sample-access-token`.
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
- **Edits / processing**: server Node/FFmpeg APIs when networked (`/api/chat`, `/api/process-video`, …).
- **No on-device FFmpeg** in v1.
- Future poll jobs: `JobStatus` = `queued | running | succeeded | failed`.

## Screens (Design names)

1. Landing  
2. SignIn  
3. Paywall  
4. Editor — single root (TopBar → Preview → Chat → SampleChips → Composer)  
5. ExportSheet  

Editor states: `empty | uploading | ready | processing | failed`.

Local demo flow: Landing → SignIn (continue) → Paywall (buy/restore/skip) → Editor (**empty → import → ready**).

## Tests

```bash
xcodebuild test -project FinalCut.xcodeproj -scheme FinalCut -destination 'platform=iOS Simulator,name=iPhone 16'
```

`FinalCutTests` covers API URL construction and model decoding stubs.
