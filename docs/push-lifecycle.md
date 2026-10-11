# FinalCap push notification lifecycle

Status (2026-10-10 18:30 PT): **LIVE** (`PUSH_LIFECYCLE_MODE=live`) with APNs configured
(team key GAPGVZ7K2D at `/etc/finalcut/AuthKey_GAPGVZ7K2D.p8`, root:finalcut 0640; auth check
accepted in sandbox and production for `com.ragnus.w2`). Devices appear once users run 1.0.1+
(first push-capable build); 1.0 (build 16, in App Store review) has no push client.
Auto kill switch + daily monitor enabled (§8).

## 1. Audit (before this change)

| Area | Before |
| --- | --- |
| Remote push | None. No APNs code, no `aps-environment` entitlement, no token endpoint. |
| Local notifications | "Export finished" local notification; permission asked by the soft prompt *Notify me when it's done* on the first video export (moment of value). |
| iOS telemetry | None. The app's only server signals are the device session (`POST /api/auth/mobile/device` → `users`, `api_tokens`) and the quota counter `daily_inference_usage` (edits per user per day). |
| Web telemetry | `finalcut_telemetry_events` (web only; random localStorage id). Not used for push. |
| Paywall | FinalCap Pro, monthly, "Unlimited AI edits, captions and translations". **No free trial** → no trial-ending messages; never mention price or "free". If `FREE_EDITS_IOS=unlimited` the paywall segment is disabled. |
| Provisioning | `com.ragnus.w2` already has the Push Notifications capability; the "FinalCap App Store" profile carries `aps-environment=production` (checked read-only via `asc-listing-readonly.yml` → capabilities). |
| APNs key | Team key `GAPGVZ7K2D` (team `83D36RPMUM`) exists and is team-wide (works for `com.ragnus.w2`), but grepawk.com's FinalCap `.env` has no `APNS_*` values. |

## 2. Data used (and not used)

Used, all first-party and keyed only by the device's internal `users.id` (the random install id):

| Signal | Source | Notes |
| --- | --- | --- |
| install time | `users.created_at` | |
| edits per day + time of last edit that day | `daily_inference_usage` | already kept for quotas |
| last session | `MAX(api_tokens.created_at)` | |
| `app_open`, `export_done`, `paywall_view`, `push_opened` (+ `send_id`) | `push_events` | sent by the app **only while notifications are allowed** |
| Tips & offers opt-in | `push_devices.marketing_opt_in` | Settings toggle, off by default |
| subscription | `users.has_subscription` | |

Never used: prompts (`chat_interactions`), captions, frames, media, emails, IPs.

## 3. Segments

Priority order; one push per tick per user at most. *Feature* = sent after notification permission.
*Promotional* = also requires the in-app **Tips & offers** opt-in (Guideline 4.5.4).

| Segment | Class | Trigger | Goal | Tap → |
| --- | --- | --- | --- | --- |
| `edit_not_exported` | feature | last edit 2–48 h ago, no `export_done` since, app reports events, idle ≥ 2 h | finish the unfinished edit | editor |
| `onboarding_d1` | feature | install age 1–2 d, idle ≥ 12 h | first chat edit ("trim the first 3 seconds") | editor |
| `onboarding_d3` | feature | install age 3–4 d, idle ≥ 24 h | on-device captions | editor |
| `onboarding_d7` | feature | install age 7–8 d, idle ≥ 48 h | translate captions | editor |
| `paywall_not_converted` | promotional | free user, `paywall_view` 20–72 h ago, idle ≥ 12 h; once per 30 days; off when iOS edits are unlimited | honest benefit: unlimited AI edits, captions and translations. No trial, no price | paywall |
| `new_feature` | promotional | install ≥ 3 d, idle 1–30 d, an *active* entry in `FEATURE_ANNOUNCEMENTS` not yet sent | announce a shipped feature | editor |
| `inactive_7` / `inactive_14` | promotional | 7–14 / 14–30 days since last seen, install ≥ 8 d | one concrete edit idea | editor |
| `winback_30` | promotional | 30–45 days since last seen | last gentle check-in; silence after 45 d | editor |

There is no "trial ending" segment (no trial). Apple already emails renewal notices; we never duplicate them.
`FEATURE_ANNOUNCEMENTS` ships with `lyric_captions_v1` **inactive**; flip `active: true` only when the
feature is in the live App Store build.

## 4. Safety

* `PUSH_LIFECYCLE_MODE` = `off | dry_run (default) | sandbox | allowlist | live`. Runtime ops (`push_ops`) can only **downgrade**.
* Kill switch: env `PUSH_KILL_SWITCH=true`, or the workflow *Push lifecycle (FinalCap)* → `kill_switch_on`.
* Caps: 1 per 24 h, 3 per rolling 7 days per user. Send window 10:00–20:00 in the device's time zone (no time zone → skipped).
* Dedupe: unique `(user_id, dedupe_key, dry_run)` in `push_sends`; the row is written **before** the send, so it is also the lock across processes.
* Dead tokens: 410 / `Unregistered` / `BadDeviceToken` → device disabled immediately. `DELETE /api/push/register` when the user turns notifications off.
* Max 200 real sends per tick. Real sends require APNs env + a targeting mode; anything else logs `would_send`.
* Retention: `push_events` and `push_sends` deleted after 13 months.

