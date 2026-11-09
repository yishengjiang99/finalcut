# FinalCap steering packet — Monday, November 9, 2026

**Period covered:** Monday Nov 2 – Sunday Nov 8, 2026 (Pacific), the 7 most
recent complete days before Nov 9. Today (Nov 9) is a partial day and is
excluded, per the canonical funnel rule. Data pulled Nov 9, 2026. All
telemetry is filtered to FinalCap only (`app = 'finalcap'`); the telemetry
table is shared with other apps and unfiltered reads are never used. This is
the first FinalCap edition; there is no previous packet to compare against,
so the prior 7 days (Oct 26 – Nov 1) are shown below as an informal baseline
only, not a packet window.

## 1. FinalCap funnel (canonical, session-based)

| Stage | Sessions | Conversion |
|---|---|---|
| Sessions (any event) | 35 | — |
| App open | 32 | 91.4% of sessions |
| Editor open | 20 | 57.1% of sessions; 62.5% of app opens |
| Edit start | 18 | 90.0% of editor opens |
| Edit success | 15 | 83.3% of edit starts |
| Export start | 5 | 33.3% of edit successes |
| Export success | 5 | 100% of export starts |

Revenue stages, same window (distinct sessions): paywall view 27 → plan
select 5 → purchase start 5 → purchase cancelled 5 → **purchase success
0**. Paywall→purchase **0% (0/27)**; sessions→purchase **0% (0/35)**. Trial
starts: **0** (zero by design — FinalCap has no trial product; flag loudly
if ever nonzero). Edit errors: 4 sessions. Restore taps: 4 sessions.

Daily sessions in the window: Nov 2: 7, Nov 3: 4, Nov 4: 5, Nov 5: 8,
Nov 6: 3, Nov 7: 4, Nov 8: 4. Steady low volume, no single-day spike.

Like-for-like context (informal baseline, Oct 26 – Nov 1): 97 sessions →
96 app opens → 28 editor opens → 25 edit starts → 24 edit successes →
10 export starts → 9 export successes; paywall view 75 → plan select 2 →
purchase start 2 → purchase cancelled 2 → purchase success 0. Sessions fell
64% week over week (97 → 35) while editor-open share rose (28.9% → 57.1%
of sessions) — fewer, deeper sessions. The funnel's revenue stage did not
move: zero purchases in both weeks, and every purchase start in both weeks
ended cancelled (5/5 this week, 2/2 last week).

Registered users (FinalCap DB `users`): **662 total**, 68 created in the
window, 3 flagged with a subscription.

## 2. Purchases — three ledgers, kept separate

### App Store (ledger of record for iOS sales)
**0 purchases in the window.** The server-verified `apple_transactions`
table holds exactly **one row all-time**: Pro Monthly
(`com.ragnus.w2.subscription.monthly`), created Oct 24 20:32:38, expires
Nov 24 21:10:34. No transaction was created Nov 2 – Nov 8.

The App Store Connect sales mirror (`asc_sales_mirror`, app 6815060815)
agrees: 19 rows in the window, all $0.00 proceeds — 7 free downloads (1F)
and 12 free-subscription units (7F, Nov 3–5). **Zero paid subscription
rows.** The 12 free-subscription units are not purchases; they are ASC's
free-subscription product type, and they sit oddly against the plan's "no
trial" product fact — worth a look at what offer, if any, the monthly
product carries in ASC. The mirror's last successful sync was Nov 9
11:26:50 UTC (status ok) and its rows run through Nov 7 only; Nov 8 is
still subject to Apple's posting lag, so a Nov 8 sale could still appear.
App Store Connect's own posted figures remain the system of record.

Correction to prior notes: a Nov 8 note credited FinalCap telemetry with 12
`purchase_success` events / 9 sessions and a fresh Nov 8 iOS monthly
purchase. Direct reads today do not corroborate either: the 12
`purchase_success` and 5 `trial_start` events in the shared telemetry table
belong to `app = 'photo-recipes'` (ProTune), not FinalCap, and no Nov 8
transaction exists in `apple_transactions` or the ASC mirror. Do not carry
those figures forward as FinalCap's.

