# FinalCap — StoreKit / IAP plan

## Products (placeholders — create in ASC)

| Product ID | Type | Notes |
|------------|------|--------|
| `com.grepawk.finalcut.subscription.monthly` | Auto-renewable | Primary v1 |

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