## 5. Copy (Grok) and guardrails

`src/server/push/copy.js`. Grok (`PUSH_COPY_MODEL`, default `grok-4.20-0309-non-reasoning`, then `grok-4.3`) gets the
segment goal, a fixed list of true app facts and a coarse summary (`tier`, `editsLastWeek` 0 / 1-3 / 4+, `hasExported`).
No ids, tokens, timestamps or content. Output must pass `validateCopy`: title ≤ 40, body ≤ 140, one line; no urgency/scarcity,
no prices/discounts/%, no links, no guilt, no "since you last…" surveillance tone, no absolute claims, ≤ 1 "!", ≤ 1 emoji,
never "free"/"trial", "new" only in `new_feature`, Pro/upgrade only in `paywall_not_converted` and only verified benefits.
Two attempts per model, then the hand-written template. Good copy is cached 14 days in `push_copy_cache` per (segment, facts).

Sample Grok output (2026-10-10, all passed guardrails):

| Segment | Title | Body |
| --- | --- | --- |
| edit_not_exported | Your recent edit is ready | Export saves the finished video straight to your Photos library. Give it a try on the edit you just made. |
| onboarding_d1 | Try your first edit | Open a clip and type or say what you want, like "trim the first 3 seconds" or "make it black and white". |
| onboarding_d3 | Try adding captions | Open a video and type "add captions" in the chat. They'll be created right on your iPhone. |
| onboarding_d7 | Translate your captions | Ask in the chat to translate your captions into another language, like Spanish or French. |
| paywall_not_converted | What FinalCap Pro includes | Pro gives unlimited AI edits, captions, and translations. Open the chat and try any edit you like. |
| new_feature (inactive) | Lyric captions are here | Ask in the chat to add lyrics that match your music video. Turn on Cloud processing first, then try it on a clip with a song. |
| inactive_7 | Try a quick edit | Open your recent clip and type "trim the first 3 seconds" in the chat. |
| inactive_14 | Try adding captions | Open your recent video and ask in chat: suggest some captions |
| winback_30 | Ready to try editing? | Open a video and type something simple like trim the first 5 seconds. |

## 6. API (all new paths; the iOS contract gate is unaffected)

App, Bearer device session: `POST/DELETE /api/push/register`, `GET/PUT /api/push/prefs` (`marketingOptIn`),
`POST /api/push/events` (`app_open | export_done | paywall_view | push_opened` + `sendId`).
Admin (header `X-Push-Admin-Secret`, 404 while `PUSH_ADMIN_SECRET` unset): `/api/push/lifecycle/{report,tick,ops,preview}`; HTTP tick is forced dry-run unless `{"dryRun": false}`.

Payload: `{"aps":{"alert":{"title","body"},"sound":"default","thread-id":"finalcap-lifecycle"},"type":"lifecycle","send_id","segment","destination":"editor|paywall"}`.

## 7. KPIs (`report`)

| KPI | Definition | Target |
| --- | --- | --- |
| Open rate | `push_opened` with the send's `send_id` / real sends | ≥ 8 % |
| Return within 24 h | real sends followed by any app event within 24 h | ≥ 20 % |
| Opt-out rate | (Tips & offers opt-outs + disabled tokens) / devices, per week | < 2 % |

Per segment: sent / would_send / failed / opened / returned24h. Use dry-run counts to size segments before going live.

## 8. Ops

Actions → **Push lifecycle (FinalCap)** (`.github/workflows/push-lifecycle.yml`, runs `scripts/push-lifecycle.mjs` on the server):
`report`, `monitor`, `dry_run_tick`, `live_tick` (only when live), `guard`, `apns_check` (fake token, no user contacted),
`samples`, `configure_apns`, `set_mode`, `kill_switch_on`, `kill_switch_off`.

**Auto kill switch** (`autoGuard`, after every non-dry tick and in the daily monitor): sets
`push_ops.kill_switch=on` (+ `auto_kill` reason) when, since go-live within 7 days, distinct users who
turned Tips & offers off or turned notifications off (app unregisters) exceed **2%** of push users
(minimum 2), or > **20%** of real APNs sends in 24 h fail (minimum 10; uninstalled tokens excluded).

**Daily monitor**: scheduled `monitor` at 10:05 PT — guard + KPIs in the job summary; the job fails
(GitHub notifies the owner) while the kill switch is on.

## 9. Go live (user actions)

1. Put the APNs key on grepawk.com for FinalCap: `APNS_KEY_ID=GAPGVZ7K2D`, `APNS_TEAM_ID=83D36RPMUM`, `APNS_P8_PATH=<file>` (same team key as ProTune). Restart via a normal deploy.
2. Update the App Store privacy label (see `docs/asc/PRIVACY_NUTRITION.md`) and ship the iOS build with push support (after 1.0 is approved; never touch the build in review).
3. `PUSH_LIFECYCLE_MODE=allowlist` + `PUSH_LIFECYCLE_ALLOWLIST=<your TestFlight device_install_id>`; confirm delivery, tap → editor/paywall, `push_opened` in `report`.
4. `PUSH_LIFECYCLE_MODE=live`. Watch `report` daily for a week; `kill_switch_on` if opt-outs exceed 2 %/week.
