# FinalCut iOS — v1 UX Handoff

**Audience:** FinalCut iOS (SwiftUI scaffold)  
**Status:** Design handoff for MVP scaffolding  
**MVP loop:** Import → Chat edit → Export  
**Out of scope:** Feature parity with web, on-device FFmpeg, Photo Recipes camera chrome

---

## Constraints (engineering)

| Topic | v1 decision |
|---|---|
| Heavy edits | Existing Node/FFmpeg API (grepawk.com) — no on-device FFmpeg |
| Preview / scrub | Local AVKit / AVFoundation only |
| Timeline | Stub only (single clip scrubber under preview) — not multi-track |
| Auth | `SignIn` stub only — no Google / Apple in this slice |
| Paywall | StoreKit IAP (buy/restore) — not web Stripe Checkout |
| First tools | Trim, text overlay, transitions, audio filters, Grok chat tools |

---

## Screen names (canonical)

Use these identifiers in navigation and file names:

1. `Landing`
2. `SignIn` — stub (no Google)
3. `Paywall` — StoreKit IAP (buy/restore placeholders)
4. `Editor` — single root (not a tab bar)
5. `ExportSheet`

**Recommended first scaffold slice:** `Editor` empty → import → ready (defer Landing / SignIn / Paywall until Editor loop works).

---

## Navigation

> **Launch path (Sept 2026):** the app opens directly into `Editor` (empty state = chat + import-from-Photos panel). `Landing` / `SignIn` were removed; `Paywall` is a sheet shown from the top-bar **Upgrade** button or when the server reports the free limit (402 `code: "paywall"` / 429 `daily_limit_reached`). Import uses `PhotosPicker` (videos only), not Files.

```
Editor (launch)
  ├─ Paywall (sheet: Upgrade tap or usage limit)
  └─ ExportSheet (modal)
```

Sample / demo path may enter `Editor` without paywall (match web “Try with Sample Video”).

---

## Editor layout (phone, portrait)

Dark editor chrome. Quiet, near-black canvas. Chat is the edit surface — **not** a camera app, **not** CapCut multi-track chrome, **not** Photo Recipes.

```
┌─────────────────────────────┐
│  Import              Export │  TopBar
├─────────────────────────────┤
│                             │
│        VideoPreview         │  ~40% height, letterboxed
│        (AVKit player)       │
├─────────────────────────────┤
│  ──●──────────── scrub ───  │  TimelineStub (single clip)
├─────────────────────────────┤
│  ChatScroll                 │  flex
│  · assistant / user bubbles │
│  · inline result thumbnails │
├─────────────────────────────┤
│  [chip] [chip] [chip] …     │  SampleChips (optional)
├─────────────────────────────┤
│  [+]   Composer      [Send] │  + = Photos / Files picker
└─────────────────────────────┘
```

### Regions

| Region | Role |
|---|---|
| `TopBar` | Import (leading), Export (trailing, enabled when a clip exists) |
| `VideoPreview` | AVKit playback of current original or last processed clip |
| `TimelineStub` | Single-clip playhead / scrub only — no multi-track UI in v1 |
| `ChatScroll` | Message history; processed results appear as assistant bubbles with thumbs |
| `SampleChips` | After import: quick prompts (resize, trim, captions, brightness…) |
| `Composer` | Text field + Send; `+` opens import |

---

## Editor states

| State | UI behavior |
|---|---|
| `empty` | Placeholder in preview (“Import a video”); composer disabled or Import-focused |
| `uploading` | Chat status line; disable Send |
| `ready` | Preview live; SampleChips visible; composer enabled |
| `processing` | Dimmer + spinner over preview; disable Send |
| `failed` | Inline error bubble in chat; user can re-send |

---

## Flows

### Import
1. Tap Import (TopBar) or `+` in Composer  
2. Photos / Files → pick video (audio optional later)  
3. Show uploading state in chat  
4. Set preview to local asset URL  
5. Enter `ready`

### Chat edit
1. User types natural-language edit (or taps a SampleChip)  
2. Append user bubble → `processing` (dimmer stays up)  
3. `POST /api/jobs/process-video` (multipart) → `{ jobId }`  
4. Poll `GET /api/jobs/:id` while status is `queued` or `running`  
5. On `succeeded`: assistant bubble + result thumb from absolute `resultUrl` on `https://grepawk.com`; swap preview → `ready`  
6. On `failed`: error bubble → `failed`

### Export
1. Tap Export → present `ExportSheet`  
2. Share / Save to Photos / Files  
3. Source = current preview asset (last processed, else original)

---

## Visual system (v1 tokens)

Darkroom-adjacent (aligned with web `#0d1117` family):

- Canvas / background: near-black
- Surfaces (bubbles, chips, bars): slightly lifted dark gray
- Borders: low-contrast hairlines
- Text: high-contrast primary; muted secondary
- Accent: restrained (one accent for Send / primary CTA only)
- Preview: letterboxed; never stretch

**Do not** reuse Photo Recipes camera chrome, shutter controls, or recipe-card aesthetics.

---

## Sample chips (seed set)

Match web quick commands where useful:

- Resize to 1280×720  
- Trim (keep seconds 5–15)  
- Add text overlay  
- Generate captions  
- 2× speed  
- Brightness +0.3  
- Volume 150%  
- 9:16 for Instagram  

---

## Stub checklist for `ios/` scaffold

- [ ] `EditorView` with regions above  
- [ ] `VideoPreview` + `TimelineStub` scrub wired to AVPlayer  
- [ ] `ChatScroll` + `Composer` (local mock messages OK)  
- [ ] Import → local preview (no API yet)  
- [ ] Processing overlay state (mock delay OK)  
- [ ] `ExportSheet` sharing current local URL  
- [ ] Placeholder `Landing` / `SignIn` / `Paywall` routes (optional this slice)

---

## Locked product decisions

1. **Paywall** = StoreKit IAP (not Stripe web)  
2. **SignIn** = stub / no Google for this scaffold  
3. Sample-video / DEBUG path may use sample-access-token (Backend #47) without full auth

Still open later: Sign in with Apple vs Google for production identity; StoreKit product SKUs.  

---

*Handoff owner: FinalCut Design · Coordinate in FinalCut channel*