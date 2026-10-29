# FinalCut (FinalCap)

Chat-driven video editing. The user describes an edit in plain language; an LLM
plans it as a sequence of tool calls; the client — a web editor or the iOS app —
executes those tools locally against the real media and reports the results
back. The model never touches the video directly, and the server never renders
what the client can render itself.

Live on the web at [grepawk.com](https://grepawk.com) and on the App Store as
**FinalCap - AI Video Editor**.

## How an edit works

1. The client sends the chat turn plus a snapshot of the current project
   (clips, trims, effects, timeline state) to `POST /api/chat`.
2. The server builds the tool schema for that client — `src/server/toolsSchema.js`,
   filtered per platform and per app build by `src/server/iosToolAllowlist.js`
   (tools carry `minBuild` / `maxBuild` gates, so new capabilities roll out and
   retire without an app update).
3. Grok (xAI API) answers with tool calls. The server validates them against
   the schema and the project snapshot, then returns them for **client-side
   execution** — native AVFoundation tools on iOS, ffmpeg.wasm in the browser.
4. Tool results flow back into the same turn for up to 6 rounds
   (`MAX_TOOL_ROUNDS`), so one message can chain: trim → captions → translate →
   soundtrack. A signed turn token is issued per turn and each tool charge is
   counted exactly once against it.

Timeline mutations are revisioned: every edit carries the project revision it
was planned against plus an idempotency key, and multi-step changes can be
batched (`batch_timeline_edits`), so a retry or a stale plan can't corrupt the
project or double-apply an edit.

## Core technology

**Agentic tool layer** (`src/server/`)
The contract between model and media: ~32 editing tools declared once on the
server and implemented natively per client. The same schema endpoint
(`/api/tools/schema`) feeds the web client, the iOS client, and a post-deploy
contract check that fails the deploy if the served schema drifts from what the
shipped apps expect.

**In-browser rendering** (web editor, `src/`)
React 18 + Vite. Editing runs on a multithreaded **ffmpeg.wasm** core
(`public/v2/ffmpeg-core/mt/…`, served with COOP/COEP headers so
`SharedArrayBuffer` is available) — cuts, filters, transitions, and exports
happen on the user's machine. Native server FFmpeg (`fluent-ffmpeg`,
`src/server/ffmpegOps.js`) exists as a fallback for operations the wasm build
can't do. The editor UI is a chat panel with a timeline docked to the active
clip: filmstrip, ruler, playhead scrubbing, and trim handles.

**iOS engine** (`ios/FinalCut/`)
Swift + AVFoundation. A timeline project model (multiple clips, transitions,
per-clip effects, audio) rendered by a custom `AVVideoCompositor`
(`ProjectComposer`); cut-only projects take a simpler closure-based
composition path. The native tool executors mirror the server schema, so chat
edits, manual timeline edits, preview, and export all operate on one project
document that persists across launches.

**Captions and translation** (`src/server/captions.js`)
Speech-to-text via Whisper (`whisper-1`, verbose JSON for word timing),
translation, and timed caption rendering in the client. Live-caption paths are
covered by Playwright end-to-end tests against fixtures.

**Soundtrack**
A chat tool fetches audio with `yt-dlp` on the server, returns AAC, and the
client mixes it under the original audio with `AVAudioMix` (iOS) or the wasm
pipeline (web), trimmed to the video from a user-set start offset.

**Accounts and billing** (kept deliberately thin in this README)
Express session auth, Stripe on the web, StoreKit + the App Store Server
Library on iOS, one MySQL database. Free-tier edit caps are enforced server-side
per turn token.

**Telemetry**
Both clients emit anonymous product events (install ID + session ID, no user
content) to `/api/telemetry`. Anonymous telemetry is still data collection:
the App Privacy answers declare Device ID + Product Interaction for Analytics,
not linked to identity and not used for tracking.

## Repository layout

| Path | What lives there |
| --- | --- |
| `src/` | Web editor (React) and the client execution runtime |
| `src/server/` | Express API: chat loop, tool schema, captions, billing, jobs |
| `ios/` | The FinalCap iOS app (Swift, Xcode project, tests) |
| `scripts/asc/` | App Store Connect automation (TestFlight, listing, submit) |
| `docs/` | Specs, listing copy, funnel and ads decision records |
| `blog/` | The grepawk.com blog (markdown, one folder per post) |

## Development

```bash
npm install
npm run dev          # client + server together
npm run dev:client   # Vite only
npm run dev:server   # API only
npm test             # vitest
npm run ios          # iOS project helpers
```

Configuration is via `.env` (see `.env.example`): an xAI API token, MySQL,
Stripe keys, and Apple IAP credentials. Server-side FFmpeg and `yt-dlp` must be
on the host for the fallback render and soundtrack paths.

## Production

- Web/API deploy from `main` via GitHub Actions to the grepawk.com host,
  gated on build + smoke tests and a post-deploy tool-schema drift check.
- iOS ships via the `ios-testflight.yml` workflow (marketing version
  auto-resolved from App Store Connect) and the `asc-*` workflows under
  `.github/workflows/` for listing, What's New, and review submission.
- The iOS CI smoke set is five pure-logic suites by default; the full suite
  runs on manual dispatch.
