# FinalCap — StoreKit / IAP plan

## Products (created in ASC by `scripts/asc/create_subscriptions.py`, workflow "ASC create subscriptions (FinalCap Pro)")

| Product ID | Type | Notes |
|------------|------|--------|
| `com.ragnus.w2.subscription.monthly` | Auto-renewable, group `FinalCap Pro`, name `FinalCap Pro Monthly`, 1 month, USD 9.99 equalized to all territories, level 1, Family Sharing off, no trial | Primary v1 |

Optional later: yearly, lifetime — only after monthly path works E2E.

## Client

- StoreKit 2 (`Product.products`, `purchase`, `Transaction.currentEntitlements`)  
- Paywall: Subscribe + **Restore**  
- Local config: `ios/FinalCut/StoreKit/FinalCut.storekit`  
- Never open Stripe Checkout / SFSafariViewController for digital unlock

## Server

- Verify transactions (App Store Server API) before granting Pro  
- Entitlement table must accept **Apple** and **Stripe (web)** without cross-unlocking incorrectly  
- Gate export / heavy jobs in API according to product rules

## ASC checklist

- [ ] Paid Apps Agreement / banking / tax active  
- [ ] Subscription group created  
- [ ] Pricing + localization  
- [ ] Product Cleared for Sale and submitted **with** the iOS version  
- [ ] Sandbox testers for Review + internal  

## Review

Sandbox account in Review notes if IAP is required to reach core editor features. Prefer a Review-comp entitlement if the free tier cannot demo captions/export.

## Paywall (guideline 3.1.2)

`ios/FinalCut/Features/Paywall/PaywallView.swift` shows the plan title, `displayPrice / month` and duration from StoreKit,
Subscribe, Restore Purchases, the auto-renew notice, and Terms of Use (Apple standard EULA) + Privacy Policy
(https://grepawk.com/legal/privacy.html) links. Empty products: automatic retries, then a message + Try Again.
Review screenshot: `docs/asc/review/subscription-paywall.png` (workflow "iOS simulator screenshots (paywall review shot)").
Submit: workflow "ASC submit version + first subscription (FinalCap)" (status / cancel / submit).
