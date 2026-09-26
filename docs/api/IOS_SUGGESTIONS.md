# iOS suggestion pills: `GET /api/ios/suggestions`

These are server-driven suggestion pills for the FinalCap iOS app. The endpoint needs no auth
(it works before login), uses no session or database, and has its own per-IP rate limiter
(120 requests per 15 min).

```
GET /api/ios/suggestions?build=<n>&media=video|photo
```

```json
{"suggestions":[{"id":"v-trim-15","label":"Trim to 15s","prompt":"Trim the video to the first 15 seconds.","icon":"scissors"}],"ttl":3600}
```

- The response carries `Cache-Control: public, max-age=<ttl>`.
- `icon` is an SF Symbol name. It is left out when the entry has none.
- Pills come back in config order, and the app shows them in that order.
- `media` defaults to `video` when it is missing or invalid.
- A missing or non-numeric `build` is treated as **10**, the smallest on-device tool set.

## Config

The repo default is `config/ios-suggestions.json`:

```json
{
  "ttl": 3600,
  "video": [ { "id": "v-trim-15", "label": "Trim to 15s", "prompt": "Trim the video to the first 15 seconds.", "icon": "scissors", "tools": ["trim_video"] } ],
  "photo": [ { "id": "p-bw", "label": "Black and white", "prompt": "Make the photo black and white.", "icon": "circle.lefthalf.filled", "tools": ["apply_color_filter"], "minBuild": 10 } ]
}
```

- **Media:** which array an entry is in (`video` or `photo`) decides its media. The older shape,
  `{ "suggestions": [ { ..., "media": ["video", "photo"] } ] }`, is also accepted.
- **Required fields:**
  - `id`: non-empty and unique within its media.
  - `label`: non-empty, at most 24 characters.
  - `prompt`: non-empty, at most 500 characters.
  - `tools`: a non-empty list of known tool names. These are the `src/tools.js` tools plus the
    iOS-only grouped tools, such as `color_adjust`.
- **Optional fields:** `icon`, and `minBuild` / `maxBuild` (both inclusive).
- **`ttl`:** an integer from 0 to 86400. The default is 3600.
- **Internal fields:** `tools`, `media`, `minBuild` and `maxBuild` are never sent to the app.
- **Invalid entries** are skipped, and the server logs a warning.

## Filtering

A pill is returned only when all of these hold:

1. It is in the requested media's list.
2. `build` is within its optional `minBuild` / `maxBuild`.
3. **At least one** of its `tools` is offered to `FinalCap-iOS/<build>` for that media.

Rule 3 uses the same allowlist as `/api/chat` and `/api/tools/schema`
(`src/server/iosToolAllowlist.js`: `minBuild`/`maxBuild`, `GROUPED_EFFECTS_MIN_BUILD`, and
photo/video media types). For example, `["adjust_brightness", "color_adjust"]` keeps showing after
the `adjust_*` tools retire at the grouped-effects cutoff. A video-only tool never shows a pill for
photos. Builds with no on-device tools (9 and below) get an empty list.

## Live override on prod: `IOS_SUGGESTIONS_PATH`

Deploys `rsync --delete` into `/home/finalcut/apps/pages/finalcut`, keeping only `.env*`. So a
config edited inside the app dir is wiped. Keep the live copy outside it:

1. Create the file:
   `sudo -u finalcut mkdir -p /home/finalcut/config && sudo -u finalcut cp /home/finalcut/apps/pages/finalcut/config/ios-suggestions.json /home/finalcut/config/ios-suggestions.json`
2. Add `IOS_SUGGESTIONS_PATH=/home/finalcut/config/ios-suggestions.json` to the app `.env`, then
   run `sudo systemctl restart finalcut`. This restart is needed once, to load the env var.
3. After that, edit the file in place. No restart is needed: the server checks the file's mtime at
   most every 5 s, and clients pick up the change when their `ttl` cache expires. The service user
   `finalcut` must be able to read the file.

If the override is missing, isn't valid JSON, has the wrong shape, or has no valid entries, the
server logs a warning and serves the repo default. It never returns a 500. There is no admin UI or
API for this. Edit the file directly.
