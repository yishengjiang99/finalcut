# FinalCap steering packet — Monday, November 16, 2026

**Period covered:** Monday Nov 9 – Sunday Nov 15, 2026 (Pacific), the 7 most
recent complete days before Nov 16. Today (Nov 16) is a partial day and is
excluded, per the canonical funnel rule. Data pulled Nov 16, 2026. All
telemetry is filtered to FinalCap only (`app = 'finalcap'`); the telemetry
table is shared with other apps and unfiltered reads are never used.

## 1. FinalCap funnel (canonical, session-based)

| Stage | Sessions | Conversion |
|---|---|---|
| Sessions (any event) | 62 | — |
| App open | 62 | 100% of sessions |
| Editor open | 21 | 33.9% of sessions; 33.9% of app opens |
| Edit start | 21 | 100% of editor opens |
| Edit success | 24 | 114.3% of edit starts — see note |
| Export start | 4 | 16.7% of edit successes |
| Export success | 4 | 100% of export starts |

Revenue stages, same window (distinct sessions): paywall view 51 → plan
select 2 → purchase start 2 → purchase cancelled 2 → **purchase success
0**. Paywall→purchase **0% (0/51)**; sessions→purchase **0% (0/62)**. Trial
starts: **0** (zero by design — FinalCap has no trial product; flag loudly
if ever nonzero). Edit errors: 7 sessions. Restore taps: 2 sessions.

Note on edit success > edit start: 24 sessions emitted `edit_success`
against 21 with `edit_start` inside the window — 3 sessions recorded a
success without a start in-window (likely sessions spanning the window
boundary, or an instrumentation quirk). Counts are reported exactly as the
table returned them; the funnel's revenue stage is unaffected.

Daily sessions in the window: Nov 9: 8, Nov 10: 24, Nov 11: 1, Nov 12: 5,
Nov 13: 17, Nov 14: 2, Nov 15: 5. Spiky — Nov 10 + Nov 13 account for 41 of
62 sessions (66%). Paywall views by day: Nov 9: 7, Nov 10: 22, Nov 11: 0,
Nov 12: 2, Nov 13: 15, Nov 14: 1, Nov 15: 4.

Like-for-like vs the previous packet's window (Nov 2 – Nov 8): sessions
35 → 62 (+77%); app opens 32 → 62; editor opens 20 → 21 (flat); edit
starts 18 → 21; edit successes 15 → 24; export starts 5 → 4; export
successes 5 → 4; paywall views 27 → 51 (+89%); plan selects 5 → 2;
purchase starts 5 → 2; purchase cancelled 5 → 2; purchase success 0 → 0.

What moved: volume grew, but it is paywall volume, not editor volume. 51
of 62 sessions (82%) saw the paywall while only 21 opened the editor — the
new sessions mostly hit the paywall without editing. Editor-open share fell
from 57.1% to 33.9% of sessions. The funnel's revenue stage did not move:
zero purchases for a second straight week, and every purchase start in both
weeks ended cancelled (2/2 this week, 5/5 last week).

Registered users (FinalCap DB `users`): **812 total** (was 662), **148**
created in the window (was 68), 3 flagged with a subscription (unchanged).

## 2. Purchases — three ledgers, kept separate

### App Store (ledger of record for iOS sales)
**0 purchases in the window.** The server-verified `apple_transactions`
table still holds exactly **one row all-time**: Pro Monthly
(`com.ragnus.w2.subscription.monthly`), created Oct 24 20:32:38, expires
Nov 24 21:10:34. No transaction was created Nov 9 – Nov 15.

The App Store Connect sales mirror (`asc_sales_mirror`, app 6815060815)
agrees: 25 rows in the window, all $0.00 proceeds — 8 free downloads (1F)
and 17 free-subscription units (7F). **Zero paid subscription rows.** The
17 free-subscription units (vs 12 last week) still sit oddly against the
plan's "no trial" product fact, and the ASC check on the Nov 3–5 units
flagged in the last packet is still open — the tracked item still reads
"Waiting for the ASC check on the 12 free-sub units from Nov 3–5". The
mirror's last successful sync was Nov 16 11:31:05 UTC (status ok) and its
rows run through Nov 14 only; Nov 15 is still subject to Apple's posting
lag, so a Nov 15 sale could still appear. App Store Connect's own posted
figures remain the system of record.

