# Playbook: Ship an iOS app from an existing web/API product

Reusable process distilled from **Grok Camera / Photo Recipes** (`yishengjiang99/photo-recipes`) and applied first to **FinalCut** (`yishengjiang99/finalcut`). Product-agnostic on purpose — FinalCut-specific scars live in [`../LEARNINGS_FROM_GROK_CAMERA.md`](../LEARNINGS_FROM_GROK_CAMERA.md) and [`../asc/CHECKLIST.md`](../asc/CHECKLIST.md).

## When to use

You already have a Node (or similar) API + web client. You want a native SwiftUI client that talks to the same backend, monetizes via Apple, and survives App Review.

## 0. Decisions before code

| Decision | Default that survived review | Avoid |
|----------|------------------------------|--------|
| Billing on iOS | **StoreKit 2** + server verify (App Store Server API) | Deep-link to web Stripe for digital unlocks |
| Auth on iOS | **Bearer** (or product-specific token header) after Sign in with Apple / Google | Relying on web session cookies alone |
| Long work | **Async job** → poll (or SSE) + absolute `resultUrl` | Multi-minute sync HTTP |
| Heavy media | Server-side processing | Reimplement FFmpeg on-device in v1 |
| Secrets | Host `.env` + CI secrets | Keys in git / XCConfig committed |
| Branding | Distinct App Store name + `CFBundleDisplayName` | Copying a sibling product’s chrome or name |

## 1. Scaffold (Xcode)

1. New SwiftUI app, iOS 17+ (or your floor), unique **bundle id** (`com.org.product`).
2. Schemes: Debug → staging/API you control; Release → production origin only.
3. `GENERATE_INFOPLIST_FILE = YES` is fine — set keys in build settings:
   - `INFOPLIST_KEY_CFBundleDisplayName`
   - `INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO` (if HTTPS-only; see Export Compliance)
   - Usage strings: photo library / camera / mic **only if you actually use them**
4. Keep a thin `APIConfig` with overridable `baseURL`. Never hardcode secrets.
5. Ship a **StoreKit Configuration** `.storekit` file for local IAP testing.

**Done when:** Debug builds hit staging; Release hits prod; one empty screen runs on simulator + device.

## 2. Mobile API contract

Steal this shape, not camera features:

- Auth: exchange Apple/Google → server session/JWT → `Authorization: Bearer …` (or documented custom header). Document demo tokens as **DEBUG-only**.
- Uploads: multipart; return durable ids/URLs.
- Edits: `POST` → `{ jobId }` then `GET /jobs/:id` → `queued|running|succeeded|failed` + absolute `resultUrl`.
- Absolute URLs via prod `APP_BASE_URL` (relative paths break after backgrounding).
- Errors: stable status codes (e.g. **422** for “no speech”) so the client never soft-fails into fake success.
- Keep the **web cookie path working** — don’t break browser clients when adding Bearer.

**Done when:** iOS can auth (or DEBUG token), upload, run one job, poll, download result on a real device with the app backgrounded once mid-job.

## 3. StoreKit boundary

1. Create IAP products in App Store Connect (subscriptions/consumables as needed).
2. Client: StoreKit 2 `Product.products`, `purchase()`, `Transaction.currentEntitlements`, **Restore**.
3. Server: verify with App Store Server API; map Apple original transaction → entitlement; gate paywalled APIs.
4. Web keeps Stripe; server understands **both** without lying to either client.
5. Never unlock iOS digital features solely because a Stripe cookie exists.

**Done when:** Sandbox purchase + restore gates a protected API; web Stripe still works.

## 4. Privacy & legal pages (before first Submit)

Publish HTTPS pages the store will link:

- Privacy Policy  
- Terms of Use  
- Support / contact  

They must match **actual** uploads (tokens, frames, guest ids, on-device vs cloud STT, crash logs). Update HTML when behavior changes — App Review reads them.

App Privacy (nutrition label) in ASC must match the same story.

**Done when:** three URLs load without login and name the real data practices.

## 5. TestFlight pipeline

1. Archive → upload (Xcode or CI). Prefer automating once CI secrets exist.
2. **Export compliance**: set `ITSAppUsesNonExemptEncryption=NO` in Info/build settings **and/or** clear via ASC API/workflow on each build. Missing this blocks TF install.
3. Trust **`CFBundleVersion` from the binary**, not GitHub `run_number` in logs.
4. Internal Testing group → Core testers; clear compliance → status VALID.
5. Smoke on device: cold start, auth, one happy path, restore purchases, background mid-job.

**Done when:** named build is VALID and installable for internal testers.

## 6. App Store Connect listing pack

Prepare in repo (see FinalCut `docs/asc/`):

- Listing copy (name ≤30, subtitle ≤30, description, keywords ≤100, What’s New)
- Screenshot brief (required sizes: 6.7", 6.5"/6.1" as ASC demands)
- Review notes (demo path, IAP, what *not* to tap)
- Review contact phone + email Apple can reach
- Age rating / content rights answers

**Done when:** checklist in `docs/asc/CHECKLIST.md` is green.

## 7. Submit / resubmit loop

1. Attach build to version.
2. Submit for Review.
3. If you ship a fix while WAITING_FOR_REVIEW: cancel → attach new build → submit again.
4. Keep Privacy/Support/Terms + nutrition label in sync with the build you attach.

Automate assign-to-TestFlight / clear-compliance / submit when you have ASC API key secrets (Photo Recipes: `asc-*.yml` workflows).

## 8. CI / Actions patterns worth copying

From Grok Camera (adapt bundle id + secrets; never commit `.p8` contents):

- Clear export compliance by build number  
- Invite TestFlight testers  
- Optional: submit version for review  

Required secrets (names only): `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, `APP_STORE_CONNECT_API_KEY_P8`.

## 9. Failure modes we actually hit

| Symptom | Likely cause |
|---------|----------------|
| TF build “Missing Compliance” forever | Encryption flag not cleared / not in Info.plist |
| Wrong build number in conversation | Confusing Actions run_number with CFBundleVersion |
| Review rejection: payments | Stripe / web checkout used to unlock iOS features |
| “AI doesn’t work” with no logs | No server-side inference/job logging (redact media) |
| 502 / permission errors after deploy | Deploy user can’t write `data/` or tmp |
| Push never arrives | Sandbox vs production APNs env mismatch |
| Soft success on empty audio | Client ignored **422**; always handle structured errors |
| Trademark / name collision | Product name too close to a platform brand — decide early |

## 10. Explicit non-goals (camera app)

Do **not** copy into a non-camera product:

- Viewfinder / Auto Optimize / creative-look pipelines  
- Camera-permission onboarding copy  
- Photo Recipes admin quota dials  
- “Grok Camera” branding  

Steal process + ASC/ops; keep product UX distinct.

## Suggested repo layout

```
docs/playbooks/ios-app-from-scratch.md   # this file
docs/asc/CHECKLIST.md                   # per-app submission checklist
docs/asc/LISTING.md
docs/asc/REVIEW_NOTES.md
docs/asc/SCREENSHOT_BRIEF.md
docs/asc/PRIVACY_NUTRITION.md
docs/asc/EXPORT_COMPLIANCE.md
docs/asc/STOREKIT.md
public/legal/{privacy,terms,support}.html
ios/.../StoreKit/*.storekit
```

## Quick start for a new sibling app

1. Copy `docs/asc/*` + legal HTML; rewrite product facts.  
2. Copy StoreKit placeholder + encryption Info key.  
3. Wire Bearer + async jobs before UI polish.  
4. Run the checklist once on TestFlight before first Submit.
