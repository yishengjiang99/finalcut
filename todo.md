# TODO — FinalCap
_Last updated: 2026-09-26 PT by Chief of Staff_

## Now (in progress)
Build 10 work is on branch `feat/ios-native-build10` (`fd53fd4`), not on main yet.
- [ ] NativeToolExecutor on-device editing (AVMutableComposition, Core Image, CoreAnimation text, AVAudioMix); no uploads by default, cloud opt-in and off; photos edited on-device; unsupported tools → `unsupported_on_device` — iOS — `02c592e`, `f80c843` (wip)
- [ ] Background export (BGContinuedProcessingTask iOS 26+, beginBackgroundTask iOS 17–25) + local "Your video is ready" notification — iOS — `6500aa9` (wip)
- [ ] Mic dictation: addsPunctuation; auto-send 0.4s after punctuation / 1.0s silence / isFinal; keep listening; queue while processing — iOS — Design #94, #96
- [ ] On-device captions via `generate_captions` (SpeechAnalyzer iOS 26+, SFSpeechRecognizer older) — iOS — `c60585c` (wip)
- [ ] UA `FinalCap-iOS/<build>`, build number 10 — iOS — `aa49f1c`
- [ ] Hide free counter when server says unlimited — iOS — Design #95, `f80c843`
- [ ] Sample chips mapped to on-device tools — iOS — Design `0aa0a12`, `57e359a`
- [ ] Send `turnToken` on continuations (docs/api/CLIENT_TOOL_EXECUTION.md) — iOS — `fd53fd4` (wip)
- [ ] iOS Unit Tests green on the branch — iOS — runs 36267759062, 36267972112 failed; 36268126308 running

## Next
- [ ] Privacy update for client mode (docs/asc/PRIVACY_NUTRITION.md, public/legal/privacy.html): draft is on the branch (`57e359a`); must be reviewed before any App Store submit — Chief of Staff
- [ ] Merge build 10 to main and cut TestFlight build 10 — iOS
- [ ] Keep `translate_captions` and `burn_subtitles` off the iOS allowlist — Backend

## Blocked / waiting on user
- [ ] TestFlight testing of build 10 once it's ready — User

## Done (recent)
- [x] Client-mode chat charged once per edit turn via signed `turnToken`; prod grepawk.com deployed 1:07 PM PT, /api/health 200, commit `f3483e4` — `f3483e4` — 2026-09-26
- [x] Daily limit enforced atomically (INSERT IGNORE + conditional UPDATE) — `dee7838` — 2026-09-26
- [x] `generate_captions` allowlisted for build 10+, iOS copy without translation (21 tools at build 10) — `2bdd104` — 2026-09-26
- [x] Server tool allowlist by UA: `FinalCap-iOS/10` gets 20 (21 after `2bdd104`); a FinalCap-iOS UA with build <10 or no build gets 0; every other UA gets all 46 (web, and build 9, which sends the default `FinalCap/<build> CFNetwork` UA) — `54b4e43` — 2026-09-26
- [x] `FREE_EDITS_IOS=unlimited` turns off the iOS free limit (still counted) — `4b9fb62` — 2026-09-26
- [x] One-row ~44pt top bar, Upgrade capsule never wraps, layout tests at 375pt (on main, ships in build 10) — `0f89013` — 2026-09-26
- [x] `audio_fade` optional `start` defaulted and validated (fixes web audio_fade) — #92 `5922c44` — 2026-09-26
- [x] Health reports deployed commit from REVISION file — #91 `7cfc2a9` — 2026-09-26
- [x] `GET /api/health` + photo pipeline verified on FFmpeg 4.4 — #89 `2461df0` — 2026-09-26
- [x] Machine-readable error codes for photo rejections — #88 `771b91b` — 2026-09-26
- [x] TestFlight build 9: crash fixes (free text → server tool calls, real MIME types) — `8684c47`, `98444d5` — 2026-09-26
