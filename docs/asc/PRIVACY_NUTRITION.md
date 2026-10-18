# FinalCap — App Privacy answers (App Store Connect → FinalCap → App Privacy)

Updated 2026-10-10 for the push-notification build (1.0.1+). Enter these by hand: the public App
Store Connect API has **no App Privacy endpoint** (checked 2026-10-10; only the private web-session
`/iris/v1/appDataUsages` API exists, which needs a signed-in browser session and is not used here).
Editing App Privacy does **not** touch the 1.0 submission in review, but publishing changes the
live product page label, so publish together with (or just before) the push build.

Sources of truth: `public/legal/privacy.html` (grepawk.com/legal/privacy.html), `docs/push-lifecycle.md`,
iOS code (no third-party SDKs, no ad/attribution SDK, no crash SDK, no sign-in on iOS).

## Step 1 — "Do you or your third-party partners collect data from this app?"

**Yes, we collect data from this app.**

## Step 2 — Data types to tick

| Category | Data type | What it is in FinalCap |
|---|---|---|
| Identifiers | **Device ID** | random install ID (Keychain UUID, `POST /api/auth/mobile/device`) and the APNs push token |
| Purchases | **Purchase History** | StoreKit transaction ids verified by our server (FinalCap Pro) |
| Usage Data | **Product Interaction** | edits per day (quota counter) and, while notifications are allowed, `app_open` / `export_done` / `paywall_view` / `push_opened` with a time |
| User Content | **Photos or Videos** | up to 4 small still frames per edit request; full clips only with Settings → Cloud processing (off by default) |
| User Content | **Audio Data** | extracted audio for cloud captions / lyric captions (opt-in, deleted right after transcription) |
| User Content | **Other User Content** | the typed or dictated edit request text |

Leave unticked: Contact Info (no sign-in on iOS), Health & Fitness, Financial Info, Location,
Sensitive Info, Contacts, Emails or Text Messages, Gameplay Content, Customer Support, Browsing
History, Search History, User ID, Advertising Data, Crash Data, Performance Data, Other Diagnostic
Data (no crash/diagnostics SDK in the iOS app), Other Usage Data, Other Data Types.

## Step 3 — Per data type

| Data type | Purposes (tick exactly these) | Linked to the user's identity? | Used for tracking? |
|---|---|---|---|
| Device ID | App Functionality; Product Personalization; Developer's Advertising or Marketing | **Yes** | No |
| Purchase History | App Functionality | **Yes** | No |
| Product Interaction | App Functionality; Analytics; Product Personalization; Developer's Advertising or Marketing | **Yes** | No |
| Photos or Videos | App Functionality | No | No |
| Audio Data | App Functionality | No | No |
| Other User Content | App Functionality | **Yes** | No |

Why:
- **Device ID / Product Interaction → Product Personalization**: notification tips are chosen from
  these events (docs/push-lifecycle.md). **Developer's Advertising or Marketing**: the opt-in
  "Tips & offers" pushes (feature news, FinalCap Pro). **Analytics**: open rate / return-within-24h KPIs.
- **Linked = Yes**: stored server-side against the install's account row (`users.id`), even
  though that row holds no name or email.
- **Other User Content linked = Yes**: edit-request text is kept in a server audit log keyed by the
  account id (`chat_interactions`). If that log is removed, this can become "No".
- **Tracking = No** for everything: no data is combined with third-party data for ads or shared
  with data brokers. xAI receives only an anonymous summary to word notifications (no identifiers).

## Resulting label

- **Data Used to Track You:** none
- **Data Linked to You:** Identifiers, Purchases, Usage Data, User Content (Other User Content)
- **Data Not Linked to You:** User Content (Photos or Videos, Audio Data)

## Nutrition ↔ legal HTML

`public/legal/privacy.html` lists the same: edit-request thumbnails + metadata, opt-in cloud clips
(iOS) / video files (web), opt-in audio for cloud/lyric captions, the random device ID, push token +
time zone + notification events + anonymous xAI summary, purchase receipts. The microphone is used
only for on-device dictation. Local export notifications are on-device.

## Explicit non-claims

Do not declare camera capture uploads, contacts, location, or ad identifiers (IDFA) — FinalCap
does not collect them.
