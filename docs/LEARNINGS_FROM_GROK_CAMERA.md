# Learnings from Grok Camera → FinalCut iOS

Portable lessons from **Photo Recipes / Grok Camera** (`yishengjiang99/photo-recipes`, `photo.grepawk.com`) for the **FinalCut** iOS port (`yishengjiang99/finalcut`, `grepawk.com`).

This is **not** a copy of camera product specs. Steal process, hosting, ASC, and mobile-API patterns only.

---

## 1. Same Ubuntu host, two products

| Product | Public host | systemd | App dir (prod) |
|---------|-------------|---------|----------------|
| FinalCut | `grepawk.com` / `www.grepawk.com` | `finalcut.service` | `/home/finalcut/apps/pages/finalcut` |
| Grok Camera | `photo.grepawk.com` | `photo-recipes.service` | (photo-recipes deploy path) |

**Do**

- Keep API base URLs, cookies, CORS, and absolute media URLs product-scoped.
- Treat live secrets on the box as source of truth (FinalCut: `.env` next to the app — fuller than `.env.production` on that host).
- Restart the **correct** unit after deploy (`finalcut.service` ≠ `photo-recipes.service`).

**Don’t**

- Point the FinalCut iOS Release client at `photo.grepawk.com`.
- Commit Stripe / Google / xAI keys; they already live on the grepawk Ubuntu box.

---

## 2. iOS monetization: StoreKit, not web Stripe checkout

Grok Camera lesson: **digital unlocks on iOS must go through StoreKit / App Store IAP**. Deep-linking iOS users to web Stripe for Pro is a guideline risk and a support mess.

FinalCut today: web Stripe + Google OAuth.

**Implication for FinalCut iOS**

- Keep Stripe on **web**.
- Plan **StoreKit** (or a clear “web-only subscribe” policy that never unlocks iOS digital features via web checkout) before App Review.
- Server must verify Apple transactions (App Store Server API) the way Photo Recipes did — don’t trust the client alone.
- Entitlement checks on edit/export APIs must understand **both** Stripe (web) and Apple (iOS) without lying to either client.

---

## 3. Auth for native clients: Bearer > cookies

Web sessions (`express-session` + Google OAuth cookies) are awkward on iOS (`WKWebView` / ASWebAuthenticationSession edge cases, `Secure` cookies, CORS).

Grok Camera used guest cookies + device tokens for some paths; FinalCut is correctly moving to:

1. Google Sign-In (or Sign in with Apple) on device  
2. Exchange for **Bearer** access token  
3. `Authorization: Bearer …` on API calls  

See open work: mobile Bearer PR. Also set any new server env (e.g. `GOOGLE_IOS_CLIENT_ID`) on the **box** `.env`, then restart `finalcut.service`.

---

## 4. Long work must be async + pollable

Grok Camera: vision Recommend over SSE so the client isn’t stuck on one blocking HTTP call; still had timeouts until the server path was redesigned.

FinalCut FFmpeg jobs are **worse** if sync — iOS will background-kill long uploads/processing.

**Pattern that worked / is right for FinalCut**

- `POST` → `{ jobId }`
- `GET /jobs/:id` → `queued | running | succeeded | failed` + `progress?` + absolute `resultUrl`
- Absolute URLs via prod `APP_BASE_URL` / `https://grepawk.com`
- Poll-only is fine for v0; add SSE later only if UX needs it

Binary response bodies without durable URLs do **not** survive app backgrounding well.

---

## 5. App Store Connect / TestFlight scars

Things that burned time on Grok Camera and will hit FinalCut:

1. **Export compliance** — almost every new build needs `usesNonExemptEncryption` cleared (or ITSAppUsesNonExemptEncryption in Info.plist) or TestFlight stays blocked.
2. **CFBundleVersion vs CI `run_number`** — ASC version is what **Info.plist** says. Don’t trust GitHub run numbers in logs as the TestFlight build number.
3. **Privacy nutrition label** — must be published before first Submit for Review; keep Privacy/Support/Terms HTML **accurate** to what you actually upload (frames, tokens, guest ids, STT on-device vs server).
4. **Review contact** — phone + email that Apple can reach.
5. **Resubmit loop** — cancel WAITING_FOR_REVIEW → attach new build → submit again; automate if you can (Photo Recipes used Actions).

---

## 6. Agentic / Grok UX (portable bits)

From Grok Camera Recommend / voice:

- **Structured outputs the client can apply** beat prose (“do X”) — FinalCut should keep tool calls that map to FFmpeg ops, not free-text edit instructions alone.
- **Latest user utterance wins** when intents conflict (don’t merge contradictory filters/looks).
- **Log inference request/response** (redact media) early — debugging “model didn’t do what I said” without logs wastes days.
- Prefer **on-device STT** for latency/privacy when voice is in-scope; server STT only if needed.
- Status UI: short chrome; don’t show full recipe essays in a tiny pill.

FinalCut-specific: chat → tool → job id → poll → refresh preview.

---

## 7. Deploy & ops

- Prefer GitHub Actions deploy when the OAuth app has `workflow` scope; otherwise a box-side pull+restart still works (Photo Recipes had both).
- After merge: confirm **health** of the right host, not the sibling product.
- File permission footguns: deploy users that can’t write `data/` or tmp entitlement files cause 502s that look like “AI is down.”
- Migrations / schema files must be **present in the deployed artifact** (missing SQL on disk → silent feature gaps).

---

## 8. Push (optional later)

If FinalCut wants APNs:

- Register device token with **environment** (sandbox vs production) — TestFlight often needs production APNs with the right setup; mismatches look like “push never arrives.”
- Persist tokens server-side; guest/user identity must be stable enough to target a device.
- Feature-flag live send until one E2E test on a real device succeeds.

Skip until after import → edit → export MVP.

---

## 9. Team / process

- Photo Recipes staff and FinalCut staff are **separate**; don’t edit `photo-recipes` from FinalCut work unless asked.
- Don’t churn `docs/agents/*.md` unless the user explicitly asks.
- Ship via PRs; keep contracts (auth, jobs, media URLs) in one short doc iOS + Backend both own.
- Design handoffs: screen names + stub checklist beat mock-only decks.

Related FinalCut docs/PRs (as of handoff):

- iOS v1 UX handoff
- Mobile Bearer auth
- Async process-video jobs

---

## 10. Explicit non-goals (don’t copy blindly)

- Viewfinder / Auto Optimize / creative looks pipeline  
- Camera permission onboarding copy  
- Photo Recipes quota dials / admin panel  
- Branding “Grok Camera”  

FinalCut brand + timeline/chat editor UX stay distinct.

---

## Quick checklist for FinalCut iOS v1

- [ ] Release API base = `https://grepawk.com` (or documented API origin on that host)
- [ ] Bearer auth from Google/Apple; no reliance on web session cookies
- [ ] Upload + FFmpeg via async job + poll + `resultUrl`
- [ ] StoreKit plan before App Review (or documented web-only billing boundary)
- [ ] Export compliance + privacy URLs accurate before TF/ASC submit
- [ ] Secrets only on Ubuntu `.env`; new keys → box + `systemctl restart finalcut`