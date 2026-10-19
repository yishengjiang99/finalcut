# Server-side ad conversions (X Ads + Reddit Ads)

grepawk.com does **not** load the X or Reddit pixel scripts (the app serves `Cross-Origin-Embedder-Policy: require-corp` for ffmpeg wasm, and we avoid third-party scripts). Instead, the first-party telemetry endpoint `POST /api/telemetry` forwards selected funnel events to each platform's **Conversions API** from the server (`src/server/adConversions.js`).

- **Off by default.** With the env vars unset, nothing is sent and nothing is logged.
- **Never blocks.** Forwarding is fire-and-forget with a 3 s timeout; failures are logged at most once per minute per provider (`[ad-conversions] x failed: HTTP 401`).
- **Skips** bots/headless browsers (user-agent match), requests with an `X-Finalcut-Test` header, `anon_id` starting with `test-`, `utm_source=test` / `utm_medium=test`, iOS-app events, and GPC/DNT browsers (the client sends nothing).
- **Dedupe:** each event has a stable id = SHA-256(install id, session id, event, step), sent as X `conversion_id` and Reddit `metadata.conversion_id`.
- **Privacy:** the browser keeps `twclid`, `rdt_cid` and `utm_*` from the landing URL in first-party `localStorage` for 28 days and attaches them to telemetry events. The server forwards click ids to the matching platform and **strips them before storing** the event. Each platform receives events only for visitors who arrived from that platform's ad click (Reddit requires `rdt_cid`, X requires `twclid`), along with the request IP and user agent (in memory only, not stored). No email or other PII is sent. `hashEmail()` (trim + lowercase + SHA-256, per both specs) exists if that is ever added. ⚠️ Update `public/legal/privacy.html` to mention ad-platform conversion sharing before enabling.

## Environment variables

| Var | Required | Value |
| --- | --- | --- |
| `X_ADS_PIXEL_ID` | X | X Pixel (event source) id, e.g. `oka17` |
| `X_ADS_EVENT_IDS` | X | JSON map telemetry event → X event id, e.g. `{"signup":"tw-oka17-ol288","upgrade":"tw-oka17-ol289"}` |
| `X_ADS_CONSUMER_KEY` | X | Developer app API Key |
| `X_ADS_CONSUMER_SECRET` | X | Developer app API Key Secret |
| `X_ADS_ACCESS_TOKEN` | X | User access token (user must be AD_MANAGER or ACCOUNT_ADMIN on the ad account) |
| `X_ADS_ACCESS_TOKEN_SECRET` | X | User access token secret |
| `REDDIT_ADS_PIXEL_ID` | Reddit | Reddit Pixel ID from Events Manager (e.g. `t2_abc123` / `a2_…`) |
| `REDDIT_ADS_ACCESS_TOKEN` | Reddit | Conversion access token |
| `REDDIT_ADS_TEST_ID` | optional | Test ID from Reddit Event Testing; when set, events are validated but **not** counted. Remove after testing. |
| `REDDIT_ADS_EVENTS` | optional | JSON map event → tracking type, overrides the default mapping below |

X is enabled only when **all six** X vars are set; Reddit only when pixel id + token are set.

> Note vs. the original brief: Reddit marks `/api/v2.0/conversions/events/{id}` and `test_mode` as deprecated; this uses **CAPI v3** (`/api/v3/pixels/{pixel_id}/conversion_events`, `test_id`), so the variable is a Pixel ID (not ad account id) and test mode is `REDDIT_ADS_TEST_ID`.

## Event mapping

| Telemetry event | Fired when | Reddit (default) | X |
| --- | --- | --- | --- |
| `landing_view` | landing page shown | `PAGE_VISIT` | if mapped |
| `signup` | returned from Google sign-in | `SIGN_UP` | if mapped |
| `upgrade` (`step: paid`) | Stripe checkout confirmed | `PURCHASE` (only `step=paid`) | if mapped |
| `sample_start` | sample video starts loading | `CUSTOM` "sample_start" | if mapped |
| `first_edit` | first successful chat edit (tool) | `CUSTOM` "first_edit" | if mapped |
| `captions_start` | first caption generation | `CUSTOM` "captions_start" | if mapped |
| `translate` | first translated captions | `CUSTOM` "translate" | if mapped |
| `export_done` | export/download | `CUSTOM` "export_done" | if mapped |

