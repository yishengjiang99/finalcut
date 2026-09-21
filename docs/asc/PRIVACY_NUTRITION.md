# FinalCut — App Privacy (nutrition label) draft

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
| Audio / Speech | Captions: audio/video uploaded to **server** for STT — declare **Audio Data** and/or **Videos** as collected if uploaded |
| Photos / Videos | User-imported video uploaded for processing — declare **Photos or Videos** |
| Search History | N/A unless you add it |
| Precise Location | Should be **not collected** unless you add location features |

## Tracking

Default: **Do not track** across apps/sites. No third-party ad SDK in v1. If you add ATT-required SDKs later, revisit.

## Nutrition ↔ legal HTML

[`public/legal/privacy.html`](../../public/legal/privacy.html) must list the same uploads: video files, auth identifiers, push tokens (if added), purchase receipts, and diagnostics.

## Explicit non-claims

Do not declare camera capture, contacts scrapes, or Photo Recipes Recommend frame uploads unless FinalCut ships them.
