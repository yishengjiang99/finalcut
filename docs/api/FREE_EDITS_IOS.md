# Free edits on iOS: `FREE_EDITS_IOS`

Server switch for the iOS free daily limit. The web paywall and Stripe are unaffected.

| `FREE_EDITS_IOS` | Behavior |
|---|---|
| `unlimited` (case-insensitive) | iOS clients are never blocked by the free daily limit or the "subscription required" check, and never get a quota or paywall error. Usage is still counted. |
| unset, or any other value | Today's behavior: unsubscribed iOS installs get `IOS_FREE_DAILY_INFERENCE_LIMIT` inference requests per UTC day (default 3). |

The server reads it from the process environment (the app's `.env` or the systemd unit), so
changing it takes a **restart** (`sudo systemctl restart finalcut`), not a code change. No quota
code is removed. Turning it off brings the old limit back.

## Who counts as an iOS client

Implemented in `src/server/clientInfo.js` (`isIosClient`):

1. Requests authenticated with the **mobile Bearer token** (`Authorization: Bearer <accessToken>`
   from `POST /api/auth/mobile/device`, or from `/api/auth/mobile/google`; PR #46). Every iOS build uses this,
   including **build 9 and earlier**, which send the default URLSession User-Agent
   (`FinalCap/<build> CFNetwork/…`), not `FinalCap-iOS/*`.
2. Requests with a `FinalCap-iOS/<build>` User-Agent (builds ≥ 10) that are **not** a web cookie
   session.

Web users are never iOS clients. The web app authenticates with the Google OAuth **cookie session**
(`req.authMethod === "session"`) and never sends a Bearer token. A cookie-session request is
treated as web even if it spoofs a `FinalCap-iOS` User-Agent, so the web "Active subscription
required" (403) paywall is unchanged. The `sample-access-token` path (web demo, iOS DEBUG
builds) was already exempt from quota and is unchanged.

Metered routes (all behind `requireInferenceAccess`): `POST /api/chat` (every request,
including each `execution:"client"` round), `/api/process-video`, `/api/jobs/process-video`,
`/api/transition-videos`, `/api/generate-captions`, `/api/generate-captions-diarized`, and
`/api/translate-captions`.

## Responses with `FREE_EDITS_IOS=unlimited` (iOS client)

`GET /api/auth/status` (Bearer) is what the app reads for the "N free left" label:

```json
{
  "authenticated": true,
  "authMethod": "bearer",
  "user": { "id": "7", "name": "iOS device", "hasSubscription": false },
  "unlimited": true,
  "dailyLimit": null,
  "dailyUsed": 3,
  "dailyRemaining": null,
  "dailyResetsAt": "2026-09-27T00:00:00.000Z"
}
```

- `unlimited: true`: new field.
- `dailyLimit` / `dailyRemaining`: `null`. The fields are kept so older builds still decode
  (they are `Int?`). Build 9 shows "N free left" only when `dailyRemaining` is non-null, so it
  hides the label instead of showing "0 free left".
- `dailyUsed`: the real count for today (UTC).
- Subscribers get the same response as before (no quota fields).

Metered routes never return `429 daily_limit_reached` or `403 Active subscription required` to
an iOS client. Build 9 opens the paywall only on HTTP 402, `code: "paywall"`,
`code: "daily_limit_reached"`, or a 403 containing "subscription required". They add these headers:
`X-Inference-Unlimited: true` and `X-Inference-Daily-Used: <count>`.

With the variable unset, every response is exactly as before (numeric `dailyLimit`,
`dailyUsed`, `dailyRemaining`, and 429 at the limit).

## Usage numbers while unlimited

- Metered requests from an iOS user increment `daily_inference_usage.inference_count`
  with no cap (`recordDailyInference`). Counting errors are logged and never block the request.
- Counting follows the same per-edit-turn rule as the limit: a client-mode continuation that
  echoes a valid `turnToken`, and a media-route run with valid `X-Turn-Token` +
  `X-Tool-Call-Id`, are not counted. See the "Auth and quota" section of
  [`CLIENT_TOOL_EXECUTION.md`](./CLIENT_TOOL_EXECUTION.md).
- Client-mode chat final answers are logged (`chat_interactions`, `ai2human`) with
  `metadata: { execution: "client", toolRounds, okToolResults, editTurnCompleted, iosClient }`.
  `editTurnCompleted` is true when the turn applied at least one tool with `ok: true` on the
  device. That counts completed on-device edit turns for when a limit returns.

## When the limit is on (variable unset)

- The limit is enforced atomically: `consumeDailyInference` only increments while
  `inference_count < IOS_FREE_DAILY_INFERENCE_LIMIT` (default 3), so at most that many
  charged requests succeed per user per UTC day, even when they arrive concurrently.
- Client-mode chat is charged once per edit turn (`turnToken`, see above). Server-mode
  streaming chat is still charged per request. Media routes (jobs, sync processing,
  captions) are charged per request unless they carry a valid `X-Turn-Token` +
  `X-Tool-Call-Id` from the current turn.
- `turnToken` is an HMAC-signed token keyed by `TURN_TOKEN_SECRET`, falling back to
  `SESSION_SECRET` (and a random per-process key if neither is set, which invalidates
  tokens on restart). One-time redemption is tracked in memory, so this assumes a single
  server instance.