X is sent only for events in `X_ADS_EVENT_IDS` **and** only when a `twclid` is present (X requires a click id or hashed email/phone; IP + UA alone don't match).

Recommended X mapping: `signup` → a "Sign up" event, `upgrade` → "Purchase", `first_edit` or `export_done` → a "Custom" event (one X event per mapped telemetry event).

## Step-by-step: X Ads

1. **Ads account.** Go to <https://ads.x.com>, sign in with the company X handle, and finish account setup (country, currency, payment method).
2. **Event source (pixel).** In Ads Manager open **Tools → Events Manager**. If there is no "X Pixel" in the left sidebar, click **Add event source** (top right). The id shown for the X Pixel event source is your **Pixel ID** → `X_ADS_PIXEL_ID`.
3. **Conversion events.** In Events Manager, select the pixel and **Add events**. For each event (e.g. Sign up, Purchase, Custom "first edit"): give it a name, pick the type, choose **Install with Conversion API** as the setup method ⚠️ (wording not verified), save. Copy the **Event ID** shown for each event, and build `X_ADS_EVENT_IDS`, e.g. `{"signup":"<signup event id>","upgrade":"<purchase event id>"}`.
4. **Developer account + app.** At <https://developer.x.com> create a developer account (X recommends the company handle and 2FA) and a Project/App. Note the **App ID** (Developer Console → Projects & Apps).
5. **Ads API access.** Submit the **Ads API Access Form** (linked from the Ads API Getting Started guide) with that App ID. Wait for approval; Conversions API calls fail with 401/403 until then.
6. **Keys.** In the app's **Keys and tokens** tab: copy **API Key** → `X_ADS_CONSUMER_KEY`, **API Key Secret** → `X_ADS_CONSUMER_SECRET`. Set the app permissions to **Read and write** before generating tokens ⚠️ (not verified as required).
7. **Access token.** In the same tab generate **Access Token and Secret** for the handle that owns the app → `X_ADS_ACCESS_TOKEN`, `X_ADS_ACCESS_TOKEN_SECRET`. That handle must have **AD_MANAGER** or **ACCOUNT_ADMIN** access on the ad account (Ads Manager → account menu → Edit access to account). Tokens for other handles need 3-legged OAuth (e.g. `twurl`).
8. **Add to prod** — see "Deploying the env vars" below.
9. **Test.** Open `https://grepawk.com/?twclid=test-click-1&utm_source=x` in a normal browser (GPC/DNT off), click **Try sample**, sign in. Within ~30 min the events should appear under Events Manager → your pixel → event **Activity** / last-received ⚠️ (X has no dedicated test mode; a fake twclid may not attribute but should register as received — not verified). For a real check, click one of your own live ads.
10. **Click ids on ads.** X appends `twclid` to destination URLs automatically when click-ID tracking is enabled for the pixel/event source ⚠️ (setting name/location not verified; check the event source settings in Events Manager). Just use plain `https://grepawk.com/` as the ad URL; add `utm_source=x&utm_medium=paid&utm_campaign=<name>` if you want UTMs.

Sources: X Conversion API guide <https://docs.x.com/x-ads-api/measurement/web-conversions/conversion-api> (mirror: <https://x-preview.mintlify.app/x-ads-api/measurement/web-conversions>), Ads API getting started <https://docs.x.com/x-ads-api/getting-started-guide>, OAuth 1.0a <https://docs.x.com/resources/fundamentals/authentication/oauth-1-0a/creating-a-signature>.

## Step-by-step: Reddit Ads

1. **Ads account.** Sign up at <https://ads.reddit.com> and create a business + ad account (you must be an admin).
2. **Pixel ID.** Open **Events Manager** → **Configure data source** → **Conversions API** → **Set up manually** (first time: **Conversions API Only**). Click **Copy to Clipboard** for the **Pixel ID** → `REDDIT_ADS_PIXEL_ID`.
3. **Conversion access token.** Events Manager → **Conversions API** in the sidebar → **Generate Access Token** → name it (e.g. "grepawk server") → **Generate** → **Copy to Clipboard & Close** → `REDDIT_ADS_ACCESS_TOKEN`. It is shown once and doesn't expire; you can have 5 and delete one to revoke.
4. **Events.** Nothing to pre-create: standard events (`PAGE_VISIT`, `SIGN_UP`, `PURCHASE`) and custom events (`sample_start`, `first_edit`, …) appear in Events Manager the first time they arrive. Only the 20 most recent custom event names are shown. Optionally override the mapping with `REDDIT_ADS_EVENTS`, e.g. `{"signup":"SIGN_UP","upgrade":"PURCHASE","export_done":"LEAD"}`.
5. **Test ID.** Ads Manager → **Event Testing** → copy the **Test ID** → `REDDIT_ADS_TEST_ID`.
6. **Add to prod** — see below.
7. **Test.** Visit `https://grepawk.com/?rdt_cid=test123&utm_source=reddit`, click **Try sample**, make an edit. In **Event Testing** the events should appear within seconds (rate limit 10/s, one event per request is shown) with match keys and `conversion_id`. Then **remove `REDDIT_ADS_TEST_ID`** and restart; events are counted from then on.
8. **Click ids on ads.** Reddit appends `rdt_cid` to ad click URLs automatically ⚠️ (I couldn't confirm whether any account setting is required; if your landing URLs don't show `rdt_cid` after a test click, check the ad account / pixel settings for click-ID / "attribution" options). Use plain `https://grepawk.com/` as the destination plus optional UTMs.

Sources: Direct Integration <https://ads-api.reddit.com/docs/v3/guides/programs/capi/direct-integration>, Post Conversion Events (v3) <https://ads-api.reddit.com/docs/v3/api/post-conversion-events>, v2→v3 migration <https://ads-api-reddit.netlify.app/docs/v3/guides/programs/capi/migration>, Conversion access token <https://business.reddithelp.com/s/article/conversion-access-token>, Verify events <https://ads-api-reddit.netlify.app/docs/v3/guides/programs/capi/verify-events>.

## Deploying the env vars

```bash
ssh root@64.23.239.208
nano /home/finalcut/apps/pages/finalcut/.env      # append the vars below
systemctl restart finalcut && systemctl status finalcut --no-pager
journalctl -u finalcut -f | grep ad-conversions   # failures show here (max 1/min/provider)
```

```
X_ADS_PIXEL_ID=
X_ADS_EVENT_IDS={"signup":"...","upgrade":"..."}
X_ADS_CONSUMER_KEY=
X_ADS_CONSUMER_SECRET=
X_ADS_ACCESS_TOKEN=
X_ADS_ACCESS_TOKEN_SECRET=
REDDIT_ADS_PIXEL_ID=
REDDIT_ADS_ACCESS_TOKEN=
REDDIT_ADS_TEST_ID=
```

The unit loads this file via systemd `EnvironmentFile=` (`finalcut.service`); write JSON values unquoted on one line as shown.

## Payloads sent

X: `POST https://ads-api.x.com/12/measurement/conversions/{X_ADS_PIXEL_ID}`, OAuth 1.0a HMAC-SHA1 header, body
`{"conversions":[{"conversion_time":"<ISO>","event_id":"<X event id>","identifiers":[{"twclid":"…"},{"ip_address":"…","user_agent":"…"}],"conversion_id":"<stable id>"}]}`

Reddit: `POST https://ads-api.reddit.com/api/v3/pixels/{REDDIT_ADS_PIXEL_ID}/conversion_events`, `Authorization: Bearer …`, body
`{"data":{"test_id":"…?","events":[{"event_at":<epoch ms>,"action_source":"WEBSITE","type":{"tracking_type":"SIGN_UP"},"click_id":"…","metadata":{"conversion_id":"<stable id>"},"user":{"ip_address":"…","user_agent":"…"}}]}}`
