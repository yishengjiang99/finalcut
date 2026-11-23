# FinalCap steering packet — Monday, November 23, 2026

**Period covered:** Monday Nov 16 – Sunday Nov 22, 2026 (Pacific), the 7 most
recent complete days before Nov 23. Today (Nov 23) is a partial day and is
excluded, per the canonical funnel rule. Data pulled Nov 23, 2026. All
telemetry is filtered to FinalCap only (`app = 'finalcap'`); the telemetry
table is shared with other apps and unfiltered reads are never used.

## 1. FinalCap funnel (canonical, session-based)

| Stage | Sessions | Conversion |
|---|---|---|
| Sessions (any event) | 17 | — |
| App open | 16 | 94.1% of sessions |
| Editor open | 9 | 52.9% of sessions; 56.3% of app opens |
| Edit start | 8 | 88.9% of editor opens |
| Edit success | 8 | 100% of edit starts |
| Export start | 6 | 75.0% of edit successes |
| Export success | 6 | 100% of export starts |

Revenue stages, same window (distinct sessions): paywall view 8 → plan
select 0 → purchase start 0 → purchase cancelled 0 → **purchase success
0**. Paywall→purchase **0% (0/8)**; sessions→purchase **0% (0/17)**. Trial
starts: **0** (zero by design — FinalCap has no trial product; flag loudly
if ever nonzero). Edit errors: 3 sessions. Restore taps: 1 session.
Paywall triggers: 9 sessions.

Daily sessions in the window: Nov 16: 2, Nov 17: 1, Nov 18: 1, Nov 19: 6,
Nov 20: 3, Nov 21: 3, Nov 22: 1. Paywall views by day: Nov 16: 1, Nov 17: 1,
Nov 18: 1, Nov 19: 2, Nov 20: 0, Nov 21: 2, Nov 22: 1.

Like-for-like vs the previous packet's window (Nov 9 – Nov 15): sessions
62 → 17 (−73%); app opens 62 → 16; editor opens 21 → 9; edit starts
21 → 8; edit successes 24 → 8; export starts 4 → 6; export successes
4 → 6; paywall views 51 → 8 (−84%); plan selects 2 → 0; purchase starts
2 → 0; purchase cancelled 2 → 0; purchase success 0 → 0.

What moved: volume collapsed after last week's spike — the Nov 10 + Nov 13
paywall-heavy surge did not persist. The shape of the smaller funnel is
healthier: editor-open share recovered from 33.9% to 52.9% of sessions,
edit success ran 8/8 on edit starts, and exports rose to 6 (from 4) on far
fewer sessions. The revenue stage did not move at all: zero purchases for a
third straight week, and this week the funnel never even reached a
purchase start (0 starts, vs 2 last week and 5 the week before — every one
of those earlier starts ended cancelled).

Registered users (FinalCap DB `users`): **840 total** (was 812), **30**
created in the window (was 148), 4 flagged with a subscription (was 3).
The subscription-flag count rose by one with no matching new row in
`apple_transactions` or `product_entitlements` this week; neither sales
ledger corroborates a new purchase, so the flag change is reported as-is
and not counted as a sale anywhere below.

## 2. Purchases — three ledgers, kept separate

### App Store (ledger of record for iOS sales)
**0 purchases in the window.** The server-verified `apple_transactions`
table still holds exactly **one row all-time**: Pro Monthly
(`com.ragnus.w2.subscription.monthly`), created Oct 24 20:32:38, expires
Nov 24 21:10:34. No transaction was created Nov 16 – Nov 22. (Note: that
one all-time subscription reaches its recorded expiry on Nov 24; no
renewal transaction has been recorded yet.)

The App Store Connect sales mirror (`asc_sales_mirror`, app 6815060815)
agrees: 8 rows in the window, all $0.00 proceeds — 5 free downloads (1F,
5 units), 3 free-subscription units (7F), and 1 unit of product type 3F.
**Zero paid subscription rows.** The free-subscription units (3 this week,
vs 17 last week) still sit oddly against the plan's "no trial" product
fact, and the ASC check on the Nov 3–5 units flagged two packets ago is
still open. The mirror's last successful sync was Nov 23 11:27:15 UTC
(status ok) and its rows run through Nov 21 only; Nov 22 is still subject
to Apple's posting lag, so a Nov 22 sale could still appear. App Store
Connect's own posted figures remain the system of record.

