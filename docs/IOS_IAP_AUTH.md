# iOS authentication and StoreKit entitlement flow

iOS does not use the web Google OAuth cookie. Each install creates a random UUID and stores it in the Keychain. It is an app-scoped install identifier, not a hardware identifier or an advertising identifier.

1. At launch, the app calls `POST /api/auth/mobile/device` with that UUID.
2. The server creates or finds the anonymous install user and returns an opaque Bearer token.
3. The app sends that token on inference requests and calls `GET /api/auth/status` to refresh the server-side entitlement state.
4. StoreKit purchases include the install UUID as `appAccountToken`.
5. The app sends the verified StoreKit transaction's `jwsRepresentation` to `POST /api/auth/mobile/apple-iap`.
6. The server verifies the JWS with Apple's App Store Server Library, checks the bundle/product/expiry/revocation fields, records the original transaction, and sets `users.has_subscription = true`.

The inference middleware remains shared: it accepts either a web Passport session, a Google mobile Bearer user, an Apple IAP install Bearer user, or the existing debug sample token. The client never gets to set `has_subscription` directly.

Unsubscribed iOS installs receive `IOS_FREE_DAILY_INFERENCE_LIMIT` inference-starting requests per UTC day (default: 3). The server returns `dailyLimit`, `dailyUsed`, and `dailyRemaining` from `/api/auth/status`; premium users bypass this quota. Job polling and result downloads do not consume quota. Set `FREE_EDITS_IOS=unlimited` to turn the limit off for iOS clients (see [`docs/api/FREE_EDITS_IOS.md`](api/FREE_EDITS_IOS.md)).

## Server configuration

Set these on the API server:

```dotenv
APPLE_IAP_BUNDLE_ID=com.ragnus.w2
APPLE_IAP_PRODUCT_ID=com.ragnus.w2.subscription.monthly
# Optional overrides — the defaults below are compiled in:
# APPLE_IAP_ENVIRONMENT=Production        (pin one verifier environment)
# APPLE_IAP_APPLE_ID=6815060815           (FinalCap's app id; required for Production)
# APPLE_IAP_ROOT_CERTS_BASE64=<...>       (replace the bundled Apple Root CAs)
```

The Apple Root CA certificates are public trust anchors (published by Apple
at apple.com/certificateauthority), not secrets: they are bundled in
`src/server/apple-root-cas.js` so verification works without any env setup.
`APPLE_IAP_ROOT_CERTS_BASE64` remains as an override. (History: when the roots
came only from that env var and production never set it, every verification
returned `503` and no purchase was ever recorded.)

Unless `APPLE_IAP_ENVIRONMENT` is pinned, the verifier environment is chosen
per transaction from the JWS `environment` claim, so App Store (Production)
and TestFlight (Sandbox) purchases both verify. Pin
`APPLE_IAP_ENVIRONMENT=Xcode` for local StoreKit Configuration testing.

An install UUID is intentionally not a durable cross-device account. StoreKit restore can re-associate an already verified original transaction with a new install; a fresh transaction must carry the current install's `appAccountToken`.
