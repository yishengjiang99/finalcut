# First-party telemetry (web)

- Endpoint: `POST /api/telemetry` (src/server/telemetry.js). Same-site, cookieless, no IP stored,
  no prompt text and no media. Body ≤ 2 KB; 60 requests/min per client IP (counted in memory only).
  Responses: 204 stored, 202 `{stored:false}` if the DB is down, 400 invalid, 413 too large, 429 rate-limited.
- Client: src/telemetry.js (`navigator.sendBeacon`, fetch fallback). Random install id in localStorage
  `finalcap.telemetry.install` and a per-tab session id in sessionStorage. Off when the browser sends
  Global Privacy Control or Do Not Track.
- Table: `finalcut_telemetry_events` in the app database (docs/migrations/finalcut_telemetry_events.sql;
  created automatically on first event). Rows older than 395 days (13 months) are deleted daily.
- Events: landing_view, cta_click, video_loaded, first_prompt, tool_executed, upload_consent, export,
  signup, upgrade, app_store_click (reserved for when the App Store link goes live).
  Allowed props are listed in `PROP_RULES` in src/server/telemetry.js. Anything else is dropped.

## Summary endpoint (optional)
Set `TELEMETRY_READ_KEY` in the server `.env` and restart. Then:
```
curl -H "X-Telemetry-Read-Key: $KEY" "https://grepawk.com/api/telemetry/summary?days=7"
```
While the variable is unset the endpoint returns 404.

## SQL (on the server: `mysql finalcut`)
```sql
-- Events and unique installs per event, last 7 days
SELECT event, COUNT(*) events, COUNT(DISTINCT anon_id) installs
FROM finalcut_telemetry_events WHERE created_at >= NOW() - INTERVAL 7 DAY
GROUP BY event ORDER BY events DESC;

-- Daily funnel: landing -> CTA -> video loaded -> first prompt -> export (unique installs)
SELECT DATE(created_at) day,
  COUNT(DISTINCT IF(event='landing_view', anon_id, NULL)) landing,
  COUNT(DISTINCT IF(event='cta_click',    anon_id, NULL)) cta,
  COUNT(DISTINCT IF(event='video_loaded', anon_id, NULL)) loaded,
  COUNT(DISTINCT IF(event='first_prompt', anon_id, NULL)) prompted,
  COUNT(DISTINCT IF(event='export',       anon_id, NULL)) exported
FROM finalcut_telemetry_events WHERE created_at >= NOW() - INTERVAL 30 DAY
GROUP BY day ORDER BY day;

-- Acquisition: referrer host and UTM source of landing views
SELECT JSON_UNQUOTE(props_json->'$.ref') ref, JSON_UNQUOTE(props_json->'$.utm_source') utm_source,
       COUNT(DISTINCT anon_id) installs
FROM finalcut_telemetry_events
WHERE event='landing_view' AND created_at >= NOW() - INTERVAL 30 DAY
GROUP BY ref, utm_source ORDER BY installs DESC LIMIT 30;

-- Tool reliability: success rate and engine per tool
SELECT JSON_UNQUOTE(props_json->'$.tool') tool, JSON_UNQUOTE(props_json->'$.engine') engine,
       COUNT(*) runs, ROUND(AVG(JSON_EXTRACT(props_json,'$.ok')=true)*100,1) ok_pct
FROM finalcut_telemetry_events
WHERE event='tool_executed' AND created_at >= NOW() - INTERVAL 7 DAY
GROUP BY tool, engine ORDER BY runs DESC;

-- Upload-consent answers (cloud features)
SELECT JSON_UNQUOTE(props_json->'$.allowed') allowed, COUNT(*) n
FROM finalcut_telemetry_events WHERE event='upload_consent' GROUP BY allowed;
```

## Deploy smoke
Every deploy POSTs one `landing_view` with `anon_id = deploy-smoke-<run id>`, confirms the row on the
server and deletes it (scripts/telemetry-smoke-cleanup.mjs), so those rows never stay in the table.
