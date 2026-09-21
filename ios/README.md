# FinalCut iOS

Native SwiftUI shell for FinalCut (iOS 17+).

## Open in Xcode

1. Clone this repo (or open the `ios/` folder from a checkout).
2. Open `ios/FinalCut.xcodeproj` in Xcode 15+.
3. Select the **FinalCut** scheme and an iOS 17+ simulator or device.
4. Build & Run (`Cmd+R`).

## Configuration

| Setting | Value |
|--------|--------|
| Bundle ID | `com.grepawk.finalcut` |
| Deployment target | iOS 17.0 |
| Default API base URL | `https://grepawk.com` |

Override the API base URL at runtime via `APIConfig.shared.baseURL` (or set it before first network use).

## Auth (mobile) — Backend PR #46

Primary auth is **Bearer access token** (web cookie sessions unchanged on the server).

### Client contract

```http
POST /api/auth/mobile/google
Content-Type: application/json

{ "idToken": "<Google ID token from Google Sign-In SDK>" }
```

```json
{
  "accessToken": "...",
  "expiresIn": 2592000000,
  "tokenType": "Bearer",
  "user": { "email": "...", "name": "...", "hasSubscription": false }
}
```

Then attach on API calls:

```http
Authorization: Bearer <accessToken>
```

Bearer is used for: `/api/chat`, `/api/process-video`, `/api/transition-videos`, captions (`/api/generate-captions*`, `/api/translate-captions`), and `/api/auth/status` (status may include `authMethod: "bearer"`).

### Production deploy requirements

For mobile Google Sign-In to work against prod you need:

1. **`GOOGLE_IOS_CLIENT_ID`** set on the server (iOS OAuth client ID used as ID-token audience), in addition to existing `GOOGLE_CLIENT_ID`.
2. **Deploy of Backend PR #46** (or equivalent) so `api_tokens` exists and `POST /api/auth/mobile/google` + Bearer middleware are live.
3. Restart so `initDatabase` creates the `api_tokens` table.

Without those, the iOS client still builds; auth calls will fail until Backend ships.

### Sample mode (DEBUG only)

- Header `sample-access-token` from `GET /api/sample-access-token`.
- Attached only in **DEBUG** builds when the demo/sample flag is on — **not** primary auth.
- Cookie jar (`HTTPCookieStorage`) is optional/temporary; do **not** rely on it as primary.

Sign-in UI placeholder: Google vs Apple still open (Apple is phase 2). Paywall: StoreKit placeholder vs Stripe still open.

## Architecture (v1)

- **Preview playback + scrub**: AVKit / AVFoundation only.
- **Edits / processing**: existing Node + server FFmpeg APIs (`/api/chat`, `/api/process-video`, captions, transitions).
- **No on-device FFmpeg** in v1.
- Future poll jobs use `JobStatus`: `queued` | `running` | `succeeded` | `failed` (Backend phase 2).

## Screens (Design names)

1. Landing  
2. SignIn  
3. Paywall  
4. Editor — single root (TopBar → Preview → Chat → SampleChips → Composer)  
5. ExportSheet  

Editor states: `empty` | `uploading` | `ready` | `processing` | `failed`.

## Tests

Run unit tests from Xcode (`Cmd+U`) or:

```bash
xcodebuild test -project FinalCut.xcodeproj -scheme FinalCut -destination 'platform=iOS Simulator,name=iPhone 16'
```

`FinalCutTests` covers API URL construction and model decoding (auth status, mobile Google response, sample token, Bearer header).