### Stripe (web sales ledger)
**No completed FinalCap web purchase is recorded for the window.** The only
Stripe-sourced entitlement in FinalCap's DB remains a GBK Compose Pro
Yearly (created Oct 31, outside the window) — not a FinalCap sale. A direct
read of the Stripe account was not possible for this packet — the Stripe
connection is not active in this environment — so this line rests on the
app's own records. A completed web purchase does not appear in app
telemetry, so telemetry can never prove a Stripe negative on its own; if
the Stripe connection is restored, this line should be re-checked against
it.

### Telemetry (event counts — not a sales ledger)
**0** `purchase_success` events and **0** `trial_start` events in the
window — and 0 all-time for `app = 'finalcap'`. Telemetry counts events
the app emitted, not money. It is shown only to corroborate the funnel and
is never added to either sales ledger.

**Instrumentation gap (still open):** FinalCap's iOS app has never emitted
a `purchase_success` event to the shared telemetry table, even though the
Oct 24 monthly purchase exists in `apple_transactions`. If a purchase ever
succeeds in-app, the funnel's revenue stage will not see it. Before any ad
spend, verify `purchase_success` fires on a real purchase (sandbox or the
next live one) — otherwise ASA ROI cannot be measured in the funnel and
must be read from ASC alone.

Admin-panel cross-check: not available this run. An anonymous fetch of
https://photo.grepawk.com/admin/analytics returns the public app shell;
the funnel data loads behind the authenticated admin session, which this
run does not have. The DB reads above are the same source the panel reads.

## 3. Apple Search Ads state — read-only (Nov 23, 2026)

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
- Nothing was created, edited, paused, or unpaused in preparing this
  packet. The Meta route stays parked (it needs a SKAdNetwork build that
  was never built); Meta ads state was not checked.

## 4. Verdict: STAY DARK

The math, on this week's own numbers:

- A launch at the decided **$20/day = $140/week**. The funnel produced
  **0 purchases this week at $0 of ad spend**, with paywall→purchase at
  **0% (0/8)** and 17 sessions/week.
- Month-1 break-even needs CPA ≤ **$8.49** net. At $140/week that requires
  **~16.5 purchases/week** — against an organic baseline of zero, on
  8 paywall views/week.
- The 6-month ceiling CPA is **~$51**. At $140/week that still requires
  **~2.7 purchases/week** — against an organic baseline of zero.
- The **$200 zero-purchase tripwire** would be hit after **10 days** at
  $20/day with no purchase.
- This is the third straight week with zero purchases in every ledger.
  This week's funnel is smaller but deeper (52.9% editor-open share,
  8/8 edit success, 6 exports) — the product side is working for the few
  users who arrive; what is missing is any evidence the paywall converts
  at all. There were not even purchase starts this week. One purchase is
  worth $9.99/mo gross — $8.49 net at the 15% Small Business rate. There
  is no trial funnel for spend to amplify (trial starts 0 by design).

Two separate gates block a launch, and both must clear: (1) the Apple Ads
account does not exist yet — that is the user's step at ads.apple.com,
followed by campaigns built to spec and read back, activated only on his
go word; (2) on the numbers, a $20/day launch into a 0%-converting paywall
at 17 sessions/week cannot pencil out even once the account exists.
Launching before the funnel converts would spend the $200 tripwire
learning what three weeks already show for free.

**Revisit triggers** (any one reopens the question at a future weekly
review):
1. The Apple Ads account exists and the four campaigns are built to spec
   and read back.
2. Paywall→purchase conversion reaches 10%+ over a complete week (at this
   week's 8 paywall views that pace is not yet reachable — the ~2.7/week
   pace the 6-month CPA ceiling implies needs both more paywall volume
   and a first conversion).
3. The `purchase_success` telemetry gap is closed, so ASA ROI is
   measurable in the funnel, not only in ASC.
4. Editor engagement keeps growing with sessions (this week's deeper
   funnel shape holding as volume recovers) — a sessions-only recovery
   without conversion does not reopen the question.

Until then, spend stays at $0 and nothing launches.
