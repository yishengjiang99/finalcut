# FinalCap — App Review notes (paste into ASC)

**Build:** ______ (`CFBundleShortVersionString` / `CFBundleVersion`)  
**Contact email:** yisheng.jiang@gmail.com  
**Contact phone:** +1 (669) 251-7789  

> Confirm phone/email before first submit. Same contacts used for Grok Camera / Photo Recipes App Review.

---

## What this app is

FinalCap is a **video editor**: import a clip from Photos, request edits in a chat UI, run server-side processing on grepawk.com, preview, and export. It is **not** a camera app and does not use the live camera for the MVP.

## How to demo (happy path)

1. Launch FinalCap.  
2. **Sign in** with the provided demo account **or** Sign in with Apple/Google (whichever ships in this build).  
3. Tap **Import** and choose any short sample video from Photos (or the Review device library).  
4. In chat, try: `Generate captions` (or tap the captions affordance). Wait for soft captions.  
5. Optional: `Burn subtitles` / burn-in — wait for “Burning subtitles…” until the preview updates (sync process-video; no job poll).  
6. Open **Export** and save/share.  

If a Pro gate appears: use **Sandbox** IAP (`com.grepawk.finalcut.subscription.monthly`) or the review promo/comp account described below.

## Demo account (fill before submit)

| Field | Value |
|-------|--------|
| Username / email | `_TBD_` |
| Password | `_TBD_` |
| Notes | Prefer Sign in with Apple for Review if available. DEBUG sample tokens must **not** be required for Review builds. |

## In-App Purchase

- Product: `com.grepawk.finalcut.subscription.monthly` (auto-renewable; confirm duration/price in ASC).  
- Restore Purchases is available on the paywall.  
- **No** Stripe / external checkout is used to unlock iOS features.  
- Web subscriptions on grepawk.com are separate and do not replace StoreKit inside the app.

## Network

- API host: `https://grepawk.com`  
- Uploads video for edit jobs; results return as absolute HTTPS URLs.  
- Requires network for edits; offline import preview may work locally depending on build.

## Encryption

Uses only standard HTTPS. Export compliance: **ITSAppUsesNonExemptEncryption = false** (see `EXPORT_COMPLIANCE.md`).

## Notes / known Review caveats

- First caption generation needs audible speech; silent clips correctly return an error (no fake captions).  
- Burn-in waits on a single multipart response (progress: “Burning subtitles…”).  
- Long non-burn edits may poll a job endpoint; leave the screen open until preview updates.

## Attachments

Attach a ≤30s sample MP4 with clear speech if Review devices have empty Photos libraries.