### Stripe (web sales ledger)
**No completed FinalCap web purchase is recorded for the window.** The only
Stripe-sourced entitlement in FinalCap's DB remains a GBK Compose Pro
Yearly (created Oct 31, outside the window) — not a FinalCap sale. A direct
read of the Stripe account was not possible for this packet — the Stripe
connection is not active in this environment — so this line rests on the
app's own records. A completed web purchase does not appear in app
telemetry, so telemetry can never prove a Stripe negative on its own; if the
Stripe connection is restored, this line should be re-checked against it.

### Telemetry (event counts — not a sales ledger)
**0** `purchase_success` events and **0** `trial_start` events in the
window — and 0 all-time for `app = 'finalcap'`. Telemetry counts events the
app emitted, not money. It is shown only to corroborate the funnel and is
never added to either sales ledger.

**Instrumentation gap (still open):** FinalCap's iOS app has never emitted
a `purchase_success` event to the shared telemetry table, even though the
Oct 24 monthly purchase exists in `apple_transactions` and 2 purchase
starts reached the paywall flow this week. If a purchase ever succeeds
in-app, the funnel's revenue stage will not see it. Before any ad spend,
verify `purchase_success` fires on a real purchase (sandbox or the next
live one) — otherwise ASA ROI cannot be measured in the funnel and must be
read from ASC alone.

Admin-panel cross-check: not available this run. An anonymous fetch of
https://photo.grepawk.com/admin/analytics returns the public app shell; the
funnel data loads behind the authenticated admin session, which this run
does not have. The DB reads above are the same source the panel reads.

## 3. Apple Search Ads state — read-only (Nov 16, 2026)

- **Apple Ads Advanced account: does not exist yet.** Account creation +
  payment at ads.apple.com is the user's step; nothing spends until then.
  The tracked ASA item still reads "Budget set to $20/day; still waiting
  for Apple Ads Advanced account creation + payment to launch."
- **Campaigns: none created.** Brand / Category exact / Competitors exact /
  Discovery exist only as a plan
  (`~/workspace/finalcap-v101/apple-search-ads-plan.md`).
- **Spend / installs / purchases: $0 / none.** The decision log
  (`ads-decision-log.md`) does not exist yet — it starts the day spend
  starts.
- Nothing was created, edited, paused, or unpaused in preparing this packet.
  The Meta route stays parked (it needs a SKAdNetwork build that was never
  built); Meta ads state was not checked.

## 4. Verdict: STAY DARK

The math, on this week's own numbers:

- A launch at the decided **$20/day = $140/week**. The funnel produced
  **0 purchases this week at $0 of ad spend**, with paywall→purchase at
  **0% (0/51)** and 62 sessions/week.
- Month-1 break-even needs CPA ≤ **$8.49** net. At $140/week that requires
  **~16.5 purchases/week** — against an organic baseline of zero.
- The 6-month ceiling CPA is **~$51**. At $140/week that still requires
  **~2.7 purchases/week** — against an organic baseline of zero, on 51
  paywall views/week.
- The **$200 zero-purchase tripwire** would be hit after **10 days** at
  $20/day with no purchase.
- This week's growth strengthens, not weakens, the case: sessions +77% and
  paywall views +89%, yet purchases stayed at 0 on a larger denominator
  (0/51 vs 0/27 last week), and every purchase start again ended cancelled.
  The added volume is sessions that see the paywall without editing — paid
  traffic would amplify paywall exposure, not purchases. One purchase is
  worth $9.99/mo gross — $8.49 net at the 15% Small Business rate. There is
  no trial funnel for spend to amplify (trial starts 0 by design).

Two separate gates block a launch, and both must clear: (1) the Apple Ads
account does not exist yet — that is the user's step at ads.apple.com,
followed by campaigns built to spec and read back, activated only on his go
word; (2) on the numbers, a $20/day launch into a 0%-converting paywall at
62 sessions/week cannot pencil out even once the account exists. Launching
before the funnel converts would spend the $200 tripwire learning what this
week already shows for free.

**Revisit triggers** (any one reopens the question at a future weekly
review):
1. The Apple Ads account exists and the four campaigns are built to spec
   and read back.
2. Paywall→purchase conversion reaches 10%+ over a complete week
   (~5 purchases/week at the current 51 paywall views — above the ~2.7/week
   pace the 6-month CPA ceiling implies).
3. The `purchase_success` telemetry gap is closed, so ASA ROI is measurable
   in the funnel, not only in ASC.
4. Editor engagement grows with sessions (editor opens / edit successes
   rising, not just sessions that hit the paywall) — this week's growth was
   paywall-only, so a sessions-only recovery does not reopen the question.

Until then, spend stays at $0 and nothing launches.
