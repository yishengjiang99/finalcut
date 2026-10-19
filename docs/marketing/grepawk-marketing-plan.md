# FinalCap (grepawk.com): 4-week marketing plan for the web app
*Scope: the web app at grepawk.com only. The FinalCap iOS app (TestFlight build 19) is deliberately out of scope for this plan and its budget.*
*Prepared Oct 19, 2026 (PT). Data: live site and blog fetched today, plus nginx access logs for Oct 12–18 PT pulled read-only from the production nginx server (analysis in `/workspace/traffic/2026-10-19/`, scripts `mk.py`, `fun.py`). Every number below comes from those sources. Lines marked **Estimate** or **Assumption** are my judgment, not measurements.*

## 1. Where things stand (real data)
**Product as the site describes it:** "Edit video by describing it." You type an edit in chat and the Grok chat turns it into FFmpeg/wasm edits that run in the browser. The site lists 45 FFmpeg tools, "0 uploads needed to edit", 9:16 / 1:1 / 16:9 formats, and MP4 / WebM / MOV export. Captions are transcribed in the browser, or in the cloud with audio only if the user opts in. Translation runs on the server and burn-in is supported. The headline is "Free to try · No credit card." The web brand is **FinalCap**; the repo is still `finalcut`. The homepage says the iPhone app is "coming soon to the App Store" and gives **no TestFlight link**.

**Funnel, grepawk.com, Oct 12–18 PT (7 days):**
| Step | Count | Note |
|---|---|---|
| "Human-ish" visitors (browser UA, not a scanner IP, IP+UA) | 1,123 | Upper bound. Many are headless or bots that only fetch `/` |
| Visitors who loaded the app JS bundle | **68** | Best proxy for real browser visitors |
| Got a sample-video token (`/api/sample-access-token`) | 57 | Sample flow works. The `?start=sample` links were hit 50 times |
| Sent ≥1 chat edit (`/api/chat`, `/api/v2/chat` 200) | 32 | 31 IPs. Most come from 3 cloud/device IP ranges, so many are probably **test/QA traffic** (Assumption) |
| Used caption/translate APIs | 1 visitor; 2 streaming-caption token calls | The headline caption feature saw almost no real use |
| `start=signin` hits | 8 | |

Daily JS-loading visitors: 34 on Oct 12, then 14, 7, 3, 2, 5, 3. The Oct 12 spike faded within two days.

**Acquisition:** almost no external referrers were logged. t.co (X) sent 19 requests, which landed on the ffmpeg-threads, wasm-export, and filmcraft posts and on `/filmcraft/`. Forum referrals from xoxohth/autoadmit sent 13. Google sent 2, Bing 2, and Reddit, Product Hunt and HN sent 0. No UTM tags appeared in any request.
**Blog (236 unique visitors across /blog\*):** the top post is *How Music Reader recognizes sheet music* (50), followed by ProTune selfie (31), filmcraft wasm speedups (29) and ffmpeg wasm threads (21). *Bilingual captions w/ ElevenLabs* had 10, but it was only live for about one day. The creator landing pages got little traffic: /add-subtitles 15 pageviews, /add-lyrics-to-video 11, /translate-subtitles 9.
**Crawlers are active:** verified Googlebot made 124 hits, GPTBot 124, bingbot 30 and OAI-SearchBot 19. The sitemap lists 24 URLs. Indexing is happening, but search traffic isn't arriving yet.

**What this means:** the blog brings in **developers** through deep wasm/FFmpeg engineering posts. The people who would use FinalCap are **creators who need captions**, and they aren't reaching the site. The landing pages they would search for barely get traffic, and the caption feature itself shows about 1 real use.

## 2. Target users and positioning
- **Primary:** bilingual and Chinese-diaspora creators, plus language-learning creators, who need **EN↔中文 bilingual captions** burned into Shorts, Reels or TikTok clips. This is the strongest and least crowded angle FinalCap has.
- **Secondary:** privacy-minded or low-budget creators who want fast one-off edits (trim, 9:16, captions) without installing CapCut or paying $16–24/mo. Researched prices: CapCut Pro $19.99/mo; VEED $20/mo; Submagic $19/mo; Descript and Kapwing $24/mo, or $16/mo billed yearly (storycut.com comparison, Oct 3, 2026).
- **Tertiary, the existing audience:** web/wasm developers who read the blog. They are good for links, stars and launch upvotes, but they won't pay.

