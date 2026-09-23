**Apple ID:** `6815060815` · **Bundle:** `com.ragnus.w2` · **SKU:** `finalcap-ai`

# FinalCap iOS — App Store submission checklist

Bundle ID: `com.ragnus.w2`  
App Name: `FinalCap - AI Video Editor` · Display name: `FinalCap`  
API: `https://grepawk.com`  
Owner: FinalCut iOS + Design; CoS gates submit.

Use with the reusable playbook: [`../playbooks/ios-app-from-scratch.md`](../playbooks/ios-app-from-scratch.md).

Legend: `[ ]` open · `[x]` done · `N/A` not in scope for this version.

---

## A. Engineering (blockers for Review)

- [ ] Release `APIConfig` base URL = `https://grepawk.com` (not photo.grepawk.com, not localhost)
- [ ] Production auth path ready (Sign in with Apple and/or Google → Bearer) **or** Review notes document a working demo path Apple can use
- [ ] DEBUG `sample-access-token` **disabled / unreachable** in Release builds
- [ ] Import → one chat edit → export works on device (not only simulator)
- [ ] Long FFmpeg edits use async jobs + poll; burn-in captions use sync `POST /api/process-video` per Design
- [ ] Absolute `resultUrl` downloads work with auth after backgrounding
- [ ] StoreKit product `com.ragnus.w2.subscription.monthly` configured in ASC + `.storekit` file
- [ ] Purchase + **Restore** gate a real server entitlement (or Review notes explain free path clearly)
- [ ] No Stripe Checkout / web billing unlock inside the iOS app
- [ ] `ITSAppUsesNonExemptEncryption` / export compliance = NO (HTTPS only) — see [`EXPORT_COMPLIANCE.md`](EXPORT_COMPLIANCE.md)
- [ ] Usage descriptions present only for APIs you call (Photo Library for import, Mic if recording, etc.)
- [ ] Crash-free smoke: cold start, import sample, captions or trim, export, kill app mid-job, resume/poll

## B. Legal & privacy URLs (must be live HTTPS)

- [ ] Privacy Policy live — [`PRIVACY_NUTRITION.md`](PRIVACY_NUTRITION.md) + `public/legal/privacy.html`
- [ ] Terms of Use live — `public/legal/terms.html`
- [ ] Support page live — `public/legal/support.html`
- [ ] ASC App Privacy nutrition label matches real uploads (video, auth ids, purchases, diagnostics)
- [ ] Copy does **not** claim camera / Photo Recipes / Grok Camera behaviors

Suggested public URLs (wire on deploy):

- `https://grepawk.com/legal/privacy.html`
- `https://grepawk.com/legal/terms.html`
- `https://grepawk.com/legal/support.html`

## C. App Store Connect metadata

- [ ] App record created; bundle id linked
- [ ] Listing draft pasted from [`LISTING.md`](LISTING.md) (name, subtitle, description, keywords, What’s New)
- [ ] Category: Photo & Video (confirm secondary)
- [ ] Age rating questionnaire completed
- [ ] Copyright / content rights answered
- [ ] Review contact phone + email (see [`REVIEW_NOTES.md`](REVIEW_NOTES.md)) — **confirm before submit**
- [ ] Screenshots for required sizes per [`SCREENSHOT_BRIEF.md`](SCREENSHOT_BRIEF.md)
- [ ] App icon 1024×1024 (no alpha) uploaded

## D. TestFlight

- [ ] Archive uploaded; processing finished
- [ ] Export compliance cleared → build **VALID**
- [ ] Internal group can install; Core testers smoke-pass
- [ ] CFBundleVersion recorded here: `________` (do not use Actions run_number as truth)

## E. Submit

- [ ] Version 1.0 (or current) has the intended build attached
- [ ] Review notes pasted from [`REVIEW_NOTES.md`](REVIEW_NOTES.md)
- [ ] IAP products **Ready to Submit** / cleared for sale with the version
- [ ] Submit for Review
- [ ] If iterating: cancel WAITING_FOR_REVIEW → attach new build → resubmit

## F. Post-submit

- [ ] Monitor Resolution Center
- [ ] Keep CoS + FinalCut channel updated with status + build number
- [ ] On Approve: confirm phased release / manual release choice
- [ ] On Reject: file root cause in repo (short note under `docs/asc/`) and fix via PR

---

### Sign-off

| Role | Name | Date | Build |
|------|------|------|-------|
| FinalCut iOS | | | |
| FinalCut Design | | | |
| FinalCut Backend (API/entitlements) | | | |
| Chief of Staff | | | |