### Stripe (web sales ledger)
**No completed FinalCap web purchase is recorded for the window.** The only
Stripe-sourced entitlement in FinalCap's DB is a GBK Compose Pro Yearly
(created Oct 31, outside the window) — not a FinalCap sale. A direct read
of the Stripe account was not possible for this packet — the Stripe
connection is not active in this environment — so this line rests on the
app's own records. A completed web purchase does not appear in app
telemetry, so telemetry can never prove a Stripe negative on its own; if the
Stripe connection is restored, this line should be re-checked against it.

### Telemetry (event counts — not a sales ledger)
**0** `purchase_success` events and **0** `trial_start` events in the
window — and 0 all-time for `app = 'finalcap'`. Telemetry counts events the
app emitted, not money. It is shown only to corroborate the funnel and is
never added to either sales ledger.

**Instrumentation gap (flagged, not assumed away):** FinalCap's iOS app has
never emitted a `purchase_success` event to the shared telemetry table, even
though the Oct 24 monthly purchase exists in `apple_transactions` and 5
purchase starts reached the paywall flow this week. If a purchase ever
succeeds in-app, the funnel's revenue stage will not see it. Before any ad
spend, verify `purchase_success` fires on a real purchase (sandbox or the
next live one) — otherwise ASA ROI cannot be measured in the funnel and
must be read from ASC alone.

Admin-panel cross-check: not available this run. An anonymous fetch of
https://photo.grepawk.com/admin/analytics returns the public app shell; the
funnel data loads behind the authenticated admin session, which this run
does not have. The DB reads above are the same source the panel reads.

## 3. Apple Search Ads state — read-only (Nov 9, 2026)

- **Apple Ads Advanced account: does not exist yet.** Account creation +
  payment at ads.apple.com is the user's step; nothing spends until then.
  The tracked ASA item still reads "waiting for Apple Ads Advanced account
  creation + payment to launch."
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
  **0% (0/27)** and 35 sessions/week.
- Month-1 break-even needs CPA ≤ **$8.49** net. At $140/week that requires
  **~16.5 purchases/week** — against an organic baseline of zero.
- The 6-month ceiling CPA is **~$51**. At $140/week that still requires
  **~2.7 purchases/week** — against an organic baseline of zero, on 27
  paywall views/week.
- Even the ProTune packet's optimistic case (ads doubling purchases) has
  nothing to double here: 2 × 0 = 0. The $200 zero-purchase tripwire would
  be hit after **10 days** at $20/day with no purchase.
- One purchase is worth $9.99/mo gross — $8.49 net at the 15% Small Business
  rate. There is no trial funnel for spend to amplify (trial starts 0 by
  design), and every purchase start this week ended cancelled.

Two separate gates block a launch, and both must clear: (1) the Apple Ads
account does not exist yet — that is the user's step at ads.apple.com,
followed by campaigns built to spec and read back, activated only on his go
word; (2) on the numbers, a $20/day launch into a 0%-converting paywall at
35 sessions/week cannot pencil out even once the account exists. Launching
before the funnel converts would spend the $200 tripwire learning what this
week already shows for free.

**Revisit triggers** (any one reopens the question at a future weekly
review):
1. The Apple Ads account exists and the four campaigns are built to spec
   and read back.
2. Paywall→purchase conversion reaches 10%+ over a complete week
   (~2.7 purchases/week at current paywall volume — right at the 6-month
   CPA ceiling).
3. The `purchase_success` telemetry gap is closed, so ASA ROI is measurable
   in the funnel, not only in ASC.
4. Sessions recover materially (e.g. back above ~100/week) so there is a
   base for paid traffic to amplify.

Until then, spend stays at $0 and nothing launches.