**Positioning statement:** *For creators who post in two languages, FinalCap is the browser video editor you talk to: type "add English + Chinese captions and make it vertical," and it's done in your browser without uploading your video. CapCut, VEED and Submagic make you upload and click through a timeline; FinalCap takes one sentence.*
Caution: "no upload, renders in browser" alone is **not unique**. OpenSubs, AutoSubtitles, SmileSub and Captioner all claim it. Lead with **chat-to-edit + bilingual captions**, and treat privacy as the supporting point.

## 3. The three highest-leverage channels
1. **Short demo videos (X, YouTube Shorts, and RedNote/Douyin if you're willing).** A 15–30 s screen recording: prompt typed → bilingual captions burned in → exported 9:16. X is the only channel already sending traffic (t.co, 19). Every clip links to a pre-filled `?start=sample&prompt=…` URL with UTM tags.
2. **Creator-intent SEO: re-aim the blog bot.** Switch the Social Media Expert bot from engineering deep-dives to how-to posts, at a ratio of about 2 how-tos to 1 engineering post. Target queries: "add Chinese English bilingual subtitles to video", "translate video subtitles to Chinese free", "burn subtitles into video online no upload", "make video vertical 9:16 online". Each post should embed a demo GIF and link to /translate-subtitles or /add-subtitles. Keep the engineering posts, but cross-post them to HN or r/webdev for links, since the dev audience is already there.
3. **One coordinated launch, week 3:** a Show HN post ("FFmpeg in wasm: 18 min → 10 s export, plus a chat video editor"), Product Hunt, and r/SideProject or r/webdev. Use the creator-friendly subs carefully, for example r/NewTubers, and follow their self-promo rules. FinalCap's most proven hook is the engineering story.
*(Free extra: cross-link FinalCap from the Music Reader and ProTune posts, which get the most blog traffic. See §5. iOS cross-promotion is out of scope here.)*

## 4. Four-week calendar (about 3–4 h/week owner time; bots draft; spend from §8)
| Week | Actions | Spend |
|---|---|---|
| **1 (Oct 19–25): fix the funnel** | Ship the §5 fixes: CTAs and deep links, mobile/desktop handoff, funnel events, UTM convention. Verify Google Search Console and Bing Webmaster for grepawk.com and submit the sitemap. Record 3 demo clips (bilingual captions, 9:16 reframe, "trim + 2x + saturate"). The bot drafts how-to #1: "Add bilingual English/Chinese captions to a video". Shortlist 5 nano creators (bilingual / language-learning / Chinese-diaspora, 1k–10k followers). | **$0** (no paid traffic until funnel events and UTMs are live) |
| **2 (Oct 26–Nov 1): seed content** | Post 1 clip every 2 days on X, linking to the deep URL with UTM. Publish how-to #1 and #2 ("Translate subtitles to Chinese free, no upload"), and add a short Chinese-language section to /translate-subtitles (Assumption: it may help ZH queries). Answer 3–5 existing Reddit/Quora questions about bilingual subtitles where it's genuinely relevant. Start the X promoted-video test and the Reddit $5/day probe. | **$95** (X $50, Reddit $35, credits $10) |
| **3 (Nov 2–8): launch** | Product Hunt launch on Tue/Wed, with Show HN the same week built on the 18 min → 10 s export story, and r/SideProject. Pin the best clip. Reply to every comment within the day. Run creator sponsorship #1. Point X spend at the launch post. | **$215** (X $60, Reddit $40, sponsor #1 $100, credits $15) |
| **4 (Nov 9–15): measure and double down** | Re-run `mk.py`/`fun.py`. Compare JS-loaders, sample starts, first edits and caption runs against the baseline in §1, and compare channels by UTM. Put next month's effort into whichever channel produced the most sessions with a caption run. The bot writes how-to #3 targeting the best-performing query in Search Console. Apply the §8 kill/scale rules. Run sponsor #2 only if #1 passes. | **$105** (X $40 if it passes, sponsor #2 $50, credits $15), reserve $85 held |

## 5. On-site conversion fixes (from the live site and logs)
1. **Lead with the bilingual-caption hero.** The homepage hero is generic ("trim, captions, color…"). Add a primary CTA, "Try bilingual captions on the sample →", linking to `/?start=sample&prompt=Generate English and Chinese captions`. Captions are the differentiator, but they had about 1 real use in 7 days.
2. **Deep-link the blog CTAs.** The bilingual-captions post's "Try FinalCap in your browser" goes to bare `/`. Point it to a sample URL with the bilingual prompt pre-filled and UTM tags. The engineering posts have no FinalCap CTA near the top, so add a one-line "Try it" box.
3. **Cross-link from the most-read posts.** The Music Reader (50) and ProTune (31) posts should carry a small "Also by GrepAwk: FinalCap, edit video by chat" card.
4. **Make mobile web work, or hand off to desktop.** 307 of 1,148 visitor IP+UAs were mobile. Make sure the sample flow works in mobile Safari and Chrome. Where it can't (large files, wasm limits), offer "email me a link to open on desktop". The homepage's iOS "coming soon" block currently gives web visitors nowhere to go. Consider swapping it for that handoff, at least while this plan runs.
5. **Explain the free limits.** The sitemap has no pricing or limits page. "Free to try" without stated limits makes visitors hesitate before they sign in. Add a short "What's free" section.
6. **Show the output.** Add a looping 5 s GIF/MP4 of a bilingual-captioned 9:16 clip above the fold.

## 6. Measurement
**Already in place:** nginx logs with `host=` plus the box scripts (bot verification by IP range). First-party `/api/telemetry` with install and session IDs that honors DNT/GPC: 150 events from 96 visitors in the 7 days. The main bundle only fires `cta_click`, `signup` and `upgrade`. There may also be a server `telemetry/funnels` report.
**Missing:** editor funnel events: `sample_started`, `file_opened`, `first_edit_sent`, `edit_succeeded`, `captions_generated`, `translate_run`, `export_downloaded`. None are in the main bundle; lazy chunks weren't checked. Also missing: UTM capture, Search Console, and a way to filter out internal/QA traffic (the iOS `contract-test` client and the 3 cloud IP ranges).
**Weekly KPIs:** real browser visitors (JS loaders; baseline 68/wk), sample starts (baseline 57), first chat edit (baseline 32, which includes QA), **caption runs (baseline about 1)**, exports, signups, and sessions per channel by UTM. **Assumption, not a forecast:** a reasonable 4-week target is doubling JS-loaders and reaching ≥10 caption runs/week from non-QA traffic.

## 7. Needs your approval or money
- Accounts and posts under your name: Product Hunt, Show HN, Reddit, X, and any RedNote/Douyin account. Bots draft, you post.
- Using AI or STT credits for demo renders. ElevenLabs streaming captions and Grok calls cost money per run. Optional: cap free caption minutes before the launch spike. **Assumption:** an HN or PH front page could bring hundreds to low thousands of visits in a day.
- The $500 budget in §8: approve the line items, ad-account setup on X and Reddit (card on file), and creator payments.
- Changing the blog bot's content brief toward creator how-tos.

## 8. Budget: $500 total, web app only
Every dollar points at grepawk.com, mostly at the bilingual-caption sample deep link, tagged with UTMs. The iOS app gets $0. **No money is spent until the week-1 funnel events and UTM capture are live.** Without them, none of the rules below can be applied.

| Line item | $ | Weeks | What it should buy (**Estimate**, with source) |
|---|---|---|---|
| X promoted video posts (15–30 s bilingual-caption demo). Target: followers of caption/creator-tool accounts, the keywords "bilingual subtitles", "中英字幕", "subtitles", "CapCut", and language-learning interests | 150 | W2 $50 · W3 $60 · W4 $40 | **75–300 link clicks** at $0.50–$2.00 CPC (WebFX/adcredits.expert 2026, avg ~$0.74; consumer audiences $0.30–$1.00 per autotweet.io). Note: those sources suggest $30–50/day for learning. This budget is a **small probe, not an optimized campaign**. |
| Reddit ads, traffic objective, on r/languagelearning, r/ChineseLanguage, r/NewTubers, r/VideoEditing, r/Chinese | 75 | W2 $35 · W3 $40 | **~50–375 clicks**: $0.20–$0.80 CPC for traffic campaigns (Stackmatix 2026). Reddit's own suggested bids for technical subs were ~$0.75–$1.56 (gtmhacker.ai, Oct 11, 2026). The $5/day floor is far below Reddit's recommended $50–100/day, so expect noisy data. |
| Creator micro-sponsorships: 1–2 nano creators (1k–10k followers) on TikTok, Shorts or RedNote who make bilingual or language-learning content. Ask for one video using FinalCap plus a link in the bio or description | 150 | W3 $100 · W4 $50 | **1–2 sponsored videos.** Nano rates are $50–$300 per post (AMT/Collabstr 2026) and $50–$250 per TikTok video (sponsorships.ai). Views and clicks per video are **unknown** (Assumption: low hundreds to a few thousand views). |
| AI and caption credits for demo/launch traffic (ElevenLabs realtime STT, Grok chat, translation) | 40 | W2 $10 · W3 $15 · W4 $15 | Split: $15 ElevenLabs plus $25 Grok/translation. ElevenLabs Scribe v2 Realtime is $0.39 per audio hour (elevenlabs.io/pricing/api), so $15 covers about 38 hours of caption audio. Grok and translation costs per run are **not measured**: get them from your provider bills in week 1. Treat the $25 as a placeholder. |
| Product Hunt launch assets (gallery images, 30 s video, thumbnail) | 0 | W1–W2 | Built in-house from the existing promo assets on this box (`/workspace/finalcap-promo/`) and screen recordings. Product Hunt is free to post on. |
| Tooling (analytics, Search Console, UTM builder) | 0 | W1 | First-party `/api/telemetry` plus nginx logs and the box scripts are enough. Search Console and Bing Webmaster are free. |
| **Reserve** | **85** | released only by a scale rule | If no rule triggers, it stays unspent. |
| **Total** | **500** | W1 $0 · W2 $95 · W3 $215 · W4 $105 · reserve $85 | |

**What "success" means per dollar.** Primary metric: **cost per caption run** from a UTM-tagged session. Secondary metric: cost per sample start. The baseline is roughly 1 caption run and 57 sample-token fetches per week, with zero paid traffic (§1). No published benchmark exists for this funnel, so the thresholds below are **Assumptions**, chosen so that $500 can't disappear on clicks that never start an edit.

**Kill/scale rules** (check every Monday with `mk.py`/`fun.py` plus telemetry):
- **Kill a paid channel** once it has spent $30 if any of these hold: CTR < 0.5%; cost per sample start > $5; or no caption runs from its UTM. Move its remaining money to the reserve.
- **Kill on bot traffic:** if more than half of a channel's UTM sessions never load the JS bundle, which is the bot signature seen in §1, pause it and treat the clicks as junk.
- **Scale:** if a channel shows cost per caption run ≤ $3 and ≥ 10 caption runs, move up to the $85 reserve into it in week 4. That's at most $40 per channel at a time, so X can't absorb everything.
- **Sponsorship gate:** pay sponsor #2 ($50) only if sponsor #1 produced ≥ 30 UTM sessions **or** ≥ 5 caption runs within 7 days. Otherwise the $50 goes to the reserve.
- **Credit cap:** if caption/AI spend passes $20 in any week, cap free caption minutes per session before buying more traffic.
- **Hard stop:** any spike in error rates (4xx/5xx on `/api/chat` or captions) pauses all paid traffic until it's fixed.
